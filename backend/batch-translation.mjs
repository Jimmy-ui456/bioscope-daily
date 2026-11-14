import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isValidPaper, isRetracted, beijingDay, validPublicationDate } from '../dist/core.js';
import { attachEnrichment, translationOf, translationVersionKey, sourceFingerprint } from '../dist/enrichment.js';
import { interpretPaper, validateInterpretation, modelFailureDetails, modelInputTokenUpperBound, PROMPT_VERSION, LEGACY_PROMPT_VERSIONS, TERMINOLOGY_VERSION } from './interpret.mjs';
import { validateModelUsage } from './model-cost.mjs';
import { validateTranslationTask, translationBudget, approveTranslationRequest, translationReceiptUsage } from './translation-task.mjs';
import { acquirePipelineLock } from './lock.mjs';
import { PROJECT, readJson, saveJson, modelConfig, configuredModel, requestKey } from './pipeline.mjs';

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nowAt(clock) { const now = new Date(clock()); if (!Number.isFinite(now.getTime())) throw new Error('批量翻译时钟无效'); return now; }
function existingReceipt(paper, configuration, receipts) {
  return [PROMPT_VERSION, ...LEGACY_PROMPT_VERSIONS].some(version => Boolean(receipts[requestKey(paper, configuration, version)]));
}
function validDailyUsage(usage, date) {
  return record(usage) && validPublicationDate(usage.date) && usage.date <= date && Number.isSafeInteger(usage.requests) && usage.requests >= 0;
}
function checkedResult(result, paper, configuration) {
  if (!record(result) || result.origin !== 'model' || result.promptVersion !== PROMPT_VERSION
    || result.sourceTitle !== paper.title || result.sourceAbstract !== paper.abstract || result.sourceFingerprint !== sourceFingerprint(paper)) {
    throw new Error('模型结果未通过完整原文绑定');
  }
  const usage = validateModelUsage(result.modelUsage);
  const translationOnly = result.analysisStatus === 'translation_only';
  if (translationOnly && (result.question != null || result.methods != null || result.findings != null || !Array.isArray(result.limitations) || result.limitations.length)) throw new Error('仅译文结果不能包含未审查论述');
  return { ...validateInterpretation(result, paper), sourceTitle: paper.title, sourceAbstract: paper.abstract,
    sourceFingerprint: sourceFingerprint(paper), origin: 'model', model: configuration.model, promptVersion: PROMPT_VERSION,
    createdAt: result.createdAt, reviewed: false, scope: 'abstract_only', ...(usage ? { modelUsage: usage } : {}),
    ...(result.terminologyVersion === TERMINOLOGY_VERSION ? { terminologyVersion: TERMINOLOGY_VERSION } : {}),
    ...(translationOnly ? { analysisStatus: 'translation_only', ...(['invalid_evidence', 'invalid_shape'].includes(result.analysisFailureCode) ? { analysisFailureCode: result.analysisFailureCode } : {}) } : {}) };
}
function catalogIdentity(key) { return key.startsWith('version:') ? key.slice(8, key.lastIndexOf(':')) : key; }
function updateModelCatalog(library, catalog) {
  const items = { ...catalog.items }, ids = new Set(Object.keys(items).map(catalogIdentity));
  let paperCount = catalog.paperCount;
  for (const paper of library.papers) {
    const translated = translationOf(paper);
    if (translated?.origin !== 'model' || translated.sourceTitle !== paper.title || translated.sourceAbstract !== paper.abstract) continue;
    const key = translationVersionKey(paper, paper.id);
    if (Object.hasOwn(items, key)) continue; // Preserve every pre-existing source version.
    items[key] = translated;
    const aliases = [paper.id, paper.doi && `doi:${paper.doi.toLowerCase()}`, paper.pmid && `pmid:${paper.pmid}`].filter(Boolean);
    if (!aliases.some(id => ids.has(id))) paperCount++;
    ids.add(paper.id);
  }
  return { ...catalog, items, paperCount, sourceVersionCount: Object.keys(items).length };
}

// Explicit task execution only: importing this module never loads .env or starts
// collection/model requests. The caller supplies an authorized model environment.
export async function runBatchTranslation({ root = PROJECT, env = process.env, clock = () => new Date(), interpret = interpretPaper,
  inputTokenUpperBound = modelInputTokenUpperBound, save = saveJson } = {}) {
  const configuration = modelConfig(env);
  if (!configuredModel(configuration)) throw new Error('批量翻译缺少完整模型配置，未调用模型');
  await mkdir(path.join(root, '.data'), { recursive: true });
  const lock = await acquirePipelineLock(path.join(root, '.data/pipeline.lock'));
  try {
    const task = validateTranslationTask(await readJson(path.join(root, 'config/translation-task.json'), null));
    const started = nowAt(clock), date = beijingDay(started);
    const library = await readJson(path.join(root, 'dist/library.json'), null);
    let catalog = await readJson(path.join(root, 'dist/translations.json'), null);
    if (!record(library) || !Array.isArray(library.papers) || library.papers.length > 500
      || !library.papers.every(p => isValidPaper(p) && p.id.trim() && p.title.trim()) || !record(library.receipts)) throw new Error('批量文献库或回执结构无效，未调用模型');
    if (!validDailyUsage(library.modelUsage, date)) throw new Error('既有日请求预算无效，未调用模型');
    if (!record(catalog) || !record(catalog.items) || !Number.isSafeInteger(catalog.paperCount) || catalog.paperCount < 0) throw new Error('译文目录结构无效，未调用模型');
    library.papers = library.papers.map(p => attachEnrichment(p, catalog.items));
    const receipts = library.receipts;
    translationBudget(task, receipts, configuration); // Reject malformed task receipts before any writes.
    const validation = task.validationReceiptKey && receipts[task.validationReceiptKey];
    const proof = validation?.status === 'completed' && validation.taskId === task.taskId && library.papers.some(p => {
      const translated = translationOf(p);
      if (translated?.origin !== 'model' || translated.promptVersion !== PROMPT_VERSION || requestKey(p, configuration) !== task.validationReceiptKey) return false;
      try { validateInterpretation(translated, p); return translated.sourceTitle === p.title && translated.sourceAbstract === p.abstract; } catch { return false; }
    });
    if (!proof) throw new Error('尚无本任务当前证据协议的真实成功回执与同源模型译文，未启动批量翻译');

    // A prior crash may have persisted a successful receipt before its catalog.
    // Recover that catalog first without repeating the already-completed request.
    catalog = updateModelCatalog(library, catalog);
    await save(path.join(root, 'dist/translations.json'), catalog);
    const candidates = library.papers.filter(p => !translationOf(p) && p.abstract.trim() && !isRetracted(p));
    let cursor = 0, attempts = 0, passed = 0, failed = 0, translationOnlyPassed = 0, consecutiveFailures = 0, stopReason = null, fatal = null;
    const inputTooLarge = new Set();
    let queue = Promise.resolve();
    const serial = action => {
      const operation = queue.then(async () => { if (fatal) throw fatal; return action(); });
      queue = operation.catch(error => { fatal ||= error; });
      return operation;
    };
    const libraryPath = path.join(root, 'dist/library.json');
    function batchMetadata(completedAt) {
      return { taskId: task.taskId, startedAt: started.toISOString(), attempts, passed, failed, translationOnlyPassed,
        ...(completedAt ? { completedAt } : {}), actualBill: false };
    }
    async function reserveNext() {
      if (stopReason || fatal) return null;
      while (cursor < candidates.length) {
        const paper = candidates[cursor++];
        if (existingReceipt(paper, configuration, receipts)) continue;
        const now = nowAt(clock);
        const approval = approveTranslationRequest({ task, receipts, configuration, now, inputUpperBound: inputTokenUpperBound(paper, configuration.model) });
        if (!approval.approved) {
          if (approval.reason === 'input_too_large') { inputTooLarge.add(paper.id); continue; }
          stopReason = approval.reason; return null;
        }
        if (!validDailyUsage(library.modelUsage, beijingDay(now))) throw new Error('日请求预算状态无效，未发送新请求');
        if (library.modelUsage.date !== beijingDay(now)) library.modelUsage = { date: beijingDay(now), requests: 0 };
        if (library.modelUsage.requests === Number.MAX_SAFE_INTEGER) throw new Error('日请求预算计数超限，未发送新请求');
        const key = requestKey(paper, configuration);
        receipts[key] = { status: 'pending', at: now.toISOString(), taskId: task.taskId, reservedMicroYuan: approval.reservedMicroYuan };
        library.modelUsage.requests++; attempts++;
        library.automation = { ...(record(library.automation) ? library.automation : {}), translationBatch: batchMetadata() };
        await save(libraryPath, library); // The reservation must reach disk before the model starts.
        return { paper, key, reservedMicroYuan: approval.reservedMicroYuan };
      }
      return null;
    }
    async function worker() {
      while (!fatal) {
        const job = await serial(reserveNext);
        if (!job) return;
        let rawResult, result, failure;
        try { rawResult = await interpret(structuredClone(job.paper), { ...configuration, allowTranslationOnly: task.translationOnlyFallback }); result = checkedResult(rawResult, job.paper, configuration); }
        catch (error) {
          failure = modelFailureDetails(error);
          const knownUsage = validateModelUsage(failure.modelUsage) || validateModelUsage(rawResult?.modelUsage);
          if (knownUsage) failure = { ...failure, modelUsage: knownUsage };
        }
        await serial(async () => {
          const fields = { at: nowAt(clock).toISOString(), taskId: task.taskId, reservedMicroYuan: job.reservedMicroYuan };
          if (!failure) {
            job.paper.enrichment = result;
            receipts[job.key] = { status: 'completed', ...fields, ...translationReceiptUsage(configuration, result.modelUsage) };
            passed++; if (result.analysisStatus === 'translation_only') translationOnlyPassed++;
            consecutiveFailures = 0;
          } else {
            receipts[job.key] = { status: 'failed_or_unknown', ...fields, ...failure, ...translationReceiptUsage(configuration, failure.modelUsage) };
            failed++; consecutiveFailures++;
            if (consecutiveFailures >= 5) stopReason ||= 'consecutive_failure_limit';
          }
          library.automation.translationBatch = batchMetadata();
          await save(libraryPath, library); // Receipt first; catalog failure cannot cause a retry.
          catalog = updateModelCatalog(library, catalog);
          await save(path.join(root, 'dist/translations.json'), catalog);
        });
      }
    }
    const workers = await Promise.allSettled(Array.from({ length: task.concurrency }, worker));
    await queue;
    const rejected = workers.find(value => value.status === 'rejected');
    if (fatal || rejected) throw fatal || rejected.reason;
    const reported = nowAt(clock);
    const remaining = library.papers.filter(p => !translationOf(attachEnrichment(p, catalog.items)));
    const noAbstract = remaining.filter(p => !p.abstract.trim()).length, retracted = remaining.filter(isRetracted).length;
    const blockedByReceipt = remaining.filter(p => p.abstract.trim() && !isRetracted(p) && existingReceipt(p, configuration, receipts)).length;
    const budget = translationBudget(task, receipts, configuration);
    const status = { schemaVersion: 1, taskId: task.taskId, date: task.date, startedAt: started.toISOString(), reportedAt: reported.toISOString(),
      requestedDeadline: task.requestedDeadline, deadlineMet: task.requestedDeadline ? reported.getTime() <= Date.parse(task.requestedDeadline) : null,
      expiresAt: task.expiresAt, reason: stopReason || (remaining.length ? 'no_more_eligible_papers' : 'all_translated'),
      scope: { total: library.papers.length, bilingual: library.papers.length - remaining.length, missing: remaining.length, noAbstract, retracted,
        blockedByReceipt, inputTooLarge: inputTooLarge.size },
      attempts, passed, failed, translationOnlyPassed, fullInterpretationPassed: passed - translationOnlyPassed,
      budget: { ...budget, budgetMicroYuan: task.budgetMicroYuan, maxRequests: task.maxRequests },
      actualBill: false, costNote: '官方原价估算与未知用量保守预留，不是实际账单或扣费。', remainingPaperIds: remaining.map(p => p.id) };
    library.automation = { ...(record(library.automation) ? library.automation : {}), translationBatch: { ...batchMetadata(reported.toISOString()), reason: status.reason } };
    await save(libraryPath, library);
    await save(path.join(root, 'dist/translation-status.json'), status);
    return status;
  } finally { await lock.release(); }
}

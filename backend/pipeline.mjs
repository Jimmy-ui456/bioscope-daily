import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TOPICS, collectTopic, mergePapers, beijingDay, isRetracted, validPublicationDate } from '../dist/core.js';
import { attachEnrichment, translationOf, sourceFingerprint } from '../dist/enrichment.js';
import { interpretPaper, PROMPT_VERSION, LEGACY_PROMPT_VERSIONS, modelFailureDetails, modelInputTokenUpperBound } from './interpret.mjs';
import { validateTranslationTask, approveTranslationRequest, translationReceiptUsage, translationBudget } from './translation-task.mjs';
import { applyPublisherMetrics, fetchPublisherMetric, refreshPublisherMetrics, summarizePublisherRefresh } from './downloads.mjs';
import { acquirePipelineLock } from './lock.mjs';
import { createPublicReport, updatePublicReportHistory } from './reports.mjs';
import { createDailyRss } from './feeds.mjs';
import { publicCollectionSource } from '../dist/collection-source.js';

export const PROJECT = fileURLToPath(new URL('../', import.meta.url));
export async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
export async function saveJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + '\n'); await rename(temp, file); }
export function modelConfig(env = process.env) { return { baseUrl: env.LLM_BASE_URL || '', apiKey: env.LLM_API_KEY || '', model: env.LLM_MODEL || '' }; }
export function configuredModel(config) { return Boolean(config.apiKey && config.baseUrl && config.model); }
export function requestKey(paper, config, promptVersion = PROMPT_VERSION) { return createHash('sha256').update([paper.id, sourceFingerprint(paper), config.baseUrl, config.model, promptVersion].join('|')).digest('hex'); }

function validModelUsage(usage, today) {
  return usage !== null && typeof usage === 'object' && !Array.isArray(usage)
    && validPublicationDate(usage.date) && usage.date <= today
    && Number.isSafeInteger(usage.requests) && usage.requests >= 0;
}
function configuredLimit(value, fallback, label) {
  const limit = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`${label}必须为非负安全整数，未调用模型`);
  return limit;
}

export async function runPipeline({ root = PROJECT, collect = collectTopic, interpret = interpretPaper, fetchMetric = fetchPublisherMetric, env = process.env, sourceEnv = process.env, now = new Date(), clock = () => new Date(), log = console.log, modelRunLimit } = {}) {
  if (modelRunLimit !== undefined && (!Number.isSafeInteger(modelRunLimit) || modelRunLimit < 0)) throw new Error('本次模型请求上限必须为非负安全整数');
  await mkdir(path.join(root, '.data'), { recursive: true });
  const lockPath = path.join(root, '.data/pipeline.lock');
  const lock = await acquirePipelineLock(lockPath);
  try {
    const config = await readJson(path.join(root, 'config/monitor.json'), {});
    const sample = await readJson(path.join(root, 'dist/sample.json'), { papers: [] });
    const previous = await readJson(path.join(root, 'dist/library.json'), { papers: [], receipts: {}, modelUsage: { date: beijingDay(now), requests: 0 } });
    const configModel = modelConfig(env), modelEnabled = configuredModel(configModel);
    const taskData = modelEnabled ? await readJson(path.join(root, 'config/translation-task.json'), null) : null;
    const task = taskData === null ? null : validateTranslationTask(taskData);
    const today = beijingDay(now);
    const usageKnown = validModelUsage(previous.modelUsage, today);
    if (modelEnabled && !usageKnown) throw new Error('已有模型请求预算记录缺失或无效，未调用模型；请核对原记录');
    // Unknown state is retained during model-free collection, never reset to a
    // fictional zero. Only a valid earlier Beijing date starts a new daily count.
    const usage = usageKnown ? (previous.modelUsage.date === today ? { ...previous.modelUsage } : { date: today, requests: 0 }) : previous.modelUsage;
    const runLimit = modelEnabled ? Math.min(configuredLimit(config.maxAnalysesPerRun, 10, '模型每轮上限'), modelRunLimit ?? Number.MAX_SAFE_INTEGER) : 0;
    const dailyLimit = modelEnabled ? configuredLimit(config.maxModelRequestsPerDay, 20, '模型每日上限') : 0;
    const catalog = (await readJson(path.join(root, 'dist/translations.json'), { items: {} })).items;
    const topics = TOPICS.filter(t => (config.topics || TOPICS.map(t => t.id)).includes(t.id));
    if (!topics.length) throw new Error('没有有效监控主题');
    const results = await Promise.allSettled(topics.map(t => collect(t, { days: config.days || 30, maxPages: config.maxPages || 2, pageSize: config.pageSize || 25, at: now })));
    const good = results.filter(r => r.status === 'fulfilled');
    if (!good.length) throw new Error('全部主题采集失败，保留上次文献库');
    const stats = results.map((r, i) => r.status === 'fulfilled' ? { topic: topics[i].name, hitCount: r.value.hitCount, count: r.value.papers.length, truncated: r.value.truncated } : { topic: topics[i].name, error: '上游请求失败，本方向结果未更新' });
    let papers = mergePapers(previous.papers, good.flatMap(r => r.value.papers)).slice(0, config.maxPapers || 500).map(p => attachEnrichment(p, catalog));
    const publisherRecords = (await readJson(path.join(root, 'config/download-metrics.json'), { records: [] })).records;
    papers = applyPublisherMetrics(papers, publisherRecords);
    papers = await refreshPublisherMetrics(papers, { fetchMetric });
    const downloadRefresh = summarizePublisherRefresh(papers);
    const receipts = { ...(previous.receipts || {}) };
    // Seed copies provide translations only; samples are not inserted as newly collected papers.
    const sampleCatalog = Object.fromEntries(sample.papers.filter(p => p.enrichment).map(p => [p.id, p.enrichment]));
    papers = papers.map(p => attachEnrichment(p, { ...sampleCatalog, ...catalog }));
    const collectionSource = publicCollectionSource(sourceEnv);
    const automaticPaused = !modelEnabled && sourceEnv.GITHUB_EVENT_NAME === 'schedule' && sourceEnv.BIOSCOPE_MODEL_AUTO !== 'true';
    const library = { schemaVersion: 2, origin: 'live', fetchedAt: new Date().toISOString(), papers, stats, modelUsage: usage, receipts, automation: { scheduleBeijing: config.scheduleBeijing || '07:17', modelConfigured: modelEnabled, modelStatus: modelEnabled ? 'ready' : automaticPaused ? 'automatic_paused' : 'not_configured', lastRunAt: new Date().toISOString(), failedTopics: stats.filter(s => s.error).length, collectionSource, downloadRefresh, ...(modelRunLimit === undefined ? {} : { modelRunLimit }) } };
    const output = path.join(root, 'dist/library.json');
    await saveJson(output, library);
    let attempted = 0, completed = 0, modelFailures = 0;
    if (modelEnabled) for (const paper of papers) {
      const translated = translationOf(paper);
      if (!paper.abstract || isRetracted(paper)) continue;
      if (translated && (translated.origin !== 'assistant_translation' || config.interpretTranslatedPapers !== true)) continue;
      if (attempted >= runLimit || usage.requests >= dailyLimit) break;
      const key = requestKey(paper, configModel);
      // A pending / unknown request is never retried automatically: it may already have cost money.
      if (receipts[key] || LEGACY_PROMPT_VERSIONS.some(version => receipts[requestKey(paper, configModel, version)])) continue;
      let taskFields = {};
      if (task) {
        const approval = approveTranslationRequest({ task, receipts, configuration: configModel, now: clock(), inputUpperBound: modelInputTokenUpperBound(paper, configModel.model) });
        if (!approval.approved) { library.automation.modelStopReason = approval.reason; if (approval.reason === 'input_too_large') continue; break; }
        taskFields = { taskId: task.taskId, reservedMicroYuan: approval.reservedMicroYuan };
      }
      attempted++; usage.requests++;
      receipts[key] = { status: 'pending', at: new Date().toISOString(), ...taskFields };
      await saveJson(output, library);
      try {
        paper.enrichment = await interpret(paper, task?.translationOnlyFallback ? { ...configModel, allowTranslationOnly: true } : configModel);
        receipts[key] = { status: 'completed', at: new Date().toISOString(), ...taskFields, ...translationReceiptUsage(configModel, paper.enrichment.modelUsage) };
        completed++;
      } catch (error) {
        const details = modelFailureDetails(error);
        receipts[key] = { status: 'failed_or_unknown', at: new Date().toISOString(), ...taskFields, ...details, ...translationReceiptUsage(configModel, details.modelUsage) }; modelFailures++;
      }
      await saveJson(output, library);
    }
    library.automation.modelRequestsThisRun = attempted;
    library.automation.modelCompletedThisRun = completed;
    library.automation.modelFailuresThisRun = modelFailures;
    if (task) library.automation.translationBudget = translationBudget(task, receipts, configModel);
    library.automation.analysisFailures = Object.values(receipts).filter(r => r.status === 'failed_or_unknown' || r.status === 'pending').length;
    await saveJson(output, library);
    const reportFile = path.join(root, 'dist/public-reports.json');
    const reportHistory = await readJson(reportFile, { version: 1, reports: [] });
    const failedTopics = stats.filter(stat => stat.error).map(stat => stat.topic);
    const publicReport = createPublicReport(papers, { now, topics, translations: catalog, sourceUpdatedAt: library.fetchedAt,
      sourceCollection: { status: failedTopics.length ? 'partial' : 'complete', failedTopics, ...collectionSource } });
    const reports = updatePublicReportHistory(reportHistory.reports, publicReport);
    await saveJson(reportFile, { version: 1, reports });
    const publication = await readJson(path.join(root, 'config/publication.json'), {});
    if (publication.siteUrl) await writeFile(path.join(root, 'dist/feed.xml'), createDailyRss(reports, { siteUrl: publication.siteUrl, translations: catalog }));
    // Completion covers the generated report/feed too. An interrupted job keeps its receipts
    // and collected papers, but must not advertise that all local outputs finished.
    library.automation.completedAt = new Date().toISOString();
    await saveJson(output, library);
    log(`采集完成：${papers.length} 篇，${papers.filter(p => translationOf(p)).length} 篇中英对照，模型请求 ${attempted} 次；${automaticPaused ? '自动模型已暂停，文献采集完成' : !modelEnabled ? '本次未启用模型，已跳过自动解读' : `模型结果通过 ${completed} 篇，失败或未知 ${modelFailures} 次`}。`);
    return library;
  } finally { await lock.release(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(PROJECT, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  runPipeline().catch(error => { console.error(error.message); process.exitCode = 1; });
}

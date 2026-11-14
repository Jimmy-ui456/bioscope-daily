import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizePaper } from '../dist/core.js';
import { sourceFingerprint, translationVersionKey } from '../dist/enrichment.js';
import { PROMPT_VERSION } from '../backend/interpret.mjs';
import { requestKey, saveJson, readJson } from '../backend/pipeline.mjs';
import { runBatchTranslation } from '../backend/batch-translation.mjs';

const now = new Date('2026-11-14T07:00:00.000Z');
const configuration = { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-flash', apiKey: 'offline-not-a-real-key' };
const env = { LLM_BASE_URL: configuration.baseUrl, LLM_MODEL: configuration.model, LLM_API_KEY: configuration.apiKey };
const taskDefault = { schemaVersion: 1, taskId: 'translation-20261114', date: '2026-11-14', authorizedAt: '2026-11-13T14:28:22.000Z',
  requestedDeadline: '2026-11-14T01:30:00.000Z', expiresAt: '2026-11-14T10:00:00.000Z', budgetMicroYuan: 5000000,
  maxRequests: 500, concurrency: 3, validationReceiptKey: null };
const tokens = { inputTokens: 1000, outputTokens: 2000, totalTokens: 3000 };
function paper(index) {
  return normalizePaper({ id: String(index), source: 'MED', doi: `10.1234/batch-${index}`, title: `Batch fixture ${index}`,
    abstractText: 'We measured yeast growth in shake flasks.', firstPublicationDate: '2026-11-14',
    pubTypeList: { pubType: ['Journal Article'] } }, 'synthetic', now.toISOString());
}
function result(p, usage = tokens) {
  return { titleZh: '酵母生长测试', abstractZh: '研究者在摇瓶中测量了酵母生长。', question: null, methods: null, findings: null, limitations: [],
    sourceTitle: p.title, sourceAbstract: p.abstract, sourceFingerprint: sourceFingerprint(p), origin: 'model', model: configuration.model,
    promptVersion: PROMPT_VERSION, createdAt: now.toISOString(), reviewed: false, scope: 'abstract_only', ...(usage ? { modelUsage: usage } : {}) };
}
async function project(t, { count = 4, task = {}, papers, usage = { date: '2026-11-14', requests: 1 }, receipt = {}, invalidProof = false } = {}) {
  const base = path.resolve('.cache/test-runs'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'batch-translation-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); });
  const proof = paper(0); proof.enrichment = result(proof);
  const key = requestKey(proof, configuration);
  const validation = { status: 'completed', at: now.toISOString(), taskId: taskDefault.taskId, reservedMicroYuan: 11200, modelUsage: tokens, ...receipt };
  const library = { schemaVersion: 2, origin: 'live', fetchedAt: '2026-11-14T06:00:00.000Z', papers: [proof, ...(papers || Array.from({ length: count }, (_, index) => paper(index + 1)))],
    modelUsage: usage, receipts: { [key]: validation }, automation: { collectionSource: { trigger: 'workflow_dispatch', runUrl: null }, modelRequestsThisRun: 1 } };
  const taskValue = { ...taskDefault, validationReceiptKey: invalidProof ? null : key, ...task };
  await saveJson(path.join(root, 'config/translation-task.json'), taskValue);
  await saveJson(path.join(root, 'dist/library.json'), library);
  await saveJson(path.join(root, 'dist/translations.json'), { version: 1, paperCount: 0, sourceVersionCount: 0, items: {} });
  await saveJson(path.join(root, 'dist/public-reports.json'), { reports: [{ id: 'frozen', source: 'must-not-change' }] });
  return { root, library, proof, key, task: taskValue };
}
const opts = { env, clock: () => now };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('批量最多3并发，所有请求在磁盘预留后才开始，落盘串行且不重采或改首刊', async t => {
  const { root, library } = await project(t, { count: 7 });
  const frozen = await readFile(path.join(root, 'dist/public-reports.json'), 'utf8');
  let active = 0, maximum = 0, writes = 0, maximumWrites = 0;
  const status = await runBatchTranslation({ root, ...opts, save: async (file, value) => {
    writes++; maximumWrites = Math.max(maximumWrites, writes);
    try { await delay(1); await saveJson(file, value); } finally { writes--; }
  }, interpret: async p => {
    active++; maximum = Math.max(maximum, active);
    try {
      const saved = await readJson(path.join(root, 'dist/library.json'));
      const receipt = saved.receipts[requestKey(p, configuration)];
      assert.equal(receipt.status, 'pending'); assert.equal(receipt.reservedMicroYuan, 11200);
      assert.equal(receipt.taskId, taskDefault.taskId); assert.ok(saved.modelUsage.requests >= 2);
      await delay(15); return result(p);
    } finally { active--; }
  } });
  assert.ok(maximum > 1); assert.ok(maximum <= 3); assert.equal(maximumWrites, 1);
  assert.equal(status.attempts, 7); assert.equal(status.passed, 7); assert.equal(status.failed, 0);
  assert.equal(status.scope.bilingual, 8); assert.equal(status.scope.missing, 0); assert.equal(status.reason, 'all_translated');
  assert.equal(status.budget.attempts, 8); assert.equal(status.budget.inputTokens, 8000); assert.equal(status.budget.outputTokens, 16000);
  assert.equal(status.budget.knownCostMicroYuan, 14400); assert.equal(status.budget.unknownReservedMicroYuan, 0);
  assert.equal(status.actualBill, false); assert.equal(status.deadlineMet, false);
  const saved = await readJson(path.join(root, 'dist/library.json'));
  assert.equal(saved.fetchedAt, library.fetchedAt); assert.deepEqual(saved.automation.collectionSource, library.automation.collectionSource);
  assert.equal(saved.modelUsage.requests, 8);
  assert.equal(await readFile(path.join(root, 'dist/public-reports.json'), 'utf8'), frozen);
  const catalog = await readJson(path.join(root, 'dist/translations.json'));
  assert.equal(catalog.paperCount, 8); assert.equal(catalog.sourceVersionCount, 8);
  assert.equal(Object.values(catalog.items).every(i => i.origin === 'model'), true);
  assert.deepEqual(await readJson(path.join(root, 'dist/translation-status.json')), status);
  assert.equal(JSON.stringify({ saved, catalog, status }).includes(configuration.apiKey), false);
});

test('旧v1/v2任意回执与已有译文不重做，无摘要/撤稿/超长输入列明跳过', async t => {
  const values = [paper(1), paper(2), paper(3), paper(4), paper(5), paper(6), paper(7), paper(8)];
  values[4].enrichment = { ...result(values[4]), origin: 'assistant_translation' };
  values[5].abstract = ''; values[5].readingScope = '仅题录';
  values[6].isRetraction = true;
  const setup = await project(t, { papers: values });
  const statuses = ['pending', 'failed_or_unknown', 'completed', 'failed_or_unknown'];
  for (let index = 0; index < 4; index++) setup.library.receipts[requestKey(values[index], configuration, index < 3 ? 'bioscope-zh-interpret-v1' : PROMPT_VERSION)] = { status: statuses[index], at: '2026-11-13T13:43:19.832Z' };
  await saveJson(path.join(setup.root, 'dist/library.json'), setup.library);
  const originals = structuredClone(setup.library.receipts);
  let calls = 0;
  const status = await runBatchTranslation({ root: setup.root, ...opts, inputTokenUpperBound: p => p.id === values[7].id ? 32001 : 1000,
    interpret: async () => { calls++; throw new Error('must not call'); } });
  assert.equal(calls, 0); assert.equal(status.scope.blockedByReceipt, 4); assert.equal(status.scope.noAbstract, 1);
  assert.equal(status.scope.retracted, 1); assert.equal(status.scope.inputTooLarge, 1); assert.equal(status.scope.bilingual, 2);
  const saved = await readJson(path.join(setup.root, 'dist/library.json'));
  assert.deepEqual(saved.receipts, originals);
  assert.equal(status.remainingPaperIds.includes(values[7].id), true);
});

test('未知用量保留0.0112元预留，预算和请求数包含先前API验收，绝不当作0', async t => {
  const setup = await project(t, { count: 5, task: { budgetMicroYuan: 13000 } });
  let calls = 0;
  const status = await runBatchTranslation({ root: setup.root, ...opts, interpret: async p => { calls++; return result(p, null); } });
  assert.equal(calls, 1); assert.equal(status.reason, 'budget_limit');
  assert.equal(status.budget.knownCostMicroYuan, 1800); assert.equal(status.budget.unknownReservedMicroYuan, 11200);
  assert.equal(status.budget.committedMicroYuan, 13000); assert.equal(status.budget.remainingMicroYuan, 0);
  assert.equal(status.budget.actualBill, false);
  const limited = await project(t, { count: 3, task: { maxRequests: 2 } });
  const capped = await runBatchTranslation({ root: limited.root, ...opts, interpret: async p => result(p) });
  assert.equal(capped.attempts, 1); assert.equal(capped.budget.attempts, 2); assert.equal(capped.reason, 'request_limit');
});

test('截止、日期不符时不发新请求，已在飞结果可保存，后续立即止损', async t => {
  for (const date of ['2026-11-14T10:00:00Z', '2026-11-15T00:00:00Z']) {
    const setup = await project(t); let calls = 0;
    const status = await runBatchTranslation({ root: setup.root, ...opts, clock: () => new Date(date), interpret: async () => { calls++; } });
    assert.equal(calls, 0); assert.equal(status.reason, 'outside_execution_window');
  }
  const setup = await project(t, { count: 3, task: { concurrency: 1 } }); let time = now, calls = 0;
  const status = await runBatchTranslation({ root: setup.root, ...opts, clock: () => time, interpret: async p => {
    calls++; time = new Date('2026-11-14T10:00:00Z'); return result(p);
  } });
  assert.equal(calls, 1); assert.equal(status.passed, 1); assert.equal(status.reason, 'outside_execution_window');
});

test('缺配置、无真实成功证书、错协议、损坏预算或日计数均在模型前拒绝', async t => {
  const setups = [
    await project(t, { invalidProof: true }), await project(t, { receipt: { status: 'failed_or_unknown' } }),
    await project(t, { receipt: { reservedMicroYuan: 0 } }), await project(t, { usage: { date: '2026-11-14', requests: -1 } }),
    await project(t, { usage: { date: '2026-02-30', requests: 0 } }),
  ];
  const wrong = await project(t); wrong.library.papers[0].enrichment.promptVersion = 'bioscope-zh-interpret-v1';
  await saveJson(path.join(wrong.root, 'dist/library.json'), wrong.library); setups.push(wrong);
  let calls = 0;
  for (const setup of setups) await assert.rejects(runBatchTranslation({ root: setup.root, ...opts, interpret: async () => { calls++; } }));
  const valid = await project(t);
  await assert.rejects(runBatchTranslation({ root: valid.root, ...opts, env: {}, interpret: async () => { calls++; } }));
  assert.equal(calls, 0);
});

test('pending落盘失败不发送模型，成功回执后catalog失败可跨run补写且不重复收费', async t => {
  const setup = await project(t, { count: 1 }); let calls = 0;
  await assert.rejects(runBatchTranslation({ root: setup.root, ...opts, save: async (file, value) => {
    if (file.endsWith('library.json')) throw new Error('offline simulated persistence failure'); await saveJson(file, value);
  }, interpret: async p => { calls++; return result(p); } }), /persistence failure/);
  assert.equal(calls, 0);
  const second = await project(t, { count: 1 }); let catalogWrites = 0;
  await assert.rejects(runBatchTranslation({ root: second.root, ...opts, save: async (file, value) => {
    if (file.endsWith('translations.json') && ++catalogWrites === 2) throw new Error('offline catalog write failure');
    await saveJson(file, value);
  }, interpret: async p => { calls++; return result(p); } }), /catalog write failure/);
  assert.equal(calls, 1);
  const recovered = await runBatchTranslation({ root: second.root, ...opts, interpret: async () => { calls++; throw new Error('must not call again'); } });
  assert.equal(calls, 1); assert.equal(recovered.attempts, 0); assert.equal(recovered.scope.bilingual, 2);
  const catalog = await readJson(path.join(second.root, 'dist/translations.json'));
  assert.ok(catalog.items[translationVersionKey(paper(1), paper(1).id)]);
});

test('连续五次失败停止新分配，已在飞最多额外两次，失败不自动重试且保留估算预留', async t => {
  const setup = await project(t, { count: 20 }); let calls = 0;
  const status = await runBatchTranslation({ root: setup.root, ...opts, interpret: async () => {
    calls++; await delay(2); throw new Error('private-provider-failure');
  } });
  assert.ok(calls >= 5 && calls <= 7); assert.equal(status.attempts, calls); assert.equal(status.failed, calls);
  assert.equal(status.reason, 'consecutive_failure_limit'); assert.equal(status.budget.unknownReservedMicroYuan, calls * 11200);
  const saved = await readJson(path.join(setup.root, 'dist/library.json'));
  assert.equal(JSON.stringify(saved).includes('private-provider-failure'), false);
  assert.equal(Object.values(saved.receipts).filter(r => r.status === 'failed_or_unknown').every(r => r.failureCode === 'unknown'), true);
});

test('有效旧日计数可换日，模型目录已有条目及别名不覆盖，后续重复run不重复调用', async t => {
  const p = paper(1), old = { ...result(p), origin: 'assistant_translation' };
  const setup = await project(t, { count: 2, usage: { date: '2026-11-13', requests: 2 } });
  const oldKey = 'pmid:preserved-alias';
  await saveJson(path.join(setup.root, 'dist/translations.json'), { version: 1, paperCount: 1, sourceVersionCount: 1, items: { [oldKey]: old } });
  let calls = 0;
  const status = await runBatchTranslation({ root: setup.root, ...opts, interpret: async input => { calls++; return result(input); } });
  assert.equal(calls, 2);
  const saved = await readJson(path.join(setup.root, 'dist/library.json'));
  assert.equal(saved.modelUsage.date, '2026-11-14'); assert.equal(saved.modelUsage.requests, 2);
  const catalog = await readJson(path.join(setup.root, 'dist/translations.json'));
  assert.deepEqual(catalog.items[oldKey], old); assert.equal(catalog.sourceVersionCount, 4);
  const rerun = await runBatchTranslation({ root: setup.root, ...opts, interpret: async () => { calls++; throw new Error('must not repeat'); } });
  assert.equal(calls, 2); assert.equal(rerun.attempts, 0); assert.equal(rerun.scope.bilingual, status.scope.bilingual);
});

test('本任务明确允许的仅译文降级标记保留到目录，计数不冒充完整研究解读', async t => {
  const setup = await project(t, { count: 1, task: { translationOnlyFallback: true } });
  const status = await runBatchTranslation({ root: setup.root, ...opts, interpret: async (p, options) => {
    assert.equal(options.allowTranslationOnly, true);
    return { ...result(p), analysisStatus: 'translation_only', analysisFailureCode: 'invalid_evidence' };
  } });
  assert.equal(status.passed, 1); assert.equal(status.translationOnlyPassed, 1); assert.equal(status.fullInterpretationPassed, 0);
  const saved = await readJson(path.join(setup.root, 'dist/library.json'));
  const translated = saved.papers.find(p => p.id === paper(1).id).enrichment;
  assert.equal(translated.analysisStatus, 'translation_only'); assert.equal(translated.analysisFailureCode, 'invalid_evidence');
  const catalog = await readJson(path.join(setup.root, 'dist/translations.json'));
  assert.deepEqual(catalog.items[translationVersionKey(paper(1), paper(1).id)], translated);
});

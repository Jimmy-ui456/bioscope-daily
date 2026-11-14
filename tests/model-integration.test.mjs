import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizePaper } from '../dist/core.js';
import { sourceFingerprint } from '../dist/enrichment.js';
import { interpretPaper, SYSTEM_PROMPT } from '../backend/interpret.mjs';
import { runPipeline, saveJson, readJson } from '../backend/pipeline.mjs';

const now = new Date('2026-11-13T00:00:00Z');
const today = '2026-11-13';
const env = { LLM_BASE_URL: 'https://model.example.invalid/v1', LLM_MODEL: 'fixture-model', LLM_API_KEY: 'offline-test-only' };
function paper(index = 1) {
  return normalizePaper({ id: String(index), source: 'MED', doi: `10.1234/model-fixture-${index}`, title: `Model fixture ${index}`,
    abstractText: 'We measured yeast growth in shake flasks.', firstPublicationDate: '2026-11-12', pubTypeList: { pubType: ['Journal Article'] } }, 'synthetic', now.toISOString());
}
function enrichment(p, origin = 'model') {
  return { titleZh: '酵母生长测试', abstractZh: '研究者在摇瓶中测量了酵母生长。', sourceTitle: p.title,
    sourceAbstract: p.abstract, sourceFingerprint: sourceFingerprint(p), origin, reviewed: false, scope: 'abstract_only' };
}
async function project(t, { config = {}, library } = {}) {
  const base = path.resolve('.cache/test-runs');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'model-integration-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); });
  await saveJson(path.join(root, 'config/monitor.json'), { topics: ['synthetic'], maxAnalysesPerRun: 10, maxModelRequestsPerDay: 20, ...config });
  await saveJson(path.join(root, 'dist/sample.json'), { papers: [] });
  if (library !== undefined) await saveJson(path.join(root, 'dist/library.json'), library);
  return root;
}
function collected(papers) { return async () => ({ papers, hitCount: papers.length, truncated: false }); }
const silent = { fetchMetric: async () => null, log: () => {} };

test('真实流水线先持久化任务预算再调用，成功保存Token成本、未知失败保留预留', async t => {
  const root = await project(t);
  await saveJson(path.join(root, 'config/translation-task.json'), { schemaVersion: 1, taskId: 'fixture-task', date: today,
    authorizedAt: '2026-11-12T00:00:00Z', expiresAt: '2026-11-13T15:59:00Z', budgetMicroYuan: 5000000,
    maxRequests: 500, concurrency: 3, validationReceiptKey: null });
  const pricedEnv = { LLM_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', LLM_MODEL: 'qwen3.7-flash', LLM_API_KEY: 'never-send' };
  let calls = 0;
  const result = await runPipeline({ root, env: pricedEnv, now, clock: () => now, modelRunLimit: 1, collect: collected([paper(1)]), ...silent,
    interpret: async p => {
      calls++;
      const saved = await readJson(path.join(root, 'dist/library.json'));
      const pending = Object.values(saved.receipts)[0];
      assert.equal(pending.status, 'pending'); assert.equal(pending.taskId, 'fixture-task'); assert.equal(pending.reservedMicroYuan, 11200);
      assert.equal(saved.modelUsage.requests, 1);
      return { ...enrichment(p), modelUsage: { inputTokens: 1000, outputTokens: 2000, totalTokens: 3000 } };
    } });
  assert.equal(calls, 1); assert.equal(result.automation.translationBudget.knownCostMicroYuan, 1800);
  assert.equal(Object.values(result.receipts)[0].costEstimate.actualBill, false);
  const failed = await runPipeline({ root, env: pricedEnv, now, clock: () => now, modelRunLimit: 1, collect: collected([paper(1), paper(2)]), ...silent,
    interpret: async () => { calls++; throw new Error('unknown provider result'); } });
  assert.equal(calls, 2); assert.equal(failed.automation.translationBudget.unknownReservedMicroYuan, 11200);
  assert.equal(failed.automation.translationBudget.committedMicroYuan, 13000);
});

test('暂停自动模型的定时运行仍完成采集和日报，记录暂停状态并保留失败回执', async t => {
  const oldReceipt = { status: 'failed_or_unknown', at: '2026-11-13T13:43:19.832Z' };
  const root = await project(t, { library: { papers: [], modelUsage: { date: '2026-11-12', requests: 1 }, receipts: { preserved: oldReceipt } } });
  let calls = 0;
  const result = await runPipeline({ root, ...silent, now, env: {}, sourceEnv: { GITHUB_EVENT_NAME: 'schedule', BIOSCOPE_MODEL_AUTO: 'false' },
    collect: collected([paper()]), interpret: async () => { calls++; throw new Error('must not call'); } });
  assert.equal(calls, 0); assert.equal(result.papers.length, 1);
  assert.equal(result.automation.modelStatus, 'automatic_paused');
  assert.equal(result.automation.modelRequestsThisRun, 0); assert.ok(result.automation.completedAt);
  assert.deepEqual(result.receipts.preserved, oldReceipt);
});

test('仅百炼官方域名的qwen3.7-flash系列添加非思考开关，保留JSON与输出上限', async () => {
  for (const [baseUrl, model] of [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-flash'],
    ['https://bailian.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'qwen3.7-flash-2026-11-01'],
  ]) {
    let captured;
    const p = paper();
    const output = await interpretPaper(p, { baseUrl, model, apiKey: 'offline-test-only', fetchImpl: async (url, options) => {
      captured = { url: url.href, body: JSON.parse(options.body), headers: options.headers };
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(enrichment(p)) } }] }) };
    } });
    assert.equal(captured.url, baseUrl + '/chat/completions');
    assert.equal(captured.body.enable_thinking, false);
    assert.equal(captured.body.max_tokens, 6000);
    assert.deepEqual(captured.body.response_format, { type: 'json_object' });
    assert.equal(captured.body.model, model); assert.equal(captured.body.messages[0].content, SYSTEM_PROMPT);
    assert.equal(captured.headers.Authorization, 'Bearer offline-test-only');
    assert.equal(output.sourceTitle, p.title); assert.equal(output.sourceAbstract, p.abstract); assert.equal(output.reviewed, false);
    assert.equal(JSON.stringify(output).includes('offline-test-only'), false);
  }
});

test('一般兼容模型、非官方中转或其他Qwen系列请求体保持原样，不乱加供应商字段', async () => {
  const p = paper();
  for (const [baseUrl, model] of [
    ['https://example.invalid/v1', 'fixture-model'], ['https://example.invalid/v1', 'qwen3.7-flash'],
    ['https://dashscope.aliyuncs.com.attacker.invalid/v1', 'qwen3.7-flash'],
    ['https://notdashscope.aliyuncs.com/v1', 'qwen3.7-flash'],
    ['https://maas.aliyuncs.com.attacker.invalid/v1', 'qwen3.7-flash'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.6-flash'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-flashy'],
  ]) {
    let body;
    await interpretPaper(p, { baseUrl, model, apiKey: 'offline-test-only', fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(enrichment(p)) } }] }) };
    } });
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'response_format']);
    assert.equal(Object.hasOwn(body, 'enable_thinking'), false); assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
  }
});

test('非思考适配不绕过截断与英文证据校验，不发布坏输出', async () => {
  const p = paper();
  for (const [finish_reason, data, expected] of [
    ['length', enrichment(p), /截断/],
    ['stop', { ...enrichment(p), findings: { text: '达到100 g/L。', evidence: 'Unreported result 100 g/L.' } }, /证据/],
  ]) {
    let calls = 0;
    await assert.rejects(interpretPaper(p, { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-flash', apiKey: 'offline-test-only',
      fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ choices: [{ finish_reason, message: { content: JSON.stringify(data) } }] }) }; } }), expected);
    assert.equal(calls, 1);
  }
});

test('单次硬限1或0严格限制真实调用，硬限不会扩大配置每轮上限', async t => {
  const inputs = [paper(1), paper(2), paper(3)];
  for (const [modelRunLimit, configured, daily, expected] of [[1, 10, 20, 1], [0, 10, 20, 0], [10, 1, 20, 1], [1, 0, 20, 0], [1, 10, 0, 0]]) {
    const root = await project(t, { config: { maxAnalysesPerRun: configured, maxModelRequestsPerDay: daily } });
    let calls = 0;
    const result = await runPipeline({ root, env, now, modelRunLimit, collect: collected(inputs), ...silent,
      interpret: async p => { calls++; return enrichment(p); } });
    assert.equal(calls, expected); assert.equal(result.automation.modelRequestsThisRun, expected);
    assert.equal(result.automation.modelCompletedThisRun, expected); assert.equal(result.automation.modelFailuresThisRun, 0);
    assert.equal(result.automation.modelRunLimit, modelRunLimit); assert.equal(result.modelUsage.requests, expected);
    const saved = await readJson(path.join(root, 'dist/library.json'));
    assert.equal(saved.automation.modelRunLimit, modelRunLimit);
  }
});

test('未传硬限沿用配置上限且不生成硬限元数据，每日上限仍有效', async t => {
  const root = await project(t, { config: { maxAnalysesPerRun: 2, maxModelRequestsPerDay: 1 } });
  let calls = 0;
  const result = await runPipeline({ root, env, now, collect: collected([paper(1), paper(2)]), ...silent,
    interpret: async p => { calls++; return enrichment(p); } });
  assert.equal(calls, 1); assert.equal(result.modelUsage.requests, 1);
  assert.equal(Object.hasOwn(result.automation, 'modelRunLimit'), false);
});

test('默认跳过所有有效辅助译文，优先把调用用于未翻译论文', async t => {
  const translated = paper(1), missing = paper(2);
  const assistant = enrichment(translated, 'assistant_translation');
  const root = await project(t, { library: { papers: [{ ...translated, enrichment: assistant }], modelUsage: { date: today, requests: 0 }, receipts: {} } });
  const calls = [];
  const result = await runPipeline({ root, env, now, modelRunLimit: 1, collect: collected([translated, missing]), ...silent,
    interpret: async p => { calls.push(p.id); return enrichment(p); } });
  assert.deepEqual(calls, [missing.id]);
  assert.deepEqual(result.papers.find(p => p.id === translated.id).enrichment, assistant);
});

test('仅明确true才允许补充助手译文的模型解读，已有效模型译文始终不重做', async t => {
  const assistantPaper = paper(1), modelPaper = paper(2);
  for (const interpretTranslatedPapers of [true, false, 'true']) {
    const root = await project(t, { config: { interpretTranslatedPapers }, library: {
      papers: [{ ...assistantPaper, enrichment: enrichment(assistantPaper, 'assistant_translation') }, { ...modelPaper, enrichment: enrichment(modelPaper) }],
      modelUsage: { date: today, requests: 0 }, receipts: {},
    } });
    const calls = [];
    const result = await runPipeline({ root, env, now, collect: collected([assistantPaper, modelPaper]), ...silent,
      interpret: async p => { calls.push(p.id); return enrichment(p); } });
    assert.deepEqual(calls, interpretTranslatedPapers === true ? [assistantPaper.id] : []);
    assert.equal(result.automation.modelRequestsThisRun, calls.length);
  }
});

test('缺失、未知、负数、错误类型和未来日期预算在付费前拒绝且不改原快照', async t => {
  for (const usage of [undefined, null, [], {}, { date: today, requests: -100 }, { date: today, requests: '0' },
    { date: today, requests: null }, { date: today, requests: 1.5 }, { date: today, requests: Number.MAX_SAFE_INTEGER + 1 },
    { date: '2026-02-30', requests: 0 }, { date: '2026-11-14', requests: 0 }]) {
    const library = { papers: [paper()], marker: 'must-keep', receipts: {}, ...(usage === undefined ? {} : { modelUsage: usage }) };
    const root = await project(t, { library });
    const before = await readFile(path.join(root, 'dist/library.json'), 'utf8');
    let calls = 0, collections = 0;
    await assert.rejects(runPipeline({ root, env, now, collect: async () => { collections++; return { papers: [], hitCount: 0 }; }, ...silent,
      interpret: async p => { calls++; return enrichment(p); } }), /预算记录缺失或无效/);
    assert.equal(calls, 0); assert.equal(collections, 0);
    assert.equal(await readFile(path.join(root, 'dist/library.json'), 'utf8'), before);
  }
});

test('有效旧日预算才在新北京日归零，无模型采集原样保留缺失或坏预算', async t => {
  const root = await project(t, { library: { papers: [], receipts: {}, modelUsage: { date: '2026-11-12', requests: 20 } } });
  const result = await runPipeline({ root, env, now, modelRunLimit: 1, collect: collected([paper()]), ...silent, interpret: async p => enrichment(p) });
  assert.deepEqual(result.modelUsage, { date: today, requests: 1 });
  for (const usage of [undefined, null, { date: today, requests: -10 }, { date: '2026-02-30', requests: 5 }]) {
    const library = { papers: [], receipts: {}, ...(usage === undefined ? {} : { modelUsage: usage }) };
    const target = await project(t, { library });
    const output = await runPipeline({ root: target, env: {}, now, collect: collected([paper()]), ...silent,
      interpret: () => { throw new Error('must not call'); } });
    assert.deepEqual(output.modelUsage, usage);
    const saved = await readJson(path.join(target, 'dist/library.json'));
    assert.deepEqual(saved.modelUsage, usage); assert.equal(output.automation.modelRequestsThisRun, 0);
  }
});

test('非法调用硬限与配置预算不会隐式转换或回退，任何模型请求前报错', async t => {
  for (const modelRunLimit of [null, -1, 1.5, '1', {}, Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0;
    await assert.rejects(runPipeline({ root: 'unused-before-limit-validation', env, modelRunLimit,
      interpret: async () => { calls++; } }), /非负安全整数/);
    assert.equal(calls, 0);
  }
  for (const key of ['maxAnalysesPerRun', 'maxModelRequestsPerDay']) for (const value of [null, -1, '1', {}, 1.5]) {
    const root = await project(t, { config: { [key]: value } });
    let calls = 0;
    await assert.rejects(runPipeline({ root, env, now, collect: collected([paper()]), ...silent,
      interpret: async p => { calls++; return enrichment(p); } }), /非负安全整数/);
    assert.equal(calls, 0);
  }
});

test('更换证据协议后仍阻止旧版本已尝试论文，保留旧回执并只处理新的论文', async t => {
  const { requestKey, modelConfig } = await import('../backend/pipeline.mjs');
  const { PROMPT_VERSION } = await import('../backend/interpret.mjs');
  assert.notEqual(PROMPT_VERSION, 'bioscope-zh-interpret-v1');
  for (const status of ['pending', 'failed_or_unknown', 'completed']) {
    const p = paper(1), fresh = paper(2);
    const key = requestKey(p, modelConfig(env), 'bioscope-zh-interpret-v1');
    assert.notEqual(key, requestKey(p, modelConfig(env)));
    const receipt = { status, at: '2026-11-12T14:00:00Z', ...(status === 'failed_or_unknown' ? { failureCode: 'invalid_evidence' } : {}) };
    const root = await project(t, { library: { papers: [p], modelUsage: { date: today, requests: 1 }, receipts: { [key]: receipt } } });
    const ids = [];
    const result = await runPipeline({ root, env, now, modelRunLimit: 1, collect: collected([p, fresh]), ...silent,
      interpret: async input => { ids.push(input.id); return enrichment(input); } });
    assert.deepEqual(ids, [fresh.id]);
    assert.deepEqual(result.receipts[key], receipt);
    assert.equal(result.modelUsage.requests, 2); assert.equal(result.automation.modelRequestsThisRun, 1);
    const rerun = await runPipeline({ root, env, now, modelRunLimit: 1, collect: collected([p, fresh]), ...silent,
      interpret: async () => { throw new Error('must not retry old or current receipts'); } });
    assert.equal(rerun.automation.modelRequestsThisRun, 0); assert.equal(rerun.modelUsage.requests, 2);
    assert.deepEqual(rerun.receipts[key], receipt);
  }
});

test('单篇验收失败仍先保存pending与日用量，后续验收不自动重试未知请求', async t => {
  const root = await project(t);
  let calls = 0;
  const interpret = async () => {
    calls++;
    const stored = await readJson(path.join(root, 'dist/library.json'));
    assert.equal(stored.modelUsage.requests, 1);
    assert.equal(Object.values(stored.receipts)[0].status, 'pending');
    throw new Error('offline simulated unknown result');
  };
  const first = await runPipeline({ root, env, now, modelRunLimit: 1, collect: collected([paper()]), ...silent, interpret });
  assert.equal(first.automation.modelRequestsThisRun, 1);
  assert.equal(first.automation.modelCompletedThisRun, 0); assert.equal(first.automation.modelFailuresThisRun, 1);
  assert.equal(Object.values(first.receipts)[0].status, 'failed_or_unknown');
  const second = await runPipeline({ root, env, now, modelRunLimit: 1, collect: collected([paper()]), ...silent, interpret });
  assert.equal(calls, 1); assert.equal(second.automation.modelRequestsThisRun, 0); assert.equal(second.modelUsage.requests, 1);
  assert.equal(second.automation.modelCompletedThisRun, 0); assert.equal(second.automation.modelFailuresThisRun, 0);
  assert.equal(second.automation.analysisFailures, 1);
});

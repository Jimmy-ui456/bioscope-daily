import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizePaper } from '../dist/core.js';
import { interpretPaper, modelFailureDetails } from '../backend/interpret.mjs';
import { modelConfig, requestKey, runPipeline, saveJson, readJson } from '../backend/pipeline.mjs';

const now = new Date('2026-11-13T14:00:00Z');
const p = normalizePaper({ id: 'diagnostic-fixture', source: 'MED', doi: '10.1234/diagnostic-fixture', title: 'Diagnostic fixture',
  abstractText: 'We measured yeast growth in shake flasks.', firstPublicationDate: '2026-11-13', pubTypeList: { pubType: ['Journal Article'] } }, 'synthetic', now.toISOString());
const env = { LLM_BASE_URL: 'https://example.invalid/v1', LLM_MODEL: 'fixture-model', LLM_API_KEY: 'never-publish-fixture-key' };
const parsed = { titleZh: '酵母生长测试', abstractZh: '研究者在摇瓶中测量了酵母的生长。', question: null, methods: null, findings: null, limitations: [] };
const envelope = (content = JSON.stringify(parsed), finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content } }] });
const jsonResponse = value => async () => ({ ok: true, json: async () => value });
const cases = [
  { name: 'http', expected: { failureCode: 'http_error', httpStatus: 401 }, fetchImpl: async () => ({ ok: false, status: 401, json: () => { throw new Error('private-provider-response'); } }) },
  { name: 'network', expected: { failureCode: 'network_or_timeout' }, fetchImpl: async () => { throw new Error('private-key-and-url https://private.invalid'); } },
  { name: 'timeout', expected: { failureCode: 'network_or_timeout' }, fetchImpl: async () => { throw new DOMException('private-timeout-message', 'TimeoutError'); } },
  { name: 'outer-json', expected: { failureCode: 'invalid_json' }, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('private-response-json'); } }) },
  { name: 'content-json', expected: { failureCode: 'invalid_json' }, fetchImpl: jsonResponse(envelope('private-not-json')) },
  { name: 'truncated', expected: { failureCode: 'truncated_output' }, fetchImpl: jsonResponse(envelope('private-truncated-output', 'length')) },
  { name: 'translation', expected: { failureCode: 'invalid_translation' }, fetchImpl: jsonResponse(envelope(JSON.stringify({ ...parsed, titleZh: 'private-no-chinese' }))) },
  { name: 'evidence', expected: { failureCode: 'invalid_evidence' }, fetchImpl: jsonResponse(envelope(JSON.stringify({ ...parsed, findings: { text: '未经原文支持的结果', evidence: 'private-invented-evidence' } }))) },
  { name: 'outer-shape', expected: { failureCode: 'invalid_shape' }, fetchImpl: jsonResponse(null) },
  { name: 'content-shape', expected: { failureCode: 'invalid_shape' }, fetchImpl: jsonResponse(envelope('[]')) },
  { name: 'limitations-shape', expected: { failureCode: 'invalid_shape' }, fetchImpl: jsonResponse(envelope(JSON.stringify({ ...parsed, limitations: 'private-invalid-array' }))) },
];

test('模型失败仅返回固定分类与受控HTTP状态，不泄漏任何原始错误或模型字段', async () => {
  for (const fixture of cases) {
    let error;
    try { await interpretPaper(p, { ...modelConfig(env), fetchImpl: fixture.fetchImpl }); }
    catch (caught) { error = caught; }
    assert.ok(error, fixture.name);
    const details = modelFailureDetails(error);
    assert.deepEqual(details, fixture.expected, fixture.name);
    const serialized = JSON.stringify(details);
    assert.equal(serialized.includes('private'), false); assert.equal(serialized.includes(env.LLM_API_KEY), false);
    assert.equal(serialized.includes('https://'), false);
  }
});

test('任意错误伪造的分类、HTTP状态或provider code都不能通过可信错误门控', () => {
  const forged = Object.assign(new Error('private-raw-message'), { name: 'ModelInterpretationError', failureCode: 'http_error', httpStatus: 403, code: 'provider-private-code' });
  for (const value of [forged, { failureCode: 'invalid_evidence' }, { code: 'http_error', status: 401 }, 'private-error', null]) {
    assert.deepEqual(modelFailureDetails(value), { failureCode: 'unknown' });
  }
});

test('输入及配置预检使用固定诊断，不触发mock网络，也不输出完整地址', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not call'); };
  for (const [paper, config, failureCode] of [
    [p, {}, 'invalid_configuration'], [p, { ...modelConfig(env), baseUrl: 'private-invalid-url' }, 'invalid_configuration'],
    [{ ...p, abstract: '' }, modelConfig(env), 'invalid_input'], [{ ...p, abstract: 'x'.repeat(40001) }, modelConfig(env), 'invalid_input'],
  ]) {
    let error;
    try { await interpretPaper(paper, { ...config, fetchImpl }); } catch (caught) { error = caught; }
    assert.deepEqual(modelFailureDetails(error), { failureCode });
    assert.equal(error.message.includes('private'), false);
  }
  assert.equal(calls, 0);
});

async function project(t, library = { papers: [], modelUsage: { date: '2026-11-13', requests: 0 }, receipts: {} }) {
  const base = path.resolve('.cache/test-runs'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'model-diagnostic-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); });
  await saveJson(path.join(root, 'config/monitor.json'), { topics: ['synthetic'], maxAnalysesPerRun: 10, maxModelRequestsPerDay: 20 });
  await saveJson(path.join(root, 'dist/sample.json'), { papers: [] });
  await saveJson(path.join(root, 'dist/library.json'), library);
  return root;
}
const inputs = { env, now, modelRunLimit: 1, collect: async () => ({ papers: [p], hitCount: 1, truncated: false }), fetchMetric: async () => null, log: () => {} };

test('每种固定失败诊断持久化到失败回执，仍先记预算、阻止后续自动重试', async t => {
  for (const fixture of cases) {
    const root = await project(t); let calls = 0;
    const interpret = async (paper, config) => {
      calls++;
      const before = await readJson(path.join(root, 'dist/library.json'));
      assert.equal(Object.values(before.receipts)[0].status, 'pending'); assert.equal(before.modelUsage.requests, 1);
      return interpretPaper(paper, { ...config, fetchImpl: fixture.fetchImpl });
    };
    const result = await runPipeline({ root, ...inputs, interpret });
    const receipt = Object.values(result.receipts)[0];
    assert.equal(receipt.status, 'failed_or_unknown');
    assert.equal(typeof receipt.at, 'string');
    const { status, at, ...details } = receipt;
    assert.deepEqual(details, fixture.expected);
    assert.equal(result.automation.modelRequestsThisRun, 1); assert.equal(result.automation.modelCompletedThisRun, 0); assert.equal(result.automation.modelFailuresThisRun, 1);
    const saved = await readJson(path.join(root, 'dist/library.json'));
    for (const forbidden of ['private', env.LLM_API_KEY, env.LLM_BASE_URL]) assert.equal(JSON.stringify(saved).includes(forbidden), false);
    const retry = await runPipeline({ root, ...inputs, interpret });
    assert.equal(calls, 1); assert.equal(retry.modelUsage.requests, 1); assert.equal(retry.automation.modelRequestsThisRun, 0);
    assert.deepEqual(Object.values(retry.receipts)[0], receipt);
  }
});

test('首轮旧格式失败回执保持原样，不补填猜测的原因或重新调用', async t => {
  const original = { status: 'failed_or_unknown', at: '2026-11-13T13:43:19.832Z' };
  const key = requestKey(p, modelConfig(env));
  const root = await project(t, { papers: [p], modelUsage: { date: '2026-11-13', requests: 1 }, receipts: { [key]: original } });
  let calls = 0;
  const result = await runPipeline({ root, ...inputs, interpret: async () => { calls++; throw new Error('must not call'); } });
  assert.equal(calls, 0); assert.deepEqual(result.receipts[key], original);
  assert.equal(Object.hasOwn(result.receipts[key], 'failureCode'), false);
  assert.equal(result.modelUsage.requests, 1); assert.equal(result.automation.modelRequestsThisRun, 0);
});

test('未知实现错误只存unknown，不透传错误消息或伪造分类', async t => {
  const root = await project(t);
  const result = await runPipeline({ root, ...inputs, interpret: async () => {
    throw Object.assign(new Error('private message with never-publish-fixture-key'), { failureCode: 'http_error', httpStatus: 401 });
  } });
  const receipt = Object.values(result.receipts)[0];
  assert.equal(receipt.failureCode, 'unknown'); assert.equal(Object.hasOwn(receipt, 'httpStatus'), false);
  assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(JSON.stringify(result).includes(env.LLM_API_KEY), false);
});

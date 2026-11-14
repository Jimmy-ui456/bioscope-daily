import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretPaper, modelFailureDetails, validateInterpretation } from '../backend/interpret.mjs';

const paper = { title: 'Yeast growth in shake flasks', abstract: 'We measured yeast growth in shake flasks.', isPreprint: false, readingScope: 'abstract_only' };
const configuration = { baseUrl: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'private-test-key-never-send' };
const translated = { titleZh: '摇瓶中的酵母生长', abstractZh: '研究者在摇瓶中测量了酵母生长。', question: null,
  methods: { text: '测量摇瓶中的酵母生长。', evidenceId: 'A1' }, findings: null, limitations: [] };
const providerUsage = { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165, prompt_tokens_details: { cached_tokens: 40 } };
const canonical = { inputTokens: 120, outputTokens: 45, totalTokens: 165, cachedInputTokens: 40 };
function envelope(content = JSON.stringify(translated), usage, finish_reason = 'stop') {
  if (arguments.length < 2) usage = providerUsage;
  return { usage, choices: [{ finish_reason, message: { content } }] };
}
function mockFetch(value) { return async () => ({ ok: true, json: async () => value }); }
async function failureDetails(fetchImpl) {
  let failure;
  try { await interpretPaper(paper, { ...configuration, fetchImpl }); }
  catch (error) { failure = error; }
  assert.ok(failure);
  return { failure, details: modelFailureDetails(failure) };
}

test('成功译文仅保存provider顶层的安全usage，不保存原始usage的额外数据', async () => {
  let calls = 0;
  const original = envelope(undefined, { ...providerUsage, key: configuration.apiKey, url: configuration.baseUrl,
    message: 'private-provider-message', prompt_tokens_details: { cached_tokens: 40, secret: 'private-extra' } });
  const result = await interpretPaper(paper, { ...configuration, fetchImpl: async () => { calls++; return { ok: true, json: async () => original }; } });
  assert.equal(calls, 1);
  assert.deepEqual(result.modelUsage, canonical);
  assert.equal(result.origin, 'model');
  assert.equal(result.methods.evidence, paper.abstract);
  const output = JSON.stringify(result);
  for (const secret of [configuration.apiKey, configuration.baseUrl, 'private-provider-message', 'private-extra']) assert.equal(output.includes(secret), false);
  assert.equal(Object.hasOwn(result, 'usage'), false);
  assert.notEqual(result.modelUsage, original.usage);
});

test('无usage或严格校验失败时保持未知，不把缺失量补为零', async () => {
  for (const usage of [undefined, null, {}, [], { prompt_tokens: 120, completion_tokens: 45 },
    { prompt_tokens: '120', completion_tokens: 45, total_tokens: 165 },
    { prompt_tokens: 120, completion_tokens: 45, total_tokens: 999 },
    { prompt_tokens: -1, completion_tokens: 45, total_tokens: 44 },
    { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165, prompt_tokens_details: { cached_tokens: 121 } }]) {
    const result = await interpretPaper(paper, { ...configuration, fetchImpl: mockFetch(envelope(undefined, usage)) });
    assert.equal(Object.hasOwn(result, 'modelUsage'), false);
    const { details } = await failureDetails(mockFetch(envelope('{private-invalid-json', usage)));
    assert.deepEqual(details, { failureCode: 'invalid_json' });
  }
});

test('合法零用量为provider明示值才保留，未给缓存量时不补缓存零', async () => {
  const result = await interpretPaper(paper, { ...configuration,
    fetchImpl: mockFetch(envelope(undefined, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })) });
  assert.deepEqual(result.modelUsage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(Object.hasOwn(result.modelUsage, 'cachedInputTokens'), false);
});

test('无效证据、内部JSON及翻译结构错误均保留合法provider usage与原失败类别', async () => {
  for (const [content, code, finish_reason] of [
    [JSON.stringify({ ...translated, findings: { text: '未经支持的结果。', evidenceId: 'A99' } }), 'invalid_evidence', 'stop'],
    ['{private-invalid-json', 'invalid_json', 'stop'],
    [JSON.stringify({ ...translated, titleZh: 'English only' }), 'invalid_translation', 'stop'],
    ['[]', 'invalid_shape', 'stop'],
    [JSON.stringify(translated), 'truncated_output', 'length'],
  ]) {
    const { details } = await failureDetails(mockFetch(envelope(content, providerUsage, finish_reason)));
    assert.deepEqual(details, { failureCode: code, modelUsage: canonical });
    assert.equal(JSON.stringify(details).includes('private'), false);
  }
  const { details } = await failureDetails(mockFetch({ usage: providerUsage, choices: [] }));
  assert.deepEqual(details, { failureCode: 'invalid_shape', modelUsage: canonical });
});

test('HTTP、网络及外层JSON失败不知道usage时省略，不读取HTTP错误body或自动重试', async () => {
  for (const [fetchImpl, expected] of [
    [async () => ({ ok: false, status: 401, json: async () => { throw new Error('must never read private usage'); } }), { failureCode: 'http_error', httpStatus: 401 }],
    [async () => { throw Object.assign(new Error(configuration.apiKey), { usage: providerUsage, modelUsage: canonical }); }, { failureCode: 'network_or_timeout' }],
    [async () => ({ ok: true, json: async () => { throw Object.assign(new Error(configuration.apiKey), { usage: providerUsage }); } }), { failureCode: 'invalid_json' }],
  ]) {
    let calls = 0;
    const { details } = await failureDetails(async (...args) => { calls++; return fetchImpl(...args); });
    assert.deepEqual(details, expected);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(details).includes(configuration.apiKey), false);
  }
});

test('模型content自称的usage、外部Error及可改写字段均不能污染可信用量', async () => {
  const inner = { ...translated, usage: providerUsage, modelUsage: canonical };
  const result = await interpretPaper(paper, { ...configuration, fetchImpl: mockFetch(envelope(JSON.stringify(inner), null)) });
  assert.equal(Object.hasOwn(result, 'modelUsage'), false);
  const forged = Object.assign(new Error('private-provider-message'), { name: 'ModelInterpretationError', failureCode: 'invalid_evidence', modelUsage: canonical });
  assert.deepEqual(modelFailureDetails(forged), { failureCode: 'unknown' });
  let direct;
  try { validateInterpretation({ ...translated, titleZh: '' }, paper); } catch (error) { direct = error; }
  direct.modelUsage = { ...canonical, secret: configuration.apiKey };
  assert.deepEqual(modelFailureDetails(direct), { failureCode: 'invalid_translation' });
  const { failure, details } = await failureDetails(mockFetch(envelope('{private-invalid-json')));
  details.modelUsage.inputTokens = 999;
  failure.modelUsage = { inputTokens: 888, outputTokens: 0, totalTokens: 888, secret: configuration.apiKey };
  assert.deepEqual(modelFailureDetails(failure), { failureCode: 'invalid_json', modelUsage: canonical });
});

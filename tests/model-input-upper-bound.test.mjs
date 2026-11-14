import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretPaper, modelInputTokenUpperBound, SYSTEM_PROMPT } from '../backend/interpret.mjs';

const paper = { title: 'Yeast growth under laboratory conditions', abstract: 'We measured yeast growth in shake flasks.', isPreprint: false, readingScope: 'abstract_only' };
const translated = { titleZh: '实验室条件下的酵母生长', abstractZh: '研究者在摇瓶中测量了酵母生长。', question: null, methods: null, findings: null, limitations: [] };
async function capture(input, baseUrl, model) {
  let body, calls = 0;
  await interpretPaper(input, { baseUrl, model, apiKey: 'private-key-never-in-body', fetchImpl: async (_url, options) => {
    calls++; body = options.body;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(translated) } }] }) };
  } });
  assert.equal(calls, 1);
  assert.equal(body.includes('private-key-never-in-body'), false);
  return body;
}

test('输入上界覆盖实际完整请求JSON字节并留512余量，原请求参数和供应商开关不变', async () => {
  for (const [baseUrl, model, vendor] of [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-flash', true],
    ['https://example.invalid/v1', 'a-longer-generic-fixture-model', false],
  ]) {
    const body = await capture(paper, baseUrl, model), parsed = JSON.parse(body);
    const bound = modelInputTokenUpperBound(paper, model);
    assert.ok(Number.isSafeInteger(bound));
    assert.ok(bound >= Buffer.byteLength(body, 'utf8') + 512);
    assert.equal(bound, Buffer.byteLength(JSON.stringify({ ...parsed, enable_thinking: false }), 'utf8') + 512);
    assert.equal(parsed.model, model);
    assert.equal(parsed.messages[0].content, SYSTEM_PROMPT);
    assert.deepEqual(parsed.response_format, { type: 'json_object' });
    assert.equal(parsed.max_tokens, 6000);
    assert.deepEqual(Object.keys(parsed).sort(), ['model', 'messages', 'response_format', 'max_tokens', ...(vendor ? ['enable_thinking'] : [])].sort());
    assert.equal(Object.hasOwn(parsed, 'enable_thinking'), vendor);
    if (vendor) assert.equal(parsed.enable_thinking, false);
  }
  assert.equal(modelInputTokenUpperBound(paper), modelInputTokenUpperBound(paper, 'qwen3.7-flash'));
});

test('中文及emoji按UTF-8字节计数而非UTF-16字符，完整摘要仍只按原样分段发送一次', async () => {
  const input = { ...paper, title: '🧬 β-丙氨酸与酵母生长', abstract: 'We measured yeast growth. 中文说明与🧬 emoji remain unchanged.\n' };
  const body = await capture(input, 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-flash');
  const parsed = JSON.parse(body), user = JSON.parse(parsed.messages[1].content);
  assert.equal(modelInputTokenUpperBound(input), Buffer.byteLength(body, 'utf8') + 512);
  assert.ok(modelInputTokenUpperBound(input) > body.length + 512);
  assert.equal(user.title, input.title);
  assert.equal(user.abstractSources.map(item => item.text).join(''), input.abstract);
  assert.equal(Object.hasOwn(user, 'abstract'), false);
});

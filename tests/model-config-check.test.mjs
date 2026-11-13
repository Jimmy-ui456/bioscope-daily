import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkModelConfig, modelConfigSummary } from '../scripts/check-model-config.mjs';

const key = 'test-only-secret-never-send';
const env = { LLM_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', LLM_MODEL: 'qwen3.7-flash', LLM_API_KEY: key };
function response(body, status = 200) { return { status, json: async () => body }; }
function success(models = [{ model: env.LLM_MODEL }]) { return { success: true, code: null, output: { models } }; }
function assertSafe(diagnostic) {
  const text = JSON.stringify(diagnostic) + modelConfigSummary(diagnostic);
  assert.equal(text.includes(key), false);
  assert.equal(text.includes('Bearer'), false);
  assert.equal(text.includes('aliyuncs.com'), false);
  assert.equal(text.includes('sensitive-echo'), false);
  assert.deepEqual(Object.keys(diagnostic).sort(), (diagnostic.httpStatus === undefined
    ? ['modelListed', 'status'] : ['httpStatus', 'modelListed', 'status']).sort());
}

test('目录诊断只向北京原生目录发送一次GET，精确筛选目标且禁止重定向', async () => {
  const calls = [], before = structuredClone(env);
  const diagnostic = await checkModelConfig({ env: { ...env, GITHUB_TOKEN: 'never-forward', OPENAI_API_KEY: 'never-use' },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(success()); } });
  assert.deepEqual(diagnostic, { status: 'model_listed', httpStatus: 200, modelListed: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, 'https://dashscope.aliyuncs.com/api/v1/models?model=qwen3.7-flash&page_size=1');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(calls[0].options.headers, { Authorization: `Bearer ${key}`, Accept: 'application/json' });
  assert.equal(Object.hasOwn(calls[0].options, 'body'), false);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(env, before);
  assertSafe(diagnostic);
  assert.match(modelConfigSummary(diagnostic), /不证明生成权限、余额或翻译质量/);
});

test('北京合法单层workspace域及尾斜杠可用于目录查询', async () => {
  for (const base of ['https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', `${env.LLM_BASE_URL}/`]) {
    let origin;
    const diagnostic = await checkModelConfig({ env: { ...env, LLM_BASE_URL: base },
      fetchImpl: async url => { origin = url.origin; return response(success()); } });
    assert.equal(origin, new URL(base).origin);
    assert.equal(diagnostic.status, 'model_listed');
  }
});

test('缺配置、其它内部凭据、非北京域及变形URL均在网络请求前拒绝', async () => {
  let calls = 0;
  const invalidBases = ['', 'http://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://evil.example/compatible-mode/v1', 'https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1',
    'https://dashscope.aliyuncs.com:443/compatible-mode/v1', 'https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1',
    `${env.LLM_BASE_URL}?x=1`, `${env.LLM_BASE_URL}#fragment`, ` ${env.LLM_BASE_URL}`, `${env.LLM_BASE_URL}\n`,
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://x.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    'https://x.y.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'https://-x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'https://x-.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/api/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'];
  const variants = invalidBases.map(base => ({ ...env, LLM_BASE_URL: base }));
  for (const model of ['', ' ', 'qwen3.7-flash?token=secret', 'a'.repeat(129), true]) variants.push({ ...env, LLM_MODEL: model });
  for (const keyValue of ['', ' ', 'sk-value\r\necho', true]) variants.push({ ...env, LLM_API_KEY: keyValue });
  variants.push({ ...env, LLM_API_KEY: undefined, GITHUB_TOKEN: 'internal-only', OPENAI_API_KEY: 'internal-only' });
  for (const config of variants) {
    const diagnostic = await checkModelConfig({ env: config, fetchImpl: async () => { calls++; throw new Error('should never run'); } });
    assert.deepEqual(diagnostic, { status: 'configuration_invalid', modelListed: null });
    assertSafe(diagnostic);
  }
  assert.equal(calls, 0);
});

test('200目录查询区分有无目标，不把HTTP成功当作翻译验收', async () => {
  for (const models of [[], [{ model: 'another-model' }]]) {
    const diagnostic = await checkModelConfig({ env, fetchImpl: async () => response(success(models)) });
    assert.deepEqual(diagnostic, { status: 'model_not_listed', httpStatus: 200, modelListed: false });
    assertSafe(diagnostic);
  }
});

test('HTTP拒绝仅保留状态码，不读取错误body且不自动重试', async () => {
  for (const status of [301, 401, 403, 404, 429, 500]) {
    let calls = 0, bodyReads = 0;
    const diagnostic = await checkModelConfig({ env, fetchImpl: async () => {
      calls++;
      return { status, json: async () => { bodyReads++; throw new Error(key); } };
    } });
    assert.deepEqual(diagnostic, { status: 'http_error', httpStatus: status, modelListed: null });
    assert.equal(calls, 1); assert.equal(bodyReads, 0);
    assertSafe(diagnostic);
  }
});

test('200但provider报告失败、JSON坏或结构未知时不给出已验证结论', async () => {
  const variants = [
    [response({ success: false, code: key, message: 'sensitive-echo' }), 'provider_error'],
    [response(null), 'invalid_response'],
    [response([]), 'invalid_response'],
    [response({ data: success() }), 'invalid_response'],
    [response({ success: 'true', output: { models: [] } }), 'invalid_response'],
    [response({ success: true, output: { models: null } }), 'invalid_response'],
    [response(success([null])), 'invalid_response'],
    [response(success([{ model: 123 }])), 'invalid_response'],
    [{ status: 200, json: async () => { throw new SyntaxError(key + 'sensitive-echo'); } }, 'invalid_json'],
  ];
  for (const [mock, status] of variants) {
    const diagnostic = await checkModelConfig({ env, fetchImpl: async () => mock });
    assert.deepEqual(diagnostic, { status, httpStatus: 200, modelListed: null });
    assertSafe(diagnostic);
  }
});

test('网络及响应体超时的敏感异常不会进入返回或摘要，不重试', async () => {
  let calls = 0;
  const diagnostic = await checkModelConfig({ env, fetchImpl: async () => { calls++; throw new Error(`${key} sensitive-echo`); } });
  assert.deepEqual(diagnostic, { status: 'network_or_timeout', modelListed: null });
  assert.equal(calls, 1); assertSafe(diagnostic);
  const bodyFailure = await checkModelConfig({ env, fetchImpl: async () => ({ status: 200,
    json: async () => { throw new DOMException(`${key} sensitive-echo`, 'AbortError'); } }) });
  assert.deepEqual(bodyFailure, { status: 'network_or_timeout', httpStatus: 200, modelListed: null });
  assertSafe(bodyFailure);
});

test('无效HTTP状态及摘要伪造字段不能透传任意字符串', async () => {
  for (const status of [key, -1, 0, 600, 200.5]) {
    const diagnostic = await checkModelConfig({ env, fetchImpl: async () => ({ status }) });
    assert.deepEqual(diagnostic, { status: 'invalid_response', modelListed: null });
    assertSafe(diagnostic);
  }
  const summary = modelConfigSummary({ status: key, httpStatus: key, modelListed: key, message: 'sensitive-echo' });
  assert.equal(summary.includes(key), false);
  assert.equal(summary.includes('sensitive-echo'), false);
  assert.match(summary, /结构无法识别/);
});

test('CLI缺模型密钥时只输出受控JSON并失败，不读取其它内部密钥', () => {
  const run = spawnSync(process.execPath, ['scripts/check-model-config.mjs'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, ...env, LLM_API_KEY: '', OPENAI_API_KEY: key, GITHUB_TOKEN: key, GITHUB_STEP_SUMMARY: '' },
    timeout: 10000, windowsHide: true,
  });
  assert.equal(run.status, 1);
  assert.deepEqual(JSON.parse(run.stdout), { status: 'configuration_invalid', modelListed: null });
  assert.equal((run.stdout + run.stderr).includes(key), false);
  assert.equal(run.stderr, '');
});

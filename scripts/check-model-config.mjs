import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This checks the native model catalogue, never the text-generation endpoint.
// Reference: https://help.aliyun.com/en/model-studio/list-models
const beijingBase = /^https:\/\/(?:dashscope\.aliyuncs\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com)\/compatible-mode\/v1\/?$/;
const modelId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const statusLabels = Object.freeze({
  configuration_invalid: '配置不完整或不符合本诊断支持的北京地域格式',
  http_error: '目录接口返回非成功HTTP状态',
  network_or_timeout: '目录查询网络失败或超时',
  invalid_json: '目录响应不是有效JSON',
  invalid_response: '目录响应结构无法识别',
  provider_error: '目录接口报告查询失败',
  model_listed: '目录查询成功，本次响应列出目标模型',
  model_not_listed: '目录查询成功，本次响应未列出目标模型',
});
function validHttpStatus(value) { return Number.isInteger(value) && value >= 100 && value <= 599; }
function result(status, httpStatus, modelListed = null) {
  return { status, ...(validHttpStatus(httpStatus) ? { httpStatus } : {}), modelListed };
}

export async function checkModelConfig({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = env.LLM_BASE_URL, model = env.LLM_MODEL, key = env.LLM_API_KEY;
  if (typeof base !== 'string' || !beijingBase.test(base) || typeof model !== 'string' || !modelId.test(model)
    || typeof key !== 'string' || key.length === 0 || key.length > 8192 || /\s/.test(key)) {
    return result('configuration_invalid');
  }
  const endpoint = new URL('/api/v1/models', base);
  endpoint.searchParams.set('model', model);
  endpoint.searchParams.set('page_size', '1');
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
  } catch { return result('network_or_timeout'); }
  const status = response?.status;
  if (!validHttpStatus(status)) return result('invalid_response');
  // Do not parse or expose an error body, which could include echoed secrets.
  if (status < 200 || status >= 300) return result('http_error', status);
  let body;
  try { body = await response.json(); }
  catch (error) { return result(error instanceof SyntaxError ? 'invalid_json' : 'network_or_timeout', status); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return result('invalid_response', status);
  if (body.success === false) return result('provider_error', status);
  const models = body.output?.models;
  if (body.success !== true || !Array.isArray(models)
    || !models.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.model === 'string' && modelId.test(item.model))) return result('invalid_response', status);
  const listed = models.some(item => item.model === model);
  return result(listed ? 'model_listed' : 'model_not_listed', status, listed);
}

export function modelConfigSummary(diagnostic) {
  const status = Object.hasOwn(statusLabels, diagnostic?.status) ? diagnostic.status : 'invalid_response';
  const httpStatus = validHttpStatus(diagnostic?.httpStatus) ? diagnostic.httpStatus : '未取得';
  const listed = diagnostic?.modelListed === true ? '是' : diagnostic?.modelListed === false ? '否' : '未知';
  return [
    '## BioScope 模型配置诊断', '',
    '- 检查类型：仅GET查询百炼模型目录，未请求文本生成。',
    `- 目录查询状态：${statusLabels[status]}`,
    `- HTTP状态：${httpStatus}`,
    `- 本次目录响应是否列出目标模型：${listed}`, '',
    '目录查询不生成文本，不证明生成权限、余额或翻译质量；不修改既有预算和回执，不自动重试。', '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const diagnostic = await checkModelConfig();
  console.log(JSON.stringify(diagnostic));
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { await appendFile(process.env.GITHUB_STEP_SUMMARY, modelConfigSummary(diagnostic), 'utf8'); }
    catch { console.error('配置诊断摘要未写入；未请求文本生成。'); }
  }
  if (diagnostic.status !== 'model_listed') process.exitCode = 1;
}

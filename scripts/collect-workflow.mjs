import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS } from '../dist/core.js';
import { runPipeline } from '../backend/pipeline.mjs';
import { downloadRefreshSummaryLabel, validateDownloadRefreshSummary } from '../dist/enrichment.js';

const knownTopics = new Set(TOPICS.map(topic => topic.name));
function topicName(stat) { return knownTopics.has(stat.topic) ? stat.topic : '未识别方向'; }
function countLabel(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : '未提供'; }

export function workflowCollectionSummary(library, eventName, { translateOne = false, automaticModel = false } = {}) {
  const stats = Array.isArray(library.stats) ? library.stats.filter(stat => stat && typeof stat === 'object') : [];
  const failed = stats.filter(stat => stat.error), completed = stats.filter(stat => !stat.error);
  const eventLabel = eventName === 'schedule' ? '定时采集' : eventName === 'workflow_dispatch' ? '手动补采' : '其他触发';
  const modelPolicy = eventName === 'schedule' ? (automaticModel
    ? '已明确开启自动模型；仅按完整配置和预算运行。'
    : '自动模型已暂停，文献定时采集与发布继续；不向采集器传入模型凭据。') : eventName === 'workflow_dispatch' && translateOne
    ? '本次明确启用单篇模型验收并补采：最多1次请求，仍受当日预算、配置完整性及既有回执限制。'
    : '本次强制禁用模型，不读取模型密钥配置。';
  return {
    failedCount: failed.length, completedCount: completed.length,
    downloadFailedCount: validateDownloadRefreshSummary(library.automation?.downloadRefresh) ? library.automation.downloadRefresh.failed : null,
    markdown: [
      '## BioScope 文献采集', '',
      `- 触发方式：${eventLabel}`,
      `- 本次采集方向：${stats.length} 个`,
      `- 完成方向：${completed.length} 个（${completed.map(topicName).join('、') || '无'}）`,
      `- 失败方向：${failed.length} 个（${failed.map(topicName).join('、') || '无'}）`,
      `- 当前文献库：${Array.isArray(library.papers) ? library.papers.length : '未提供'} 篇`,
      `- 原平台逐篇统计刷新：${downloadRefreshSummaryLabel(library.automation?.downloadRefresh)}`,
      `- 本次模型请求：${countLabel(library.automation?.modelRequestsThisRun)} 次`,
      `- 本次通过校验的模型结果：${countLabel(library.automation?.modelCompletedThisRun)} 篇`,
      `- 本次模型失败或结果未知：${countLabel(library.automation?.modelFailuresThisRun)} 次`,
      `- 模型策略：${modelPolicy}`,
      ...(failed.length ? ['', '部分方向未更新；已保留其他方向及已有文献，后续继续发布本次快照。'] : []),
      '',
    ].join('\n'),
  };
}

export async function runWorkflowCollection({
  env = process.env, eventName = env.GITHUB_EVENT_NAME || '', run = runPipeline,
  appendSummary = appendFile, summaryFile = env.GITHUB_STEP_SUMMARY, warn = console.log,
} = {}) {
  // Ordinary manual and unknown events never inherit model credentials. The
  // opt-in manual check is capped in the pipeline and still performs a real collection.
  const translateOne = eventName === 'workflow_dispatch' && env.BIOSCOPE_TRANSLATE_ONE === 'true';
  const automaticModel = eventName === 'schedule' && env.BIOSCOPE_MODEL_AUTO === 'true';
  const modelEnv = automaticModel || translateOne ? {
    LLM_BASE_URL: env.LLM_BASE_URL || '', LLM_MODEL: env.LLM_MODEL || '', LLM_API_KEY: env.LLM_API_KEY || '',
  } : {};
  if (translateOne && (!modelEnv.LLM_BASE_URL || !modelEnv.LLM_MODEL || !modelEnv.LLM_API_KEY)) {
    warn('::error title=模型配置未完成::单篇验收需要完整模型配置。请添加LLM_API_KEY到仓库Secrets；不要将密钥写入代码或日志。');
    throw new Error('单篇模型验收缺少完整配置');
  }
  const library = await run({ env: modelEnv, ...(translateOne ? { modelRunLimit: 1 } : {}) });
  const summary = workflowCollectionSummary(library, eventName, { translateOne, automaticModel });
  if (summaryFile) {
    try { await appendSummary(summaryFile, summary.markdown, 'utf8'); }
    catch { warn('::warning title=采集摘要未写入::采集结果已保留；无法写入本次运行摘要，后续继续发布。'); }
  }
  if (summary.failedCount) warn(`::warning title=文献采集部分失败::本次有 ${summary.failedCount} 个方向采集失败，${summary.completedCount} 个方向完成；已保留已有文献，后续继续发布。`);
  if (summary.downloadFailedCount > 0) warn(`::warning title=下载统计部分未刷新::有 ${summary.downloadFailedCount} 篇原平台统计请求失败；旧计数及原采集时间保留，文献采集与发布继续。`);
  if (translateOne && (library.automation?.modelRequestsThisRun !== 1 || library.automation?.modelCompletedThisRun !== 1)) {
    warn('::warning title=单篇模型尚未验收通过::本次没有得到恰好1篇通过校验的模型结果，请核对摘要中的实际请求与失败次数、预算或待译条目；已有状态与回执继续保存发布，不自动重复收费。');
  }
  return library;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkflowCollection().catch(() => {
    console.error('文献采集工作流未完成，请检查本次运行日志与上次已保存的快照。');
    process.exitCode = 1;
  });
}

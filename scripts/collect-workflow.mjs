import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS } from '../dist/core.js';
import { runPipeline } from '../backend/pipeline.mjs';

const knownTopics = new Set(TOPICS.map(topic => topic.name));
function topicName(stat) { return knownTopics.has(stat.topic) ? stat.topic : '未识别方向'; }
function countLabel(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : '未提供'; }

export function workflowCollectionSummary(library, eventName) {
  const stats = Array.isArray(library.stats) ? library.stats.filter(stat => stat && typeof stat === 'object') : [];
  const failed = stats.filter(stat => stat.error), completed = stats.filter(stat => !stat.error);
  const eventLabel = eventName === 'schedule' ? '定时采集' : eventName === 'workflow_dispatch' ? '手动补采' : '其他触发';
  const modelPolicy = eventName === 'schedule' ? '仅按既有模型配置运行；未配置则跳过。' : '本次强制禁用模型，不读取模型密钥配置。';
  return {
    failedCount: failed.length, completedCount: completed.length,
    markdown: [
      '## BioScope 文献采集', '',
      `- 触发方式：${eventLabel}`,
      `- 本次采集方向：${stats.length} 个`,
      `- 完成方向：${completed.length} 个（${completed.map(topicName).join('、') || '无'}）`,
      `- 失败方向：${failed.length} 个（${failed.map(topicName).join('、') || '无'}）`,
      `- 当前文献库：${Array.isArray(library.papers) ? library.papers.length : '未提供'} 篇`,
      `- 本次模型请求：${countLabel(library.automation?.modelRequestsThisRun)} 次`,
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
  // An explicit empty environment prevents an accidental Secret (or process env) from
  // authorizing model requests on a manual/unknown event. This entry point never loads .env.
  const modelEnv = eventName === 'schedule' ? {
    LLM_BASE_URL: env.LLM_BASE_URL || '', LLM_MODEL: env.LLM_MODEL || '', LLM_API_KEY: env.LLM_API_KEY || '',
  } : {};
  const library = await run({ env: modelEnv });
  const summary = workflowCollectionSummary(library, eventName);
  if (summaryFile) {
    try { await appendSummary(summaryFile, summary.markdown, 'utf8'); }
    catch { warn('::warning title=采集摘要未写入::采集结果已保留；无法写入本次运行摘要，后续继续发布。'); }
  }
  if (summary.failedCount) warn(`::warning title=文献采集部分失败::本次有 ${summary.failedCount} 个方向采集失败，${summary.completedCount} 个方向完成；已保留已有文献，后续继续发布。`);
  return library;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkflowCollection().catch(() => {
    console.error('文献采集工作流未完成，请检查本次运行日志与上次已保存的快照。');
    process.exitCode = 1;
  });
}

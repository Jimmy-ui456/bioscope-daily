import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBatchTranslation } from '../backend/batch-translation.mjs';
import { PROJECT } from '../backend/pipeline.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function yuan(value) { return Number.isSafeInteger(value) && value >= 0 ? (value / 1000000).toFixed(6) : '未知'; }
export function translationReportHtml(status) {
  const scope = status.scope, budget = status.budget;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>生研观察 · 翻译与费用记录</title><link rel="stylesheet" href="./styles.css"><link rel="stylesheet" href="./enrichment.css"></head><body><main class="setup-main">
<a href="./index.html">← 返回生研观察</a><h1>本次翻译与费用记录</h1>
<p>任务日期：${escape(status.date)}；记录时间：${escape(new Date(status.reportedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}（北京）。</p>
${status.deadlineMet === false ? '<p class="evidence-warning">未在原定北京时间09:30前完成；此页如实记录后续补做结果。</p>' : ''}
<section class="settings-panel"><h2>中英对照覆盖</h2><p>共享库 ${scope.total} 篇；已有中英对照 ${scope.bilingual} 篇；尚缺中文 ${scope.missing} 篇。</p>
<p>本轮模型尝试 ${status.attempts} 次，题名及摘要译文通过基础校验 ${status.passed} 篇，失败或未知 ${status.failed} 次。仅保留译文的条目不视为研究解读通过；所有模型译文仍未经过领域专家审核。</p>
<p>尚未翻译中：缺少英文摘要 ${scope.noAbstract} 篇；已有请求回执阻止重复尝试 ${scope.blockedByReceipt} 篇；输入过长 ${scope.inputTooLarge} 篇。分类可能重叠。</p></section>
<section class="settings-panel"><h2>费用与预算</h2><p><strong>已记录用量的官方原价估算：${yuan(budget.knownCostMicroYuan)} 元。</strong></p>
<p>已记录 ${budget.inputTokens} 个输入、${budget.outputTokens} 个输出 Token；用量未知的保守预留 ${yuan(budget.unknownReservedMicroYuan)} 元；任务上限 ${yuan(budget.budgetMicroYuan)} 元。</p>
<p>这是按模型返回用量计算的原价估算，不是百炼账单或实际扣费。缓存、免费额度及优惠可能降低应付金额。此前未记录Token的两次历史试译不计入已知费用，不能据此认定其免费。</p>
<p>模型：百炼北京 qwen3.7-flash；<a href="https://help.aliyun.com/zh/model-studio/model-pricing">官方价格</a> · <a href="https://help.aliyun.com/zh/model-studio/bill-query-and-cost-management">实际账单核对入口说明</a>。</p></section>
<details><summary>尚缺中文的文献编号（${scope.missing}篇）</summary><ul>${status.remainingPaperIds.map(id => `<li>${escape(id)}</li>`).join('')}</ul></details>
<p><a href="./translation-status.json">下载本次机器可读记录</a></p></main></body></html>`;
}

export async function runTranslationBatch({ env = process.env, root = PROJECT, run = runBatchTranslation, saveReport = writeFile, appendSummary = appendFile } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.BIOSCOPE_BATCH_AUTHORIZED !== 'true') throw new Error('批量翻译需要本次手动明确授权，未调用模型');
  const modelEnv = { LLM_BASE_URL: env.LLM_BASE_URL || '', LLM_MODEL: env.LLM_MODEL || '', LLM_API_KEY: env.LLM_API_KEY || '' };
  const status = await run({ root, env: modelEnv });
  await saveReport(path.join(root, 'dist/translation-report.html'), translationReportHtml(status), 'utf8');
  const summary = `## BioScope 批量翻译\n\n- 中英对照：${status.scope.bilingual}/${status.scope.total} 篇\n- 本轮尝试/通过/失败：${status.attempts}/${status.passed}/${status.failed}\n- 已知用量原价估算：${yuan(status.budget.knownCostMicroYuan)} 元（非账单）\n- 未知用量预留：${yuan(status.budget.unknownReservedMicroYuan)} 元\n- 预算上限：${yuan(status.budget.budgetMicroYuan)} 元\n- 原定截止是否达成：${status.deadlineMet === true ? '是' : status.deadlineMet === false ? '否' : '未知'}\n`;
  if (env.GITHUB_STEP_SUMMARY) await appendSummary(env.GITHUB_STEP_SUMMARY, summary, 'utf8');
  return status;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTranslationBatch().then(status => console.log(JSON.stringify({ scope: status.scope, attempts: status.attempts, passed: status.passed, failed: status.failed, budget: status.budget }))).catch(() => {
    console.error('批量翻译未完成，请检查已保存的请求回执、预算和恢复附件；不要直接重跑未知付费请求。'); process.exitCode = 1;
  });
}

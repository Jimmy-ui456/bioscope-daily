import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDownloadRefreshSummary, downloadRefreshSummaryLabel } from '../dist/enrichment.js';
import { workflowCollectionSummary, runWorkflowCollection } from '../scripts/collect-workflow.mjs';

const summary = { supported: 5, attempted: 4, updated: 2, failed: 1, notAvailable: 1, skipped: 1 };
test('逐篇刷新汇总核对数量恒等式，篇数不冒充下载次数', () => {
  assert.equal(validateDownloadRefreshSummary(summary), true);
  assert.match(downloadRefreshSummaryLabel(summary), /已请求 4 篇/);
  assert.match(downloadRefreshSummaryLabel(summary), /文献篇数，不是下载次数/);
  const zero = Object.fromEntries(Object.keys(summary).map(key => [key, 0]));
  assert.equal(validateDownloadRefreshSummary(zero), true);
  assert.match(downloadRefreshSummaryLabel(zero), /平台记录 0 篇/);
});
test('旧或损坏汇总保持未知，不把缺失字段默认为0', () => {
  for (const value of [undefined, null]) {
    assert.equal(validateDownloadRefreshSummary(value), false);
    assert.match(downloadRefreshSummaryLabel(value), /未记录/);
    assert.ok(!downloadRefreshSummaryLabel(value).includes('0 篇'));
  }
  for (const value of [{}, [], '0', { ...summary, failed: '1' }, { ...summary, failed: -1 },
    { ...summary, attempted: 5 }, { ...summary, supported: 6 }, { ...summary, updated: 1.5 }]) {
    assert.equal(validateDownloadRefreshSummary(value), false);
    assert.match(downloadRefreshSummaryLabel(value), /格式无效/);
  }
});
test('工作流区分文献方向成功与逐篇统计失败，输出受控警告并继续发布', async () => {
  const library = { papers: [], stats: [{ topic: '合成生物学', count: 0 }], automation: { downloadRefresh: { ...summary, rawError: 'private-upstream-message' }, modelRequestsThisRun: 0 } };
  const warnings = [], written = [];
  let calls = 0;
  const result = await runWorkflowCollection({ eventName: 'workflow_dispatch', env: { LLM_API_KEY: 'test-only-never-pass' }, summaryFile: 'offline-summary',
    run: async ({ env }) => { calls++; assert.deepEqual(env, {}); return library; },
    appendSummary: async (_file, text) => written.push(text), warn: value => warnings.push(value) });
  assert.equal(result, library);
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /下载统计部分未刷新/);
  assert.match(written[0], /失败方向：0/);
  assert.match(written[0], /请求失败 1/);
  assert.ok(!JSON.stringify({ warnings, written }).includes('private-upstream-message'));
  assert.ok(!JSON.stringify({ warnings, written }).includes('test-only-never-pass'));
});
test('没有运行级汇总时不虚构下载失败或警告', async () => {
  const library = { papers: [], stats: [], automation: { modelRequestsThisRun: 0 } };
  const output = workflowCollectionSummary(library, 'schedule');
  assert.equal(output.downloadFailedCount, null);
  assert.match(output.markdown, /未记录运行级汇总/);
  const warnings = [];
  await runWorkflowCollection({ eventName: 'workflow_dispatch', run: async () => library, summaryFile: null, warn: text => warnings.push(text) });
  assert.deepEqual(warnings, []);
});

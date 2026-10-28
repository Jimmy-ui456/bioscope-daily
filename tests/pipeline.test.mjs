import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runPipeline, saveJson, readJson } from '../backend/pipeline.mjs';
import { normalizePaper } from '../dist/core.js';
import { sourceFingerprint } from '../dist/enrichment.js';
import { startScheduler } from '../backend/scheduler.mjs';
const base = path.resolve('.cache/test-runs');
const paper = normalizePaper({ id: '1', source: 'MED', doi: '10.1234/test', title: 'A test study', abstractText: 'We engineered yeast and measured growth.', firstPublicationDate: '2026-10-28', pubTypeList: { pubType: ['Journal Article'] } }, 'metabolic');
async function project(t) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'pipeline-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); });
  await saveJson(path.join(root, 'config/monitor.json'), { topics: ['metabolic'], days: 7, maxAnalysesPerRun: 1, maxModelRequestsPerDay: 2 });
  await saveJson(path.join(root, 'dist/sample.json'), { papers: [] });
  return root;
}
const collected = async () => ({ papers: [paper], hitCount: 1, truncated: false });
const env = { LLM_BASE_URL: 'https://model.example/v1', LLM_MODEL: 'test-model', LLM_API_KEY: 'test-only-invalid' };
const now = new Date('2026-10-29T01:00:00Z');
test('未配置模型仍采集并保存，绝不调用付费模型', async t => {
  const root = await project(t);
  const result = await runPipeline({ root, now, env: {}, collect: collected, interpret: () => { throw new Error('must not call'); }, log: () => {} });
  assert.equal(result.papers.length, 1); assert.equal(result.automation.modelStatus, 'not_configured'); assert.equal(result.modelUsage.requests, 0);
});
test('已完成的同一输入不会重复付费', async t => {
  const root = await project(t); let calls = 0;
  const interpret = async p => { calls++; return { titleZh: '测试研究', abstractZh: '对酵母改造并测量生长。', sourceFingerprint: sourceFingerprint(p), origin: 'model' }; };
  await runPipeline({ root, now, env, collect: collected, interpret, log: () => {} });
  const next = await runPipeline({ root, now, env, collect: collected, interpret, log: () => {} });
  assert.equal(calls, 1); assert.equal(next.modelUsage.requests, 1);
});
test('结果不确定的付费请求不自动重复调用', async t => {
  const root = await project(t); let calls = 0;
  const interpret = async () => { calls++; throw new Error('timeout'); };
  await runPipeline({ root, now, env, collect: collected, interpret, log: () => {} });
  const next = await runPipeline({ root, now, env, collect: collected, interpret, log: () => {} });
  assert.equal(calls, 1); assert.equal(Object.values(next.receipts)[0].status, 'failed_or_unknown');
});
test('全部上游失败时保留上次文献库', async t => {
  const root = await project(t); await saveJson(path.join(root, 'dist/library.json'), { papers: [paper], marker: 'retain-me' });
  await assert.rejects(runPipeline({ root, now, env: {}, collect: async () => { throw new Error('offline'); }, log: () => {} }), /全部主题/);
  assert.equal((await readJson(path.join(root, 'dist/library.json'))).marker, 'retain-me');
});

test('日报生成未完成时保留文献和回执，但不提前标为整个后台完成', async t => {
  const root = await project(t);
  await saveJson(path.join(root, 'dist/library.json'), { papers: [], receipts: { past: { status: 'failed_or_unknown', at: now.toISOString() } }, modelUsage: { date: '2026-10-29', requests: 1 } });
  await writeFile(path.join(root, 'dist/public-reports.json'), '{broken');
  await assert.rejects(runPipeline({ root, now, env: {}, collect: collected, log: () => {} }), SyntaxError);
  const saved = await readJson(path.join(root, 'dist/library.json'));
  assert.equal(saved.papers.length, 1);
  assert.ok(saved.automation.lastRunAt);
  assert.equal(saved.automation.completedAt, undefined);
  assert.equal(saved.modelUsage.requests, 1);
  assert.equal(saved.receipts.past.status, 'failed_or_unknown');
});

test('定时任务运行及失败状态不会残留前次完成标志，忙状态可读取', async t => {
  const root = await project(t);
  await saveJson(path.join(root, '.data/scheduler.json'), { completion: 'complete', lastSuccess: '2026-10-28' });
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let rejectRun;
  const scheduler = startScheduler({ root, clock: () => now, run: () => { signalStarted(); return new Promise((_resolve, reject) => { rejectRun = reject; }); }, log: () => {} });
  t.after(() => scheduler.stop());
  const task = scheduler.tick();
  await started;
  assert.equal(scheduler.busy, true);
  assert.equal((await readJson(path.join(root, '.data/scheduler.json'))).completion, 'running');
  rejectRun(new Error('upstream unavailable'));
  await task;
  const saved = await readJson(path.join(root, '.data/scheduler.json'));
  assert.equal(scheduler.busy, false);
  assert.equal(saved.completion, 'failed');
  assert.ok(saved.error);
  assert.equal(saved.lastSuccess, '2026-10-28');
});
test('每日模型调用上限在重复运行之间仍生效', async t => {
  const root = await project(t);
  await saveJson(path.join(root, 'config/monitor.json'), { topics: ['metabolic'], maxAnalysesPerRun: 10, maxModelRequestsPerDay: 1 });
  let calls = 0;
  const collect = async () => ({ papers: [paper, { ...paper, id: 'second', doi: '10.1234/second', pmid: '2', title: 'Second study' }], hitCount: 2 });
  const interpret = async p => { calls++; return { titleZh: '测试', abstractZh: '测试摘要', sourceFingerprint: sourceFingerprint(p), origin: 'model' }; };
  await runPipeline({ root, now, env, collect, interpret, log: () => {} });
  const result = await runPipeline({ root, now, env, collect, interpret, log: () => {} });
  assert.equal(calls, 1); assert.equal(result.modelUsage.requests, 1);
});
test('本地调度器同一北京日成功后不重复补跑', async t => {
  const root = await project(t); let calls = 0;
  const scheduler = startScheduler({ root, clock: () => now, run: async () => { calls++; }, log: () => {} });
  t.after(() => scheduler.stop());
  await scheduler.tick(); await scheduler.tick();
  assert.equal(calls, 1);
});
test('已有辅助译文的论文仍可在配置模型后补充结构化解读', async t => {
  const root = await project(t); let calls = 0;
  await saveJson(path.join(root, 'dist/translations.json'), { items: { [paper.id]: { titleZh: '测试', abstractZh: '测试摘要', sourceFingerprint: sourceFingerprint(paper), origin: 'assistant_translation' } } });
  await runPipeline({ root, now, env, collect: collected, interpret: async p => { calls++; return { titleZh: '测试', abstractZh: '测试摘要', sourceFingerprint: sourceFingerprint(p), origin: 'model' }; }, log: () => {} });
  assert.equal(calls, 1);
});
test('本地部分方向失败时保留结果并按间隔有限重试', async t => {
  const root = await project(t); let calls = 0; let current = new Date(now);
  const scheduler = startScheduler({ root, clock: () => current, run: async () => { calls++; return { automation: { failedTopics: calls === 1 ? 1 : 0 } }; }, log: () => {} });
  t.after(() => scheduler.stop());
  await scheduler.tick(); await scheduler.tick(); assert.equal(calls, 1);
  let status = await readJson(path.join(root, '.data/scheduler.json')); assert.equal(status.completion, 'partial'); assert.equal(status.lastSuccess, undefined);
  current = new Date(now.getTime() + 16 * 60000); await scheduler.tick();
  status = await readJson(path.join(root, '.data/scheduler.json')); assert.equal(calls, 2); assert.equal(status.completion, 'complete'); assert.equal(status.lastSuccess, '2026-10-29');
});

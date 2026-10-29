import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { refreshPublisherMetrics } from '../backend/downloads.mjs';
import { downloadRefreshLabel } from '../dist/enrichment.js';
import { normalizePaper } from '../dist/core.js';
import { runPipeline, saveJson, readJson } from '../backend/pipeline.mjs';

const paper = normalizePaper({ id: 'fixture', source: 'MED', doi: '10.1371/journal.pbio.1234567', title: 'Publisher metric test fixture', abstractText: 'This is an offline test fixture.', firstPublicationDate: '2026-10-29', pubTypeList: { pubType: ['Journal Article'] } }, 'synthetic', '2026-10-29T01:00:00Z');
const metric = { count: 15, kind: 'pdf_downloads', window: 'cumulative', platform: 'PLOS', sourceUrl: 'https://example.org/publisher-statistics', fetchedAt: '2026-10-28T01:00:00Z' };
const checkedAt = '2026-10-29T18:00:00Z';

test('统计刷新失败保留原计数和采集时间，单独记录本次失败，不公开上游异常', async () => {
  const input = [{ ...paper, downloadMetric: metric }];
  const before = structuredClone(input);
  const output = await refreshPublisherMetrics(input, { checkedAt, fetchMetric: async () => { throw new Error('private-upstream-detail'); } });
  assert.deepEqual(output[0].downloadMetric, metric);
  assert.deepEqual(output[0].downloadRefresh, { status: 'failed', checkedAt });
  assert.deepEqual(input, before);
  assert.equal(JSON.stringify(output).includes('private-upstream-detail'), false);
  assert.match(downloadRefreshLabel(output[0]), /请求失败.*保留原先计数/);
  assert.match(downloadRefreshLabel(output[0]), /2026-10-30 02:00/);
});

test('空值或无效新统计不覆盖旧记录，无历史数据时保持未知', async () => {
  for (const next of [null, undefined, { ...metric, count: null }, { ...metric, kind: 'views' }]) {
    const output = await refreshPublisherMetrics([{ ...paper, downloadMetric: metric }, { ...paper, id: 'unknown' }], { checkedAt, fetchMetric: async () => next });
    assert.deepEqual(output[0].downloadMetric, metric);
    assert.equal(output[1].downloadMetric, undefined);
    assert.equal(output[0].downloadRefresh.status, 'not_available');
    assert.match(downloadRefreshLabel(output[1]), /保持未知，不记为0/);
  }
});

test('明确0次是真实新统计，成功刷新可替换旧记录', async () => {
  const next = { ...metric, count: 0, fetchedAt: checkedAt };
  const [output] = await refreshPublisherMetrics([{ ...paper, downloadMetric: metric, downloadRefresh: { status: 'failed', checkedAt: metric.fetchedAt } }], { checkedAt, fetchMetric: async () => next });
  assert.deepEqual(output.downloadMetric, next);
  assert.deepEqual(output.downloadRefresh, { status: 'updated', checkedAt });
  assert.match(downloadRefreshLabel(output), /取得有效原平台统计/);
});

test('下载批次上限只约束支持的平台，未请求不冒充失败或更新', async () => {
  const unsupported = { ...paper, id: 'unsupported', doi: '10.1234/unsupported' };
  const inputs = [unsupported, paper, { ...paper, id: 'second', doi: '10.5281/zenodo.1234567', downloadMetric: metric, downloadRefresh: { status: 'updated', checkedAt } }];
  let calls = 0;
  const output = await refreshPublisherMetrics(inputs, { checkedAt, limit: 1, fetchMetric: async () => { calls++; return metric; } });
  assert.equal(calls, 1);
  assert.equal(output[0], unsupported);
  assert.deepEqual(output[2].downloadRefresh, { status: 'skipped', reason: 'batch_limit' });
  assert.deepEqual(output[2].downloadMetric, metric);
  assert.match(downloadRefreshLabel(output[2]), /此篇未请求/);
});

test('旧快照或损坏的刷新元数据不虚构本次成功、不导致页面崩溃', () => {
  for (const downloadRefresh of [undefined, null, [], 'updated', { status: {} }, { status: 'updated' }, { status: 'failed', checkedAt: {} }, { status: 'updated', checkedAt }]) {
    assert.equal(downloadRefreshLabel({ ...paper, downloadRefresh }), '');
  }
});

test('后台将统计失败状态保存到公开快照但不误报为文献采集失败', async t => {
  const base = path.resolve('.cache/test-runs');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'download-refresh-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); });
  await saveJson(path.join(root, 'config/monitor.json'), { topics: ['synthetic'] });
  await saveJson(path.join(root, 'dist/sample.json'), { papers: [] });
  await saveJson(path.join(root, 'dist/library.json'), { papers: [{ ...paper, downloadMetric: metric }] });
  const result = await runPipeline({ root, env: {}, sourceEnv: {}, now: new Date(checkedAt), collect: async () => ({ papers: [paper], hitCount: 1, truncated: false }), fetchMetric: async () => { throw new Error('private-statistics-error'); }, interpret: () => { throw new Error('No model request allowed'); }, log: () => {} });
  const saved = await readJson(path.join(root, 'dist/library.json'));
  assert.equal(result.automation.failedTopics, 0);
  assert.ok(result.automation.completedAt);
  assert.equal(result.automation.modelRequestsThisRun, 0);
  assert.equal(saved.papers[0].downloadRefresh.status, 'failed');
  assert.deepEqual(saved.papers[0].downloadMetric, metric);
  assert.equal(JSON.stringify(saved).includes('private-statistics-error'), false);
});

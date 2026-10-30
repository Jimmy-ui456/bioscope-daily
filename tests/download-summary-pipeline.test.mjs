import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizePaper } from '../dist/core.js';
import { refreshPublisherMetrics, summarizePublisherRefresh } from '../backend/downloads.mjs';
import { runPipeline, saveJson, readJson } from '../backend/pipeline.mjs';

const now = new Date('2026-10-30T04:00:00Z');
const oldMetric = { count: 271, kind: 'pdf_downloads', platform: 'PLOS', window: 'cumulative', sourceUrl: 'https://journals.plos.org/plosone/', fetchedAt: '2026-10-29T00:00:00Z', provenance: 'publisher_api' };
const freshMetric = { ...oldMetric, count: 0, fetchedAt: '2026-10-30T04:00:00Z' };
const emptySummary = { supported: 0, attempted: 0, updated: 0, failed: 0, notAvailable: 0, skipped: 0 };
function paper(index, doi = `10.1371/journal.pone.${String(index).padStart(7, '0')}`) {
  return { ...normalizePaper({ id: String(index), source: 'MED', doi, title: `Paper ${String(index).padStart(2, '0')}`, abstractText: 'We measured growth in shake flasks.', firstPublicationDate: '2026-10-29', pubTypeList: { pubType: ['Journal Article'] } }, 'synthetic', now.toISOString()), downloadMetric: { ...oldMetric } };
}
function assertTotals(summary) {
  assert.equal(summary.attempted, summary.updated + summary.failed + summary.notAvailable);
  assert.equal(summary.supported, summary.attempted + summary.skipped);
}

test('真实刷新结果按支持文献篇数汇总，覆盖更新/失败/无数据/批次跳过且不增加请求', async () => {
  const unsupported = { ...paper(90, '10.1234/unsupported'), downloadRefresh: { status: 'unknown-old-status' } };
  const inputs = [unsupported, paper(1), paper(2, '10.5281/zenodo.2'), paper(3, '10.1371/JOURNAL.pone.0000003'), paper(4, '10.5281/zenodo.4')];
  const before = structuredClone(inputs), calls = [];
  const refreshed = await refreshPublisherMetrics(inputs, { limit: 3, checkedAt: now.toISOString(), fetchMetric: async candidate => {
    calls.push(candidate.id);
    if (candidate.id === inputs[2].id) throw new Error('private-upstream-error');
    return candidate.id === inputs[1].id ? freshMetric : null;
  } });
  const refreshedBeforeSummary = structuredClone(refreshed);
  const summary = summarizePublisherRefresh(refreshed);
  assert.deepEqual(summary, { supported: 4, attempted: 3, updated: 1, failed: 1, notAvailable: 1, skipped: 1 });
  assertTotals(summary);
  assert.deepEqual(calls, inputs.slice(1, 4).map(candidate => candidate.id));
  assert.deepEqual(refreshed[1].downloadMetric, freshMetric);
  for (const candidate of refreshed.slice(2)) assert.deepEqual(candidate.downloadMetric, oldMetric);
  assert.deepEqual(inputs, before);
  assert.deepEqual(refreshed, refreshedBeforeSummary);
  assert.equal(JSON.stringify(refreshed).includes('private-upstream-error'), false);
});

test('旧/损坏的支持记录返回未知汇总，不把缺状态当跳过或把无效更新当成功', () => {
  const candidate = paper(1);
  for (const downloadRefresh of [undefined, null, [], 'updated', {}, { status: 'unknown' }, { status: 'skipped' }, { status: 'skipped', reason: 'unknown' }, { status: 'updated' }, { status: 'failed' }, { status: 'not_available', checkedAt: 0 }, { status: 'failed', checkedAt: '2026-02-30T12:00:00Z' }]) {
    assert.equal(summarizePublisherRefresh([{ ...candidate, downloadRefresh }]), null);
  }
  assert.equal(summarizePublisherRefresh([{ ...candidate, downloadMetric: null, downloadRefresh: { status: 'updated', checkedAt: now.toISOString() } }]), null);
  const { downloadMetric: _metric, ...missingMetric } = candidate;
  assert.equal(summarizePublisherRefresh([{ ...missingMetric, downloadRefresh: { status: 'updated' } }]), null);
  assert.deepEqual(summarizePublisherRefresh([]), emptySummary);
  assert.deepEqual(summarizePublisherRefresh([{ ...candidate, doi: '10.1234/unsupported', downloadRefresh: { status: 'unknown' } }]), emptySummary);
});

async function project(t, papers) {
  const base = path.resolve('.cache/test-runs');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'download-summary-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); });
  await saveJson(path.join(root, 'config/monitor.json'), { topics: ['synthetic'], days: 7, maxPapers: 500 });
  await saveJson(path.join(root, 'dist/sample.json'), { papers: [] });
  await saveJson(path.join(root, 'dist/library.json'), { papers, modelUsage: { date: '2026-10-30', requests: 0 }, receipts: {}, automation: { downloadRefresh: { supported: 99, attempted: 99, updated: 99, failed: 0, notAvailable: 0, skipped: 0 } } });
  return root;
}

test('pipeline保存本次实际汇总，保留失败/无数据/跳过的旧计数和采集时间，模型请求仍为0', async t => {
  const inputs = Array.from({ length: 22 }, (_, index) => paper(index));
  const root = await project(t, inputs), calls = [];
  let modelCalls = 0;
  const result = await runPipeline({ root, now, env: {}, sourceEnv: {},
    collect: async () => ({ papers: [], hitCount: 0, truncated: false }),
    fetchMetric: async candidate => {
      calls.push(candidate.id);
      if (candidate.id === inputs[1].id) throw new Error('private-pipeline-error');
      if (candidate.id === inputs[2].id) return null;
      return { ...freshMetric, count: candidate.id === inputs[0].id ? 0 : 5 };
    },
    interpret: async () => { modelCalls++; throw new Error('Model must not run'); }, log: () => {},
  });
  const expected = { supported: 22, attempted: 20, updated: 18, failed: 1, notAvailable: 1, skipped: 2 };
  assert.deepEqual(result.automation.downloadRefresh, expected);
  assertTotals(result.automation.downloadRefresh);
  assert.equal(calls.length, 20);
  assert.equal(new Set(calls).size, 20);
  assert.equal(modelCalls, 0);
  assert.equal(result.automation.modelRequestsThisRun, 0);
  assert.equal(result.modelUsage.requests, 0);
  const saved = await readJson(path.join(root, 'dist/library.json'));
  assert.deepEqual(saved.automation.downloadRefresh, expected);
  for (const index of [1, 2, 20, 21]) assert.deepEqual(saved.papers.find(candidate => candidate.id === inputs[index].id).downloadMetric, oldMetric);
  assert.equal(saved.papers.find(candidate => candidate.id === inputs[0].id).downloadMetric.count, 0);
  assert.equal(saved.papers.find(candidate => candidate.id === inputs[0].id).downloadMetric.fetchedAt, freshMetric.fetchedAt);
  assert.equal(JSON.stringify(saved).includes('private-pipeline-error'), false);
});

test('没有支持平台的pipeline保存六项0，不发下载请求或模型请求', async t => {
  const root = await project(t, [paper(1, '10.1234/not-supported')]);
  let calls = 0, models = 0;
  const result = await runPipeline({ root, now, env: {}, sourceEnv: {},
    collect: async () => ({ papers: [], hitCount: 0, truncated: false }),
    fetchMetric: async () => { calls++; throw new Error('No supported record'); },
    interpret: async () => { models++; throw new Error('No model configured'); }, log: () => {},
  });
  assert.deepEqual(result.automation.downloadRefresh, emptySummary);
  assert.deepEqual((await readJson(path.join(root, 'dist/library.json'))).automation.downloadRefresh, emptySummary);
  assert.equal(calls, 0); assert.equal(models, 0);
  assert.deepEqual(result.papers[0].downloadMetric, oldMetric);
});

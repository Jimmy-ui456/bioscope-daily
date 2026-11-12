import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshPublisherMetrics, summarizePublisherRefresh } from '../backend/downloads.mjs';

const time = '2026-11-12T15:00:00.000Z';
const later = '2026-11-13T00:00:00.000Z';
const metric = { count: 17, kind: 'pdf_downloads', window: 'cumulative', platform: 'PLOS',
  sourceUrl: 'https://example.org/publisher-statistics', fetchedAt: '2026-11-10T01:00:00Z' };
const paper = (index, fields = {}) => ({ id: `paper-${index}`, doi: `10.1371/journal.pbio.${1000000 + index}`, ...fields });

test('超过20篇时跨轮优先从未尝试和最久未尝试的记录，输出仍按原论文顺序', async () => {
  let current = Array.from({ length: 41 }, (_, index) => paper(index + 1));
  const initial = structuredClone(current);
  const batches = [];
  for (const checkedAt of [time, later, '2026-11-14T00:00:00.000Z']) {
    const input = current;
    const before = structuredClone(input);
    const calls = [];
    current = await refreshPublisherMetrics(input, { checkedAt, fetchMetric: async value => { calls.push(value.id); return null; } });
    assert.deepEqual(input, before);
    assert.deepEqual(before.map(value => value.id), current.map(value => value.id));
    assert.equal(calls.length, 20);
    assert.deepEqual(summarizePublisherRefresh(current), { supported: 41, attempted: 20, updated: 0, failed: 0, notAvailable: 20, skipped: 21 });
    batches.push(calls);
  }
  assert.deepEqual(batches[0], initial.slice(0, 20).map(value => value.id));
  assert.deepEqual(batches[1], initial.slice(20, 40).map(value => value.id));
  assert.deepEqual(batches[2], [initial[40].id, ...initial.slice(0, 19).map(value => value.id)]);
  assert.equal(new Set(batches.flat()).size, 41);
});

test('接口失败和未返回有效统计也记录真实尝试，下一轮不会挤掉尚未尝试的记录', async () => {
  const inputs = [paper(1, { downloadMetric: metric }), paper(2, { downloadMetric: metric }), paper(3)];
  const before = structuredClone(inputs);
  const first = await refreshPublisherMetrics(inputs, { checkedAt: time, limit: 2, fetchMetric: async value => {
    if (value.id === 'paper-1') throw new Error('private-upstream-error');
    return null;
  } });
  assert.deepEqual(inputs, before);
  assert.equal(first[0].downloadRefresh.status, 'failed');
  assert.equal(first[1].downloadRefresh.status, 'not_available');
  assert.equal(first[0].downloadRefreshLastAttemptAt, time);
  assert.equal(first[1].downloadRefreshLastAttemptAt, time);
  assert.equal(first[2].downloadRefreshLastAttemptAt, undefined);
  assert.deepEqual(first[0].downloadMetric, metric);
  assert.deepEqual(first[1].downloadMetric, metric);
  assert.equal(JSON.stringify(first).includes('private-upstream-error'), false);
  const calls = [];
  const second = await refreshPublisherMetrics(first, { checkedAt: later, limit: 1,
    fetchMetric: async value => { calls.push(value.id); return { ...metric, count: 0, fetchedAt: later }; } });
  assert.deepEqual(calls, ['paper-3']);
  assert.equal(second[0].downloadRefreshLastAttemptAt, time);
  assert.equal(second[1].downloadRefreshLastAttemptAt, time);
  assert.equal(second[2].downloadRefreshLastAttemptAt, later);
  assert.equal(second[2].downloadMetric.count, 0);
  assert.deepEqual(summarizePublisherRefresh(second), { supported: 3, attempted: 1, updated: 1, failed: 0, notAvailable: 0, skipped: 2 });
});

test('limit0不发请求，旧刷新时间迁移后在连续跳过中保留，不借指标采集时间推定尝试', async () => {
  const inputs = [
    paper(1, { downloadMetric: metric, downloadRefresh: { status: 'updated', checkedAt: time } }),
    paper(2, { downloadRefresh: { status: 'failed', checkedAt: time } }),
    paper(3, { downloadRefreshLastAttemptAt: time, downloadRefresh: { status: 'skipped', reason: 'batch_limit' } }),
    paper(4, { downloadMetric: metric }),
  ];
  const before = structuredClone(inputs);
  const neverFetch = async () => { throw new Error('limit0 must not request'); };
  let output = await refreshPublisherMetrics(inputs, { checkedAt: later, limit: 0, fetchMetric: neverFetch });
  output = await refreshPublisherMetrics(output, { checkedAt: later, limit: 0, fetchMetric: neverFetch });
  assert.deepEqual(inputs, before);
  for (const value of output.slice(0, 3)) {
    assert.equal(value.downloadRefreshLastAttemptAt, time);
    assert.deepEqual(value.downloadRefresh, { status: 'skipped', reason: 'batch_limit' });
  }
  assert.equal(output[3].downloadRefreshLastAttemptAt, undefined);
  assert.deepEqual(output[0].downloadMetric, metric);
  assert.deepEqual(output[3].downloadMetric, metric);
  assert.deepEqual(summarizePublisherRefresh(output), { supported: 4, attempted: 0, updated: 0, failed: 0, notAvailable: 0, skipped: 4 });
});

test('旧记录按checkedAt实际时刻轮换，新持久字段优先，时区不按字符串顺序比较', async () => {
  const inputs = [
    paper(1, { downloadRefreshLastAttemptAt: later, downloadRefresh: { status: 'failed', checkedAt: '2026-11-01T00:00:00Z' } }),
    paper(2, { downloadRefresh: { status: 'not_available', checkedAt: '2026-11-12T23:30:00+08:00' } }),
    paper(3, { downloadRefresh: { status: 'failed', checkedAt: '2026-11-12T16:00:00Z' } }),
  ];
  const calls = [];
  const output = await refreshPublisherMetrics(inputs, { checkedAt: '2026-11-14T00:00:00Z', limit: 1,
    fetchMetric: async value => { calls.push(value.id); return null; } });
  assert.deepEqual(calls, ['paper-2']);
  assert.equal(output[0].downloadRefreshLastAttemptAt, later);
  assert.equal(output[2].downloadRefreshLastAttemptAt, '2026-11-12T16:00:00Z');
});

test('非法历史时间按从未确认尝试处理，不因日期自动归一或指标时间排到后面', async () => {
  const bad = [null, {}, [], 'later', '2026-11-12', '2026-02-30T00:00:00Z', '2026-11-12T24:00:00Z', '2026-11-12T01:00:00'];
  for (const value of bad) {
    const inputs = [paper(1, { downloadRefreshLastAttemptAt: '2000-01-01T00:00:00Z' }),
      paper(2, { downloadRefreshLastAttemptAt: value, downloadMetric: metric, downloadRefresh: { status: 'failed', checkedAt: value } })];
    const calls = [];
    const output = await refreshPublisherMetrics(inputs, { checkedAt: time, limit: 1,
      fetchMetric: async item => { calls.push(item.id); return null; } });
    assert.deepEqual(calls, ['paper-2'], JSON.stringify(value));
    assert.equal(output[1].downloadRefreshLastAttemptAt, time);
    assert.deepEqual(output[1].downloadMetric, metric);
  }
});

test('非法新字段仍能迁移旧合法尝试；没有真实历史的skipped不会虚构尝试', async () => {
  const output = await refreshPublisherMetrics([
    paper(1, { downloadRefreshLastAttemptAt: {}, downloadRefresh: { status: 'failed', checkedAt: time } }),
    paper(2, { downloadRefreshLastAttemptAt: [], downloadRefresh: { status: 'skipped', reason: 'batch_limit', checkedAt: time } }),
  ], { checkedAt: later, limit: 0 });
  assert.equal(output[0].downloadRefreshLastAttemptAt, time);
  assert.equal(Object.hasOwn(output[1], 'downloadRefreshLastAttemptAt'), false);
});

test('非法本次时间在任何网络请求前拒绝，unsupported仍不消耗批次上限', async () => {
  for (const checkedAt of ['2026-02-30T00:00:00Z', '2026-11-12', {}, '2026-11-12T00:00:00']) {
    let calls = 0;
    await assert.rejects(refreshPublisherMetrics([paper(1)], { checkedAt, fetchMetric: async () => { calls++; return null; } }), /尝试时间无效/);
    assert.equal(calls, 0);
  }
  const unsupported = { id: 'unsupported', doi: '10.1234/unsupported', downloadRefreshLastAttemptAt: '1999-01-01T00:00:00Z' };
  const calls = [];
  const output = await refreshPublisherMetrics([unsupported, paper(1)], { checkedAt: time, limit: 1,
    fetchMetric: async value => { calls.push(value.id); return null; } });
  assert.deepEqual(calls, ['paper-1']);
  assert.equal(output[0], unsupported);
  assert.deepEqual(summarizePublisherRefresh(output), { supported: 1, attempted: 1, updated: 0, failed: 0, notAvailable: 1, skipped: 0 });
});

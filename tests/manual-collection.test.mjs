import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaper } from '../dist/core.js';
import { manualCollectionOutcome } from '../dist/manual-collection.js';
import { snapshotDirections } from '../dist/snapshot-coverage.js';

const at = '2026-11-20T05:00:00Z';
const previous = '2026-11-19T05:00:00Z';
const paper = (id, firstPublicationDate = '2026-11-19') =>
  normalizePaper({ id, source: 'PMC', title: `Test ${id}`, firstPublicationDate }, 'synthetic', at);
const topics = [{ name: '方向甲' }, { name: '方向乙' }];
const existing = paper('existing');
const current = { origin: 'live', papers: [existing], updatedAt: previous };
const result = (papers, extra = {}) => ({ status: 'fulfilled', value: { papers, hitCount: papers.length, truncated: false, ...extra } });
const rejection = { status: 'rejected', reason: new Error('raw credential or upstream detail') };

test('所有方向均有后续分页中断时保留已取得论文，来源行仍标注部分完成', () => {
  const first = paper('new');
  const interrupted = result([first], { truncated: true, hitCount: 60, interrupted: 'Europe PMC 连接失败或超时' });
  const outcome = manualCollectionOutcome(topics, [interrupted, interrupted], current, at);
  assert.equal(outcome.patch.updatedAt, at);
  assert.equal(outcome.received, 1);
  assert.equal(outcome.retained, 1);
  assert.deepEqual(new Set(outcome.patch.papers.map(p => p.id)), new Set([existing.id, first.id]));
  assert.deepEqual(outcome.incomplete, topics.map(topic => topic.name));
  assert.deepEqual(snapshotDirections(outcome.stats).map(row => row.status), ['partial', 'partial']);
  assert.equal(current.updatedAt, previous);
});

test('全部失败不生成更新补丁，真实零条、分页上限和失败仍有独立状态', () => {
  const allFailed = manualCollectionOutcome(topics, [rejection, rejection], current, at);
  assert.equal(allFailed.patch, null);
  assert.equal(allFailed.received, null);
  assert.equal(allFailed.retained, null);
  assert.deepEqual(current.papers, [existing]);
  assert.equal(current.updatedAt, previous);
  assert.ok(allFailed.stats.every(stat => stat.error === '文献采集失败'));
  const zeroAndFailure = manualCollectionOutcome(topics, [result([]), rejection], current, at);
  assert.equal(zeroAndFailure.patch.updatedAt, at);
  assert.equal(zeroAndFailure.received, 0);
  assert.deepEqual(zeroAndFailure.incomplete, [topics[1].name]);
  assert.deepEqual(snapshotDirections(zeroAndFailure.stats).map(row => row.status), ['complete', 'failed']);
  const capped = manualCollectionOutcome(topics, [result([paper('new')], { truncated: true, hitCount: 60 })], current, at);
  assert.deepEqual(capped.incomplete, []);
  assert.equal(snapshotDirections(capped.stats)[0].status, 'capped');
});

test('报告取得的去重篇数以及当前文献库滚动上限内保留的实际篇数', () => {
  const existing = Array.from({ length: 500 }, (_, i) => paper(`p-${i}`));
  const recent = paper('recent', '2026-11-20');
  const old = paper('old', '2026-11-01');
  const outcome = manualCollectionOutcome(topics, [result([recent, old])], { ...current, papers: existing }, at);
  assert.equal(outcome.received, 2);
  assert.equal(outcome.retained, 1);
  assert.equal(outcome.patch.papers.length, 500);
  assert.equal(outcome.patch.papers[0].id, recent.id);
});

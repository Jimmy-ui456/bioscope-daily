import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotCoverage, snapshotDirections } from '../dist/snapshot-coverage.js';

const now = new Date('2026-11-20T01:00:00Z');
const paper = (id, discoveredAt, doi = null) => ({ id, discoveredAt, doi, title: id, topics: [] });

test('快照覆盖按北京日期和保存时刻核对有效首次发现，保留真实零值', () => {
  const library = { fetchedAt: '2026-11-20T00:30:00Z', papers: [
    paper('yesterday', '2026-11-19T15:59:59Z'), paper('today', '2026-11-19T16:00:00Z'),
    paper('same-date-after-snapshot', '2026-11-20T00:31:00Z'),
    paper('invalid', '2026-11-19'), paper('year-old', '2025-11-19T00:00:00Z'),
  ] };
  assert.deepEqual(snapshotCoverage(library, now), {
    asOf: library.fetchedAt, total: 5, days: [{ date: '2026-11-20', count: 1 }, { date: '2026-11-19', count: 1 }],
  });
  assert.deepEqual(snapshotCoverage({ ...library, papers: [] }, now).days, [
    { date: '2026-11-20', count: 0 }, { date: '2026-11-19', count: 0 },
  ]);
  assert.deepEqual(snapshotCoverage({ ...library, fetchedAt: '2026-11-19T15:59:59Z' }, now).days, [
    { date: '2026-11-20', count: null }, { date: '2026-11-19', count: 1 },
  ]);
  for (const fetchedAt of [undefined, '2026-02-30T00:00:00Z', '2026-11-20']) {
    const invalid = snapshotCoverage({ ...library, fetchedAt }, now);
    assert.equal(invalid.total, 5);
    assert.equal(invalid.asOf, null);
    assert.ok(invalid.days.every(({ count }) => count === null));
  }
  assert.equal(snapshotCoverage(null, now).total, null);
  const future = snapshotCoverage({ ...library, fetchedAt: '2026-11-20T01:01:00Z' }, now);
  assert.ok(future.days.every(({ count }) => count === null));
});

test('共享快照只按自己的去重记录统计，不纳入个人导入、筛选结果或方向计数', () => {
  const doi = '10.1234/example';
  const library = { fetchedAt: now.toISOString(), papers: [
    paper('same-study-first', '2026-11-19T15:00:00Z', doi),
    paper('same-study-later', '2026-11-20T00:00:00Z', doi.toUpperCase()),
  ], stats: [{ topic: '方向一', count: 7 }, { topic: '方向二', count: 8 }],
  personalPapers: [paper('personal-copy', '2026-11-20T00:00:00Z', doi), paper('personal-only', '2026-11-20T00:00:00Z')],
  filteredPapers: [] };
  const result = snapshotCoverage(library, now);
  assert.equal(result.total, 1);
  assert.deepEqual(result.days.map(({ count }) => count), [0, 1]);
  assert.equal(snapshotCoverage({ ...library, papers: [null, {}, { id: 'sparse' }] }, now).total, 1);
});

test('采集方向区分命中、取得和状态，分页中断优先于达到上限', () => {
  assert.deepEqual(snapshotDirections([
    { topic: 'a', hitCount: 125, count: 50, truncated: true },
    { topic: 'b', hitCount: 90, count: 18, truncated: true, error: '分页中断' },
    { topic: 'c', hitCount: 0, count: 0, truncated: false },
    { topic: 'd', hitCount: '90', count: -1, truncated: false },
    { topic: 'e', error: '连接失败' },
    { topic: 'f', hitCount: 12, count: 9 },
    { topic: 'g', hitCount: 60, count: 0, truncated: true, error: '分页中断' },
  ]).map(({ hits, received, status }) => [hits, received, status]), [
    [125, 50, 'capped'], [90, 18, 'partial'], [0, 0, 'complete'], [null, null, 'unknown'], [null, null, 'failed'], [12, 9, 'unknown'], [60, 0, 'failed'],
  ]);
});

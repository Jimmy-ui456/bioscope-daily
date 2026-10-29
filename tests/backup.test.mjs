import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBackupImport, sharedLibraryPapers } from '../dist/backup.js';
import { normalizePaper } from '../dist/core.js';

const now = new Date('2026-10-30T02:00:00Z');
function paper(id, date = '2026-10-29') {
  return normalizePaper({ id, source: 'MED', doi: `10.1234/${id}`, title: `Backup fixture ${id}`,
    abstractText: 'The supplied abstract is retained without additional conclusions.', firstPublicationDate: date,
    pubTypeList: { pubType: ['Journal Article'] } }, 'synthetic', '2026-10-29T00:00:00Z');
}
const existing = paper('existing');
const incoming = paper('incoming');
function report(id, overrides = {}) {
  return { id: `brief-${id}`, date: '2026-10-30', windowStart: '2026-10-24', createdAt: '2026-10-30T01:00:00Z',
    origin: 'live', papers: [incoming], ...overrides };
}
function current(overrides = {}) {
  return { papers: [existing], selected: [], bookmarks: [], reports: [],
    settings: { topics: ['synthetic'], days: 30, reportDays: 7 }, origin: 'live', updatedAt: now.toISOString(), ...overrides };
}
function backup(overrides = {}) {
  return { app: 'bioscope', version: 1, papers: [incoming], selected: [incoming.id], bookmarks: [incoming.id], reports: [], ...overrides };
}

test('坏报告逐项跳过，null或非字符串时间不再中止导入；准备阶段不改输入', () => {
  const state = current({ reports: [report(1, { papers: [existing] })] });
  const valid = report(2);
  const invalid = [null, [], false, 'not-a-report', report(3, { createdAt: ['2026-10-30T01:00:00Z'] }),
    report(4, { createdAt: 0 }), report(5, { createdAt: '' }), report(6, { createdAt: 'not-a-time' }),
    report(7, { createdAt: '2026-02-30T01:00:00Z' }), report(8, { date: '2026-02-30' }),
    report(9, { windowStart: '2026-13-40' }), report(10, { windowStart: '2026-10-31' }),
    report(11, { papers: [{ ...incoming, topics: ['unknown'] }] })];
  const data = backup({ reports: [...invalid, valid] });
  const before = structuredClone({ state, data });
  const prepared = prepareBackupImport(state, data, { now });
  assert.equal(prepared.skippedReports, invalid.length);
  assert.equal(prepared.patch.papers.length, 2);
  assert.deepEqual(prepared.patch.selected, [incoming.id]);
  assert.deepEqual(prepared.patch.bookmarks, [incoming.id]);
  assert.deepEqual(prepared.patch.reports.map(item => item.id).sort(), ['brief-1', 'brief-2']);
  assert.equal(prepared.patch.origin, 'sample');
  assert.equal(prepared.patch.updatedAt, now.toISOString());
  assert.deepEqual({ state, data }, before);
});

test('主备份校验或后续准备失败时，原文献、收藏、精选和报告均未改变', () => {
  const state = current({ selected: [existing.id], bookmarks: [existing.id], reports: [report(1)] });
  const before = structuredClone(state);
  for (const data of [null, [], backup({ version: 2 }), backup({ papers: [{ ...incoming, publishedAt: '2026-02-30' }] }), backup({ papers: Array(501).fill(incoming) })]) {
    assert.throws(() => prepareBackupImport(state, data, { now }), /备份|文献/);
    assert.deepEqual(state, before);
  }
  const data = backup();
  const original = structuredClone(data);
  assert.throws(() => prepareBackupImport(state, data, { now: new Date(NaN) }), RangeError);
  assert.deepEqual(state, before);
  assert.deepEqual(data, original);
});

test('沿用DOI/PMID去重映射，保留已有收藏并只导入备份库中存在的ID', () => {
  const alias = { ...existing, id: 'other-source', doi: 'https://doi.org/10.1234/EXISTING' };
  const state = current({ selected: [existing.id], bookmarks: [existing.id] });
  const data = backup({ papers: [alias, incoming], selected: [alias.id, incoming.id, 'absent'], bookmarks: [alias.id, 'absent', 4] });
  const before = structuredClone({ state, data });
  const { patch } = prepareBackupImport(state, data, { now });
  assert.equal(patch.papers.length, 2);
  assert.deepEqual(patch.selected, [existing.id, incoming.id]);
  assert.deepEqual(patch.bookmarks, [existing.id]);
  assert.deepEqual({ state, data }, before);
});

test('同ID既有快照优先，保留冻结原文与证据，时间按真实先后排序且不改原字符串', () => {
  const frozen = report(1, { papers: [{ ...existing, enrichment: { origin: 'model', findings: { text: '原快照', evidence: existing.abstract } } }], createdAt: '2026-10-29T22:30:00-04:00' });
  const data = backup({ reports: [report(1, { papers: [incoming] }), report(2, { createdAt: '2026-10-30T08:00:00+08:00' })] });
  const state = current({ reports: [frozen] });
  const before = structuredClone({ state, data });
  const { patch } = prepareBackupImport(state, data, { now });
  assert.deepEqual(patch.reports.map(item => item.id), ['brief-1', 'brief-2']);
  assert.equal(patch.reports[0], frozen);
  assert.equal(patch.reports[0].createdAt, '2026-10-29T22:30:00-04:00');
  assert.equal(patch.reports[1].createdAt, '2026-10-30T08:00:00+08:00');
  assert.deepEqual({ state, data }, before);
});

test('文献500条、报告14期及每期10篇上限继续生效', () => {
  const state = current({ papers: Array.from({ length: 500 }, (_, index) => paper(`old-${index}`)) });
  const papers = Array.from({ length: 500 }, (_, index) => paper(`new-${index}`, '2026-10-30'));
  const reports = Array.from({ length: 20 }, (_, index) => report(index, { papers: papers.slice(0, 12), createdAt: `2026-10-30T01:${String(index).padStart(2, '0')}:00Z` }));
  const { patch, skippedReports } = prepareBackupImport(state, backup({ papers, reports }), { now });
  assert.equal(skippedReports, 0);
  assert.equal(patch.papers.length, 500);
  assert.ok(patch.papers.every(item => item.publishedAt === '2026-10-30'));
  assert.equal(patch.reports.length, 14);
  assert.equal(patch.reports[0].id, 'brief-19');
  assert.ok(patch.reports.every(item => item.papers.length === 10));
});

test('有效备份设置沿用原导入规则，无有效方向则保留当前设置', () => {
  const state = current();
  const { patch } = prepareBackupImport(state, backup({ settings: { topics: ['metabolic', 'metabolic', 'bad'], days: '14', reportDays: '30' }, updatedAt: '2026-10-30T08:00:00+08:00' }), { now });
  assert.deepEqual(patch.settings, { topics: ['metabolic'], days: 14, reportDays: 30 });
  assert.equal(patch.updatedAt, '2026-10-30T08:00:00+08:00');
  for (const settings of [null, {}, { topics: ['bad'] }]) {
    const unchanged = prepareBackupImport(state, backup({ settings, updatedAt: ['2026-10-30T08:00:00+08:00'] }), { now });
    assert.equal(unchanged.patch.settings, state.settings);
    assert.equal(unchanged.patch.updatedAt, now.toISOString());
  }
});

test('生成时间仅接受有明确时区的完整ISO时间，拒绝数字字符串、歧义日期和本地时间', () => {
  const invalidTimes = ['0', '02/30/2026', '2026-10-30', '2026-10-30T01:00:00',
    '2026-10-30 01:00:00', '2026-02-30T01:00:00Z', '2026-10-30T24:00:00Z'];
  const state = current();
  for (const createdAt of invalidTimes) {
    const prepared = prepareBackupImport(state, backup({ reports: [report(1, { createdAt })], updatedAt: createdAt }), { now });
    assert.equal(prepared.skippedReports, 1, createdAt);
    assert.deepEqual(prepared.patch.reports, []);
    assert.equal(prepared.patch.updatedAt, now.toISOString());
  }
  for (const createdAt of ['2026-10-30T01:00:00Z', '2026-10-30T01:00:00.123Z',
    '2026-10-30T09:00:00+08:00', '2026-10-29T21:00:00-04:00']) {
    const prepared = prepareBackupImport(state, backup({ reports: [report(1, { createdAt })], updatedAt: createdAt }), { now });
    assert.equal(prepared.skippedReports, 0, createdAt);
    assert.equal(prepared.patch.reports[0].createdAt, createdAt);
    assert.equal(prepared.patch.updatedAt, createdAt);
  }
});

test('备份准备后持久缓存再合并共享库，独有导入论文和收藏旧ID仍然可用', () => {
  const importedOnly = paper('imported-only');
  const sharedPaper = paper('shared');
  const alias = { ...sharedPaper, id: 'restored-old-id' };
  const data = backup({ papers: [importedOnly, alias], selected: [alias.id], bookmarks: [importedOnly.id, alias.id] });
  const prepared = prepareBackupImport(current({ papers: [] }), data, { now });
  assert.equal(prepared.patch.containsImported, true);
  const cache = JSON.parse(JSON.stringify({ papers: prepared.patch.papers, origin: prepared.patch.origin,
    containsImported: prepared.patch.containsImported, updatedAt: prepared.patch.updatedAt }));
  const before = structuredClone(cache);
  const restored = sharedLibraryPapers(cache, [sharedPaper, paper('new-shared')]);
  const ids = new Set(restored.map(item => item.id));
  assert.equal(restored.length, 3);
  assert.ok(ids.has(importedOnly.id));
  assert.ok(ids.has(alias.id));
  assert.ok(!ids.has(sharedPaper.id));
  assert.ok(prepared.patch.bookmarks.every(id => ids.has(id)));
  assert.ok(prepared.patch.selected.every(id => ids.has(id)));
  assert.deepEqual(cache, before);
});

test('普通样本缓存不混入共享采集库，只有live或严格true的导入标记参与', () => {
  for (const containsImported of [undefined, false, 'true', 1]) {
    assert.deepEqual(sharedLibraryPapers({ origin: 'sample', containsImported, papers: [existing] }, [incoming]).map(item => item.id), [incoming.id]);
  }
  assert.equal(sharedLibraryPapers({ origin: 'live', papers: [existing] }, [incoming]).length, 2);
  assert.equal(sharedLibraryPapers({ origin: 'sample', containsImported: true, papers: [existing] }, [incoming]).length, 2);
  assert.deepEqual(sharedLibraryPapers(null, [incoming]).map(item => item.id), [incoming.id]);
});

test('恢复缓存逐篇排除坏记录，不改变缓存或共享数据', () => {
  const cache = { origin: 'sample', containsImported: true, papers: [null, {},
    { ...existing, topics: 'synthetic' }, { ...existing, publishedAt: '2026-02-30' },
    { ...existing, url: 'javascript:invalid' }, existing] };
  const shared = [incoming];
  const before = structuredClone({ cache, shared });
  const papers = sharedLibraryPapers(cache, shared);
  assert.equal(papers.length, 2);
  assert.deepEqual(new Set(papers.map(item => item.id)), new Set([existing.id, incoming.id]));
  assert.deepEqual({ cache, shared }, before);
});

test('导入缓存与共享库恢复合并仍受500条上限约束', () => {
  const cache = { origin: 'sample', containsImported: true,
    papers: Array.from({ length: 500 }, (_, index) => paper(`cached-${index}`)) };
  const shared = Array.from({ length: 500 }, (_, index) => paper(`shared-${index}`, '2026-10-30'));
  const papers = sharedLibraryPapers(cache, shared);
  assert.equal(papers.length, 500);
  assert.ok(papers.every(item => item.publishedAt === '2026-10-30'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaper } from '../dist/core.js';
import { readLocalReaderState, persistLocalRecovery, persistReaderPresets, persistReadMarks, persistPaperReferences, readerPresetSnapshot } from '../dist/local-state.js';
import { readMarkFor } from '../dist/read-progress.js';
import { indexPaperReferences, togglePaperReference } from '../dist/paper-references.js';

const prefix = 'bioscope.v1.';
function paper(id = 'fixture') {
  return normalizePaper({ id, source: 'MED', doi: `10.1234/${id}`, title: `Local fixture ${id}`,
    abstractText: 'Original abstract retained without rewriting.', firstPublicationDate: '2026-11-12',
    pubTypeList: { pubType: ['Journal Article'] } }, 'synthetic', '2026-11-12T03:00:00Z');
}
function report(id = '1', overrides = {}) {
  return { id: `brief-${id}`, date: '2026-11-12', windowStart: '2026-11-06', createdAt: '2026-11-12T03:00:00Z',
    origin: 'live', papers: [paper()], ...overrides };
}
function fakeStorage(values = {}, options = {}) {
  const data = new Map(Object.entries(values).map(([key, value]) => [prefix + key, typeof value === 'string' && options.raw ? value : JSON.stringify(value)]));
  const reads = [], writes = [];
  return { data, reads, writes,
    getItem(key) { reads.push(key); if (options.failRead?.includes(key.slice(prefix.length))) throw new Error('private read detail'); return data.get(key) ?? null; },
    setItem(key, value) { if (options.failWrite?.includes(key.slice(prefix.length))) throw new Error('private quota detail'); writes.push([key, value]); data.set(key, value); },
  };
}

for (const key of ['bookmarks', 'selected']) {
  test(`${key} 的旧标签页保存不会覆盖新记录，可在刷新后按别名取消`, () => {
    const storage = fakeStorage();
    const first = readLocalReaderState(storage), second = readLocalReaderState(storage);
    const record = paper('123456');
    const alias = 'pmid:' + record.pmid;
    assert.deepEqual(first[key], []);
    const firstResult = persistPaperReferences(storage, key, [alias, 'unbound'], first.rawRecords[key] ?? null);
    assert.equal(firstResult.status, 'saved');
    assert.equal(persistPaperReferences(storage, key, [record.id], second.rawRecords[key] ?? null).status, 'changed');
    const refreshed = readLocalReaderState(storage);
    const removed = togglePaperReference(refreshed[key], record.id, indexPaperReferences([record]));
    assert.equal(persistPaperReferences(storage, key, removed, refreshed.rawRecords[key]).status, 'saved');
    assert.deepEqual(readLocalReaderState(storage)[key], ['unbound']);
  });
  test(`${key} 保存保护异常记录并报告读取或配额失败，恢复后可以保存`, () => {
    const storage = fakeStorage({ [key]: ['valid', null] });
    const state = readLocalReaderState(storage);
    assert.equal(persistPaperReferences(storage, key, ['new'], state.rawRecords[key], {
      protectedKeys: new Set(state.protectedKeys),
    }).status, 'protected');
    assert.deepEqual(storage.writes, []);
    assert.deepEqual(persistLocalRecovery(storage, state, state).saved, [key]);
    assert.equal(persistPaperReferences(storage, key, ['valid', 'new'], JSON.stringify(state[key])).status, 'saved');
    for (const opts of [{ failWrite: [key] }, { failRead: [key] }]) {
      const blocked = fakeStorage({}, opts);
      assert.equal(persistPaperReferences(blocked, key, ['new'], null).status, 'failed');
      assert.deepEqual(blocked.writes, []);
    }
  });
}

test('新访客仅启动时读取本机记录，旧库缺少搜索预设时使用空列表且不告警', () => {
  const storage = fakeStorage();
  const state = readLocalReaderState(storage);
  assert.deepEqual(state.settings, { topics: ['synthetic', 'metabolic', 'microbial'], days: 30, reportDays: 7 });
  assert.deepEqual(state.readerFilters, { journal: 'all', days: 0, kind: 'all', abstract: 'all', dateBasis: 'published', progress: 'all' });
  assert.deepEqual(state.bookmarks, []); assert.deepEqual(state.selected, []); assert.deepEqual(state.reports, []);
  assert.deepEqual(state.readerPresets, []);
  assert.equal(state.cache, null); assert.equal(state.displayMode, 'bilingual');
  assert.deepEqual(state.issues, []); assert.deepEqual(state.protectedKeys, []);
  assert.equal(storage.reads.length, 10); assert.deepEqual(storage.writes, []);
  assert.deepEqual(state.readMarks, []);
  assert.deepEqual(Object.keys(state.rawRecords), []);
});

test('旧版精细筛选和预设补齐阅读进度，异常进度保留原记录', () => {
  const old = structuredClone(savedPreset);
  delete old.readerFilters.progress;
  const storage = fakeStorage({ readerFilters: old.readerFilters, readerPresets: [old] });
  const migrated = readLocalReaderState(storage);
  assert.equal(migrated.readerFilters.progress, 'all');
  assert.equal(migrated.readerPresets[0].readerFilters.progress, 'all');
  assert.deepEqual(migrated.protectedKeys, []);
  assert.deepEqual(storage.writes, []);
  const read = { ...old, readerFilters: { ...old.readerFilters, progress: 'read' } };
  assert.deepEqual(readerPresetSnapshot(read), read);
  assert.equal(readerPresetSnapshot({ ...read, readerFilters: { ...read.readerFilters, progress: 'invalid' } }), null);
});

test('已读标记恢复保护原记录，跨标签页和存储失败时不覆盖原记录', () => {
  const mark = readMarkFor(paper());
  const storage = fakeStorage({ readMarks: [mark, {}] });
  const state = readLocalReaderState(storage);
  assert.deepEqual(state.readMarks, [mark]);
  assert.deepEqual(state.protectedKeys, ['readMarks']);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(persistLocalRecovery(storage, state, state).saved, ['readMarks']);
  const current = readLocalReaderState(storage);
  assert.equal(persistReadMarks(storage, [], null).status, 'changed');
  assert.equal(persistReadMarks(storage, [], current.rawRecords.readMarks).status, 'saved');
  assert.deepEqual(readLocalReaderState(storage).readMarks, []);
  const full = fakeStorage({}, { failWrite: ['readMarks'] });
  assert.equal(persistReadMarks(full, [mark], null).status, 'failed');
  assert.deepEqual(full.writes, []);
});

const savedPreset = {
  id: 'preset-1', name: '测试 <阅读>', search: '示例 doi:10.1234/paper', topic: 'metabolic', filter: 'translated',
  readerFilters: { journal: 'Unavailable & Journal', days: 90, kind: 'review', abstract: 'available', dateBasis: 'discovered', progress: 'all' },
};

test('附原文引文筛选可保存和恢复为搜索预设', () => {
  const preset = { ...savedPreset, filter: 'cited' };
  assert.deepEqual(readerPresetSnapshot(preset), preset);
  assert.deepEqual(readLocalReaderState(fakeStorage({ readerPresets: [preset] })).readerPresets, [preset]);
});

test('搜索预设保留完整筛选快照和当前库不存在的期刊，后续状态变化不修改快照', () => {
  const current = structuredClone(savedPreset);
  const snapshot = readerPresetSnapshot(current);
  current.search = ''; current.filter = 'all'; current.readerFilters.days = 0; current.readerFilters.journal = 'all';
  assert.deepEqual(snapshot, savedPreset);
  const storage = fakeStorage();
  const result = persistReaderPresets(storage, [snapshot], null);
  assert.equal(result.status, 'saved');
  assert.deepEqual(readLocalReaderState(storage).readerPresets, [savedPreset]);
  assert.deepEqual(persistReaderPresets(storage, [], result.raw).status, 'saved');
  assert.deepEqual(readLocalReaderState(storage).readerPresets, []);
});

test('本机搜索预设跳过无效或重复项，保护原记录并允许明确恢复', () => {
  const malformed = { ...savedPreset, id: 'preset-2', readerFilters: { ...savedPreset.readerFilters, days: '90' } };
  const storage = fakeStorage({ readerPresets: [savedPreset, malformed, { ...savedPreset, id: 'preset-3' }] });
  const recovered = readLocalReaderState(storage);
  assert.deepEqual(recovered.readerPresets, [savedPreset]);
  assert.deepEqual(recovered.protectedKeys, ['readerPresets']);
  assert.equal(storage.data.get(prefix + 'readerPresets'), recovered.rawRecords.readerPresets);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(persistLocalRecovery(storage, recovered, recovered).saved, ['readerPresets']);
  assert.deepEqual(readLocalReaderState(storage).protectedKeys, []);
  assert.equal(readerPresetSnapshot({ ...savedPreset, filter: 'invalid' }), null);
  assert.equal(readerPresetSnapshot({ ...savedPreset, name: 'x'.repeat(61) }), null);
  assert.equal(readerPresetSnapshot({ ...savedPreset, search: 'x'.repeat(2001) }), null);
});

test('搜索预设报告存储阻塞和其他标签页修改，不写入过期内容', () => {
  const blockedRead = fakeStorage({}, { failRead: ['readerPresets'] });
  const blockedWrite = fakeStorage({}, { failWrite: ['readerPresets'] });
  assert.deepEqual(readLocalReaderState(blockedRead).protectedKeys, ['readerPresets']);
  assert.equal(persistReaderPresets(blockedRead, [savedPreset], null).status, 'failed');
  assert.equal(persistReaderPresets(blockedWrite, [savedPreset], null).status, 'failed');
  const newer = fakeStorage({ readerPresets: [savedPreset] });
  assert.equal(persistReaderPresets(newer, [], null).status, 'changed');
  assert.deepEqual(newer.writes, []);
});

test('有效本机记录完整恢复，合法未知编号不因文献暂未载入而删除，兼容字符串数字', () => {
  const p = paper();
  const values = { settings: { topics: ['metabolic'], days: '14', reportDays: '30' },
    cache: { papers: [p], origin: 'sample', containsImported: true, updatedAt: '2026-11-12T11:00:00+08:00',
      stats: [{ topic: '代谢工程', count: 4, hitCount: 12, truncated: true }, { topic: '合成生物学', error: '旧请求失败' }] },
    readerFilters: { journal: 'Example', days: '7', kind: 'review', abstract: 'available', dateBasis: 'discovered', progress: 'all' },
    bookmarks: [p.id, 'doi:10.1234/not-currently-loaded'], selected: [p.id], reports: [report()], displayMode: 'en' };
  const before = structuredClone(values), storage = fakeStorage(values), rawBefore = [...storage.data];
  const state = readLocalReaderState(storage);
  assert.deepEqual(state.settings, { topics: ['metabolic'], days: 14, reportDays: 30 });
  assert.deepEqual(state.bookmarks, values.bookmarks); assert.deepEqual(state.selected, values.selected);
  assert.deepEqual(state.cache.papers, [p]); assert.equal(state.cache.containsImported, true);
  assert.deepEqual(state.cache.stats[1], { topic: '合成生物学', count: null, hitCount: null, truncated: null, error: '旧请求失败' });
  assert.deepEqual(state.readerFilters, { journal: 'Example', days: 7, kind: 'review', abstract: 'available', dateBasis: 'discovered', progress: 'all' });
  assert.deepEqual(state.reports, values.reports); assert.equal(state.displayMode, 'en');
  assert.deepEqual(state.issues, []); assert.deepEqual(state.protectedKeys, []);
  assert.deepEqual(values, before); assert.deepEqual([...storage.data], rawBefore); assert.deepEqual(storage.writes, []);
});

test('损坏JSON和不可读存储独立降级，保留原串且告警不包含原文或异常', () => {
  const secret = '{private-content-not-json';
  const storage = fakeStorage({ bookmarks: secret, selected: '["kept"]' }, { raw: true, failRead: ['reports'] });
  const state = readLocalReaderState(storage);
  assert.deepEqual(state.bookmarks, []); assert.deepEqual(state.selected, ['kept']); assert.deepEqual(state.reports, []);
  assert.ok(state.protectedKeys.includes('bookmarks')); assert.ok(state.protectedKeys.includes('reports'));
  assert.equal(state.rawRecords.bookmarks, secret); assert.equal(Object.hasOwn(state.rawRecords, 'reports'), false);
  assert.equal(JSON.stringify(state.issues).includes('private'), false);
  assert.equal(storage.data.get(prefix + 'bookmarks'), secret); assert.deepEqual(storage.writes, []);
});

test('对象数值、错误顶层及原型相关键不能触发隐式Number转换或污染原型', () => {
  const storage = fakeStorage({ settings: '{"days":{"toString":"broken"},"reportDays":[],"topics":["metabolic","bad"],"__proto__":{"polluted":true}}',
    readerFilters: '{"days":{"valueOf":"broken","toString":"broken"},"kind":null,"journal":{},"abstract":false}',
    selected: '{}', bookmarks: 'false', reports: '{}', displayMode: '{}' }, { raw: true });
  const state = readLocalReaderState(storage);
  assert.equal(state.settings.days, 30); assert.equal(state.settings.reportDays, 7); assert.deepEqual(state.settings.topics, ['metabolic']);
  assert.deepEqual(state.readerFilters, { journal: 'all', days: 0, kind: 'all', abstract: 'all', dateBasis: 'published', progress: 'all' });
  assert.deepEqual(state.bookmarks, []); assert.deepEqual(state.selected, []); assert.deepEqual(state.reports, []);
  assert.equal(state.displayMode, 'bilingual'); assert.equal({}.polluted, undefined);
  assert.equal(state.protectedKeys.length, 6); assert.equal(Object.getPrototypeOf(state.rawRecords), null);
  assert.deepEqual(storage.writes, []);
});

test('编号数组过滤坏项并去重，字符串列表不作子串精选，原存储仍保持', () => {
  const values = { bookmarks: ['kept', null, 3, {}, '', ' ', 'kept', 'not-loaded'], selected: 'doi:10.1234/long-suffix' };
  const storage = fakeStorage(values), before = [...storage.data];
  const state = readLocalReaderState(storage);
  assert.deepEqual(state.bookmarks, ['kept', 'not-loaded']); assert.deepEqual(state.selected, []);
  assert.deepEqual(new Set(state.protectedKeys), new Set(['bookmarks', 'selected']));
  assert.deepEqual([...storage.data], before);
});

test('离线缓存逐篇恢复并严格处理来源、导入标志、时间和统计，全部坏paper时允许样本兜底', () => {
  const p = paper();
  const storage = fakeStorage({ cache: { papers: [null, {}, { ...p, topics: null }, p], origin: 'unknown', containsImported: 'true', updatedAt: 1234,
    stats: [null, { topic: 'known', count: 3, hitCount: 8, truncated: false }, { topic: 'unknown-counts' }, { topic: 'bad', count: -1 }, { topic: 'bad-type', hitCount: {} }] } });
  const state = readLocalReaderState(storage);
  assert.deepEqual(state.cache.papers, [p]); assert.equal(state.cache.origin, 'sample'); assert.equal(state.cache.containsImported, false);
  assert.equal(state.cache.updatedAt, null);
  assert.deepEqual(state.cache.stats, [{ topic: 'known', count: 3, hitCount: 8, truncated: false }, { topic: 'unknown-counts', count: null, hitCount: null, truncated: null }]);
  assert.ok(state.protectedKeys.includes('cache'));
  assert.equal(readLocalReaderState(fakeStorage({ cache: { papers: [null], origin: 'live' } })).cache, null);
  const empty = readLocalReaderState(fakeStorage({ cache: { papers: [], origin: 'live' } }));
  assert.deepEqual(empty.cache.papers, []); assert.deepEqual(empty.issues, []);
  const missingOrigin = readLocalReaderState(fakeStorage({ cache: { papers: [p] } }));
  assert.equal(missingOrigin.cache.origin, 'sample'); assert.ok(missingOrigin.protectedKeys.includes('cache'));
});

test('缓存超过500篇仅在内存限量，异常日历与不明确时区不作为有效更新时间', () => {
  const storage = fakeStorage({ cache: { papers: Array.from({ length: 502 }, (_, i) => paper(String(i))), origin: 'live',
    updatedAt: '2026-02-30T00:00:00Z', stats: {} } });
  const raw = storage.data.get(prefix + 'cache'), state = readLocalReaderState(storage);
  assert.equal(state.cache.papers.length, 500); assert.equal(state.cache.updatedAt, null); assert.deepEqual(state.cache.stats, []);
  assert.ok(state.protectedKeys.includes('cache')); assert.equal(storage.data.get(prefix + 'cache'), raw);
  for (const updatedAt of ['2026-11-12', '2026-11-12T03:00:00', '2026-11-12T24:00:00Z', {}]) {
    const restored = readLocalReaderState(fakeStorage({ cache: { papers: [paper()], origin: 'sample', updatedAt } }));
    assert.equal(restored.cache.updatedAt, null); assert.ok(restored.protectedKeys.includes('cache'));
  }
});

test('个人日报坏期整期排除，保留冻结原文并按实际生成时间排序，最多14期', () => {
  const first = report('1', { createdAt: '2026-11-12T09:00:00+08:00' });
  const latest = report('2', { createdAt: '2026-11-12T02:00:00Z' });
  const bad = [null, [], {}, report('3', { createdAt: '2026-02-30T00:00:00Z' }), report('4', { createdAt: '2026-11-12T03:00:00' }),
    report('5', { date: '2026-02-30' }), report('6', { windowStart: '2026-11-13' }), report('7', { papers: [paper(), null] }),
    report('8', { id: 'public-daily-2026-11-12' }), report('9', { papers: [{ ...paper(), title: '' }] }),
    report('10', { papers: Array(11).fill(paper()) }), report('11', { origin: 'unknown' }), report('12', { kind: 'public_daily' })];
  const storage = fakeStorage({ reports: [first, ...bad, latest] }), raw = storage.data.get(prefix + 'reports');
  const state = readLocalReaderState(storage);
  assert.deepEqual(state.reports, [latest, first]); assert.ok(state.protectedKeys.includes('reports'));
  assert.equal(storage.data.get(prefix + 'reports'), raw);
  const history = Array.from({ length: 17 }, (_, i) => report(String(i), { createdAt: `2026-11-12T03:${String(i).padStart(2, '0')}:00Z` }));
  const capped = readLocalReaderState(fakeStorage({ reports: history }));
  assert.equal(capped.reports.length, 14); assert.equal(capped.reports[0].id, 'brief-16'); assert.ok(capped.protectedKeys.includes('reports'));
  const legacy = report(); delete legacy.origin;
  const restored = readLocalReaderState(fakeStorage({ reports: [legacy] }));
  assert.equal(restored.reports[0].origin, 'sample'); assert.ok(restored.protectedKeys.includes('reports'));
});

test('显式恢复只写用户提供安全值的受保护七键，原始输入不变', () => {
  const storage = fakeStorage({ selected: '{}', bookmarks: '[null]', displayMode: '"en"' }, { raw: true });
  const read = readLocalReaderState(storage), values = { selected: ['kept'], bookmarks: [], displayMode: 'bilingual' };
  const options = { protectedKeys: [...read.protectedKeys, 'unknown-key'], rawRecords: read.rawRecords };
  const before = structuredClone({ values, protectedKeys: options.protectedKeys, rawRecords: Object.entries(options.rawRecords) });
  const result = persistLocalRecovery(storage, values, options);
  assert.deepEqual(result, { saved: ['bookmarks', 'selected'], failed: [], changed: [] });
  assert.equal(storage.data.get(prefix + 'displayMode'), '"en"'); assert.equal(storage.writes.length, 2);
  assert.deepEqual({ values, protectedKeys: options.protectedKeys, rawRecords: Object.entries(options.rawRecords) }, before);
});

test('其他标签页改值或初读失败后出现数据时拒绝覆盖，保存失败只影响该键', () => {
  const storage = fakeStorage({ selected: '{}', bookmarks: '[null]', reports: '{}' }, { raw: true, failWrite: ['reports'] });
  const read = readLocalReaderState(storage);
  storage.data.set(prefix + 'selected', '["newer-tab-choice"]');
  const result = persistLocalRecovery(storage, { selected: [], bookmarks: [], reports: [] }, read);
  assert.deepEqual(result, { saved: ['bookmarks'], failed: ['reports'], changed: ['selected'] });
  assert.equal(storage.data.get(prefix + 'selected'), '["newer-tab-choice"]');
  assert.equal(storage.data.get(prefix + 'reports'), '{}');
  const unknown = persistLocalRecovery(storage, { settings: {} }, { protectedKeys: ['settings'], rawRecords: {} });
  assert.deepEqual(unknown.saved, ['settings']);
  const nowPresent = persistLocalRecovery(storage, { settings: {} }, { protectedKeys: ['settings'], rawRecords: {} });
  assert.deepEqual(nowPresent.changed, ['settings']);
});

test('显式恢复的读取失败、缺少安全值和序列化错误不泄漏异常或写坏记录', () => {
  const storage = fakeStorage({ selected: '{}', bookmarks: '{}', reports: '{}' }, { raw: true, failRead: ['selected'] });
  const circular = {}; circular.self = circular;
  const result = persistLocalRecovery(storage, { selected: [], reports: circular, settings: undefined },
    { protectedKeys: ['selected', 'bookmarks', 'reports', 'settings'], rawRecords: { selected: '{}', bookmarks: '{}', reports: '{}' } });
  assert.deepEqual(result, { saved: [], failed: ['selected', 'bookmarks', 'reports', 'settings'], changed: [] });
  assert.deepEqual(storage.writes, []); assert.equal(JSON.stringify(result).includes('private'), false);
});

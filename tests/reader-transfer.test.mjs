import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderTransferBlob, readReaderTransferFile, readerTransferFile, prepareReaderTransfer, persistReaderTransfer, READER_TRANSFER_MAX_BYTES } from '../dist/reader-transfer.js';
import { READ_MARK_LIMIT, indexReadMarks, matchingReadMarks } from '../dist/read-progress.js';

const key = name => 'bioscope.v1.' + name;
const preset = { id: 'preset-1', name: 'Café', search: '中文', topic: 'all', filter: 'cited',
  readerFilters: { journal: 'A', days: 7, kind: 'all', abstract: 'available', dateBasis: 'discovered', progress: 'unread' } };
const mark = { id: 'paper-1', doi: '10.1234/example/v1', pmid: '123', fingerprint: 'ab123-123', version: '1' };
const file = (readerPresets = [], readMarks = []) => ({ app: 'bioscope-reader', version: 1, readerPresets, readMarks });
const expectedRaw = (readerPresets = [], readMarks = []) => ({
  readerPresets: readerPresets.length ? JSON.stringify(readerPresets) : null,
  readMarks: readMarks.length ? JSON.stringify(readMarks) : null,
});
const prepare = (data, readerPresets = [], readMarks = []) => prepareReaderTransfer(data, {
  readerPresets, readMarks, expectedRaw: expectedRaw(readerPresets, readMarks),
});
function memory(initial = expectedRaw(), { blocked, quota, onWrite } = {}) {
  const values = new Map(Object.entries(initial).map(([name, raw]) => [key(name), raw]));
  const writes = [];
  return { values, writes,
    getItem(name) { if (name === key(blocked)) throw new Error('blocked'); return values.get(name) ?? null; },
    setItem(name, raw) {
      if (name === key(quota)) throw new Error('quota');
      writes.push(name); values.set(name, raw); onWrite?.(values, name);
    },
  };
}

test('重复导入幂等，同名或同 ID 优先保留已有预设，兼容旧预设的阅读进度', () => {
  const legacy = { ...preset, id: 'new', name: '旧预设', readerFilters: { ...preset.readerFilters } };
  delete legacy.readerFilters.progress;
  const current = [preset];
  const data = file([preset, { ...preset, name: 'other' },
    { ...preset, id: 'same-name', name: ' Cafe\u0301 ' }, legacy, null], [mark]);
  const plan = prepare(data, current);
  assert.deepEqual(plan.readerPresets.counts, { added: 1, repeat: 1, conflict: 2, invalid: 1, overflow: 0 });
  assert.equal(plan.readerPresets.values[0], preset);
  assert.equal(plan.readerPresets.values[1].readerFilters.progress, 'all');
  assert.deepEqual(current, [preset]);
  const repeated = prepare(data, plan.readerPresets.values, [mark]);
  assert.equal(repeated.readerPresets.counts.added, 0);
  assert.equal(repeated.readMarks.counts.repeat, 1);
  const storage = memory(repeated.expectedRaw);
  assert.equal(persistReaderTransfer(storage, repeated, new Set()).outcomes.readMarks.status, 'unchanged');
  assert.deepEqual(storage.writes, []);
});

test('分组超过上限时保留已有数组，已读标记合法别名及原文版本可往返', async () => {
  const presets = Array.from({ length: 30 }, (_, i) => ({ ...preset, id: String(i), name: String(i) }));
  const marks = Array.from({ length: READ_MARK_LIMIT }, (_, i) => ({ ...mark, id: String(i) }));
  const over = prepare(file([preset], [mark]), presets, marks);
  assert.equal(over.readerPresets.counts.overflow, 1);
  assert.equal(over.readMarks.counts.overflow, 1);
  assert.deepEqual(over.readerPresets.values, presets);
  assert.deepEqual(over.readMarks.values, marks);
  const alias = { ...mark, id: 'alias', doi: null };
  const v2 = { ...mark, doi: '10.1234/example/v2', version: '2' };
  const exported = createReaderTransferBlob({ readerPresets: [preset], readMarks: [{ ...mark, abstract: 'private source text' }, alias, v2] });
  const data = await readReaderTransferFile(exported);
  assert.deepEqual(data, file([preset], [mark, alias, v2]));
  const imported = prepare(data);
  assert.equal(imported.readMarks.counts.added, 3);
  const index = indexReadMarks(imported.readMarks.values);
  assert.deepEqual([...matchingReadMarks(index, v2)], [v2]);
  assert.deepEqual([...matchingReadMarks(index, mark)].sort((a,b) => a.id.localeCompare(b.id)), [alias, mark]);
});

test('格式、无效条目、文件导入和导出大小上限彼此独立', async () => {
  for (const invalid of [null, { ...file(), app: 'bioscope' }, { ...file(), version: 2 }, { ...file(), readMarks: {} }]) {
    assert.throws(() => prepare(invalid), /阅读数据 v1/);
  }
  const data = { ...file([null, preset], [null, mark]), papers: ['unrelated'] };
  const plan = prepare(data);
  assert.equal(plan.readerPresets.counts.invalid, 1);
  assert.equal(plan.readMarks.counts.invalid, 1);
  assert.deepEqual(readerTransferFile({ readerPresets: plan.readerPresets.values, readMarks: plan.readMarks.values }), file([preset], [mark]));
  let read = false;
  await assert.rejects(readReaderTransferFile({ size: READER_TRANSFER_MAX_BYTES + 1, text() { read = true; } }), /8 MB/);
  assert.equal(read, false);
  await assert.rejects(readReaderTransferFile(new Blob(['invalid'])), /无法读取 JSON/);
  const many = Array.from({ length: 3000 }, (_, i) => ({ ...mark, id: String(i) + '界'.repeat(1100) }));
  assert.throws(() => createReaderTransferBlob({ readerPresets: [], readMarks: many }), /8 MB/);
});

test('预览后发现任一组跨标签页变更，则两组均不写', () => {
  const plan = prepare(file([preset], [mark]));
  const storage = memory();
  storage.values.set(key('readMarks'), JSON.stringify([mark]));
  assert.deepEqual(persistReaderTransfer(storage, plan, new Set()), { stale: true, outcomes: {} });
  assert.deepEqual(storage.writes, []);
});

test('单组受保护、存储读取或写入失败时，另一组独立保存', () => {
  const plan = prepare(file([preset], [mark]));
  for (const [options, protectedKeys, status] of [
    [{}, ['readMarks'], 'protected'],
    [{ blocked: 'readMarks' }, [], 'failed'],
    [{ quota: 'readMarks' }, [], 'failed'],
  ]) {
    const storage = memory(expectedRaw(), options);
    const result = persistReaderTransfer(storage, plan, new Set(protectedKeys));
    assert.equal(result.outcomes.readerPresets.status, 'saved');
    assert.equal(result.outcomes.readMarks.status, status);
    assert.deepEqual(storage.writes, [key('readerPresets')]);
    assert.equal(storage.values.get(key('readMarks')), null);
  }
});

test('两组之间的跨标签页变化由各自的原始值守卫拦截', () => {
  const plan = prepare(file([preset], [mark]));
  const raw = JSON.stringify([{ ...mark, id: 'another-tab' }]);
  const storage = memory(expectedRaw(), { onWrite: (values, name) => {
    if (name === key('readerPresets')) values.set(key('readMarks'), raw);
  } });
  const result = persistReaderTransfer(storage, plan, new Set());
  assert.equal(result.outcomes.readerPresets.status, 'saved');
  assert.equal(result.outcomes.readMarks.status, 'changed');
  assert.equal(storage.values.get(key('readMarks')), raw);
});

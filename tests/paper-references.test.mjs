import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaper } from '../dist/core.js';
import { prepareBackupImport } from '../dist/backup.js';
import { indexPaperReferences, togglePaperReference } from '../dist/paper-references.js';

const record = normalizePaper({ id: '43062015', source: 'MED', doi: '10.1128/spectrum.01261-26',
  title: 'Shared fixture', firstPublicationDate: '2026-11-22' }, 'synthetic', '2026-11-22T04:00:00Z');

test('旧 PMID 和完整 DOI 唯一映射到当前记录，取消时清除其绑定别名', () => {
  const resolve = indexPaperReferences([record]);
  const refs = ['pmid:43062015', 'doi:10.1128/SPECTRUM.01261-26', 'unbound'];
  assert.equal(resolve(refs[0]), record.id);
  assert.equal(resolve(refs[1]), record.id);
  assert.equal(resolve(refs[2]), null);
  assert.deepEqual(togglePaperReference(refs, record.id, resolve), ['unbound']);
  assert.deepEqual(togglePaperReference(['unbound'], record.id, resolve), ['unbound', record.id]);
  assert.equal(refs.length, 3);
});

test('字面 ID 优先，多个匹配不选，完整 DOI 版本不会被缩短或互换', () => {
  const v1 = { ...record, id: 'v1', doi: '10.1234/item/v1' };
  const v2 = { ...record, id: 'v2', doi: '10.1234/item/v2' };
  const resolve = indexPaperReferences([v1, v2]);
  assert.equal(resolve('pmid:43062015'), null);
  assert.equal(resolve('doi:10.1234/item'), null);
  assert.equal(resolve('doi:10.1234/item/v2'), 'v2');
  assert.equal(indexPaperReferences([{ ...v1, id: 'pmid:43062015' }, v2])('pmid:43062015'), 'pmid:43062015');
  assert.equal(indexPaperReferences([v1, { ...v1, id: 'duplicate' }])('doi:10.1234/item/v1'), null);
});

test('旧备份别名只在该备份自己的记录唯一匹配时导入，通过现有映射保留已有 ID', () => {
  const prior = { ...record, id: 'retained-id' };
  const current = { papers: [prior], selected: [], bookmarks: ['unknown-local'], reports: [], settings: {} };
  const data = { app: 'bioscope', version: 1, papers: [record], selected: ['pmid:43062015'], bookmarks: ['pmid:43062015', 'unbound'] };
  const { patch } = prepareBackupImport(current, data);
  assert.deepEqual(patch.selected, [prior.id]);
  assert.deepEqual(patch.bookmarks, ['unknown-local', prior.id]);
  const ambiguous = prepareBackupImport(current, { ...data, papers: [record, { ...record, id: 'duplicate', doi: '10.1234/conflict' }] });
  assert.deepEqual(ambiguous.patch.selected, []);
  const outside = prepareBackupImport(current, { ...data, papers: [] });
  assert.deepEqual(outside.patch.selected, []);
});

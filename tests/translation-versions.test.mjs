import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranslationCatalog } from '../scripts/build-translations.mjs';
import { attachEnrichment, translationOf, translationVersionKey } from '../dist/enrichment.js';

const first = { id: 'doi:10.1234/versions', doi: '10.1234/versions', pmid: '42', title: 'Original title.', abstract: 'Original abstract with a truncated final sentence' };
const second = { ...first, title: 'Updated original title.', abstract: 'Updated abstract with a complete final sentence.' };
const third = { ...first, abstract: 'A third original abstract that has no translation yet.' };
const oldTime = '2026-10-29T00:00:00+08:00';
const newTime = '2026-10-30T04:00:00Z';
function row(paper, extra = {}) {
  return { doi: paper.doi, paperId: paper.id, sourceTitle: paper.title, sourceAbstract: paper.abstract, titleZh: '辅助中文题名', abstractZh: '辅助中文摘要。', createdAt: oldTime, ...extra };
}
function readTranslation(paper, catalog) { return translationOf(attachEnrichment(paper, catalog.items)); }

test('同一基础ID的新旧原文均可取得各自译文，未知第三版本不误配，时间元数据保留', () => {
  const rows = [row(first, { titleZh: '旧版译文' }), row(second, { titleZh: '新版译文', createdAt: newTime })];
  const before = structuredClone(rows);
  const catalog = buildTranslationCatalog(rows, []);
  assert.equal(catalog.version, 1);
  assert.equal(catalog.paperCount, 1); assert.equal(catalog.sourceVersionCount, 2);
  assert.equal(Object.keys(catalog.items).length, 2);
  assert.equal(catalog.items[first.id].sourceTitle, second.title);
  assert.equal(catalog.items[translationVersionKey(first)].createdAt, oldTime);
  assert.equal(readTranslation(first, catalog).titleZh, '旧版译文');
  assert.equal(readTranslation(second, catalog).titleZh, '新版译文');
  assert.equal(readTranslation(second, catalog).createdAt, newTime);
  assert.equal(readTranslation(third, catalog), null);
  assert.deepEqual(rows, before);
});

test('版本键保留每个旧源，不给只有一个原文版本的其他论文重复建副本', () => {
  const latest = { ...first, title: 'Third source title.', abstract: 'Third source abstract.' };
  const unique = { ...first, id: 'doi:10.1234/unique', doi: '10.1234/unique', title: 'Unique source title.' };
  const catalog = buildTranslationCatalog([
    row(first), row(second, { createdAt: newTime }), row(latest, { createdAt: '2026-10-30T05:00:00Z' }), row(unique),
  ], []);
  assert.equal(catalog.paperCount, 2); assert.equal(catalog.sourceVersionCount, 4);
  for (const paper of [first, second, latest, unique]) assert.ok(readTranslation(paper, catalog));
  assert.equal(catalog.items[translationVersionKey(first)].createdAt, oldTime);
  assert.equal(catalog.items[translationVersionKey(second)].createdAt, newTime);
  assert.equal(Object.hasOwn(catalog.items, translationVersionKey(latest)), false);
  assert.equal(Object.hasOwn(catalog.items, translationVersionKey(unique)), false);
});

test('保留旧记录ID的文献可经DOI或PMID身份别名读取新旧版本', () => {
  const doiCatalog = buildTranslationCatalog([row(first, { titleZh: 'DOI旧版' }), row(second, { titleZh: 'DOI新版' })], []);
  for (const paper of [first, second]) {
    const alias = { ...paper, id: 'pmid:42' };
    assert.equal(readTranslation(alias, doiCatalog).titleZh, paper === first ? 'DOI旧版' : 'DOI新版');
  }
  const pmidCatalog = buildTranslationCatalog([row(first, { paperId: 'pmid:42', titleZh: 'PMID旧版' }), row(second, { paperId: 'pmid:42', titleZh: 'PMID新版' })], []);
  for (const paper of [first, second]) {
    const alias = { ...paper, id: 'epmc:MED:42' };
    assert.equal(readTranslation(alias, pmidCatalog).titleZh, paper === first ? 'PMID旧版' : 'PMID新版');
  }
  assert.equal(pmidCatalog.paperCount, 1); assert.equal(pmidCatalog.sourceVersionCount, 2);
});

test('同源更新中文不增加历史副本，来源提示仅在未显式指定时保留', () => {
  const note = '原接口摘要在句中截断，请核对原文。';
  const catalog = buildTranslationCatalog([row(first, { sourceNote: note }), row(first, { titleZh: '修订中文', createdAt: newTime })], []);
  assert.equal(catalog.paperCount, 1); assert.equal(catalog.sourceVersionCount, 1);
  const translated = readTranslation(first, catalog);
  assert.equal(translated.titleZh, '修订中文'); assert.equal(translated.createdAt, newTime);
  assert.equal(translated.sourceNote, note);
  assert.equal(translated.origin, 'assistant_translation');
  assert.equal(translated.reviewed, false); assert.equal(translated.scope, 'abstract_only');
  const cleared = buildTranslationCatalog([row(first, { sourceNote: note }), row(first, { sourceNote: '' })], []);
  assert.equal(cleared.sourceVersionCount, 1);
  assert.equal(readTranslation(first, cleared).sourceNote, undefined);
});

test('历史源再次成为基础条目时去重版本副本，保留另一原文及其时间', () => {
  const catalog = buildTranslationCatalog([row(first), row(second, { createdAt: newTime }), row(first, { titleZh: '旧源重译', createdAt: '2026-10-30T06:00:00Z' })], []);
  assert.equal(catalog.paperCount, 1); assert.equal(catalog.sourceVersionCount, 2);
  assert.equal(Object.hasOwn(catalog.items, translationVersionKey(first)), false);
  assert.equal(catalog.items[translationVersionKey(second)].createdAt, newTime);
  assert.equal(readTranslation(first, catalog).titleZh, '旧源重译');
  assert.equal(readTranslation(second, catalog).createdAt, newTime);
});

test('原文来源提示跟随完整题名和摘要，不跨版本继承', () => {
  const note = '原接口摘要末尾截断，未补写缺失内容。';
  const catalog = buildTranslationCatalog([row(first, { sourceNote: note }), row(second)], []);
  assert.equal(readTranslation(first, catalog).sourceNote, note);
  assert.equal(readTranslation(second, catalog).sourceNote, undefined);
  assert.equal(readTranslation(third, catalog), null);
  const revisited = buildTranslationCatalog([row(first, { sourceNote: note }), row(second), row(first)], []);
  assert.equal(readTranslation(first, revisited).sourceNote, note);
  assert.equal(readTranslation(second, revisited).sourceNote, undefined);
});

test('旧样本按DOI补原文并保留默认时间，校验规则仍拒绝无效译文/提示/日期', () => {
  const legacy = { doi: first.doi, titleZh: '  保留原译文格式  ', abstractZh: '旧样本译文。' };
  const samples = [first], before = structuredClone(samples);
  const catalog = buildTranslationCatalog([legacy], samples);
  assert.equal(readTranslation(first, catalog).createdAt, oldTime);
  assert.equal(readTranslation(first, catalog).titleZh, legacy.titleZh);
  assert.deepEqual(samples, before);
  assert.throws(() => buildTranslationCatalog([legacy], []), /找不到对应原文/);
  for (const extra of [{ titleZh: '' }, { abstractZh: ' ' }]) assert.throws(() => buildTranslationCatalog([row(first, extra)], []), /辅助译文缺失/);
  for (const sourceNote of [null, {}, 'x'.repeat(1001)]) assert.throws(() => buildTranslationCatalog([row(first, { sourceNote })], []), /来源提示无效/);
  for (const createdAt of [null, 0, '2026-02-30T00:00:00Z', 'not-a-date']) assert.throws(() => buildTranslationCatalog([row(first, { createdAt })], []), /时间无效/);
});

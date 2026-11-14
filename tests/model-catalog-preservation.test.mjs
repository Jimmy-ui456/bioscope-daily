import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranslationCatalog, preserveModelTranslations } from '../scripts/build-translations.mjs';
import { sourceFingerprint, translationVersionKey, attachEnrichment, translationOf } from '../dist/enrichment.js';
const p = { id: 'doi:10.1234/model', title: 'A model paper', abstract: 'A complete original abstract.' };
const model = { titleZh: '模型论文', abstractZh: '完整原文摘要的中文翻译。', sourceTitle: p.title, sourceAbstract: p.abstract,
  sourceFingerprint: sourceFingerprint(p), origin: 'model', reviewed: false, analysisStatus: 'translation_only', modelUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 } };
test('辅助目录重建完整保留已付费模型原文版本及费用/降级元数据', () => {
  const row = { paperId: 'doi:10.1234/manual', sourceTitle: 'Manual source', sourceAbstract: 'Manual abstract', titleZh: '辅助译文', abstractZh: '辅助摘要译文' };
  const before = { items: { [translationVersionKey(p)]: model } }, copy = structuredClone(before);
  const merged = preserveModelTranslations(buildTranslationCatalog([row], []), before);
  assert.deepEqual(merged.items[translationVersionKey(p)], model); assert.deepEqual(before, copy);
  assert.equal(merged.paperCount, 2); assert.equal(merged.sourceVersionCount, 2);
  assert.equal(translationOf(attachEnrichment(p, merged.items)).abstractZh, model.abstractZh);
});
test('新增辅助译文优先同源人工修正，另一个模型原文版本仍保留', () => {
  const changed = { ...p, abstract: 'A changed abstract.' };
  const changedModel = { ...model, sourceAbstract: changed.abstract, sourceFingerprint: sourceFingerprint(changed) };
  const row = { paperId: p.id, sourceTitle: p.title, sourceAbstract: p.abstract, titleZh: '修正后的辅助译文', abstractZh: '修正后的摘要' };
  const merged = preserveModelTranslations(buildTranslationCatalog([row], []), { items: { [translationVersionKey(p)]: model, [translationVersionKey(changed)]: changedModel } });
  assert.equal(translationOf(attachEnrichment(p, merged.items)).titleZh, row.titleZh);
  assert.deepEqual(merged.items[translationVersionKey(changed)], changedModel);
  assert.equal(merged.paperCount, 1); assert.equal(merged.sourceVersionCount, 2);
});
test('损坏的模型绑定或已有目录拒绝覆盖，不能静默丢弃付费结果', () => {
  const catalog = buildTranslationCatalog([], []);
  for (const previous of [null, { items: null }, { items: { [translationVersionKey(p)]: { ...model, sourceFingerprint: 'wrong' } } }]) {
    assert.throws(() => preserveModelTranslations(catalog, previous));
  }
});

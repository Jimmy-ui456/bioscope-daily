import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { attachEnrichment, sourceFingerprint, translationOf } from '../dist/enrichment.js';
import { reportMarkdown } from '../dist/core.js';

const paper = { id: 'source-note-fixture', title: 'Biosensor test fixture', abstract: 'The supplied abstract stops at a threshold of', doi: '10.1234/fixture', topics: ['synthetic'], journal: 'Test fixture', publishedAt: '2026-10-27', status: '预印本', readingScope: '仅摘要', url: 'https://example.org/paper' };
const translation = { titleZh: '测试夹具题名', abstractZh: '接口返回的摘要在阈值处截断……', sourceTitle: paper.title, sourceAbstract: paper.abstract, sourceFingerprint: sourceFingerprint(paper), origin: 'assistant_translation' };
const sourceNote = '原接口摘要在句中截断，末尾阈值无法核对。';

test('同一原文的来源提示在优先采用模型译文时仍保留，且不修改输入', () => {
  const model = { ...translation, titleZh: '模型测试译文', origin: 'model' };
  const catalog = { [paper.id]: { ...translation, sourceNote } };
  const input = { ...paper, enrichment: model };
  const before = structuredClone({ input, catalog });
  const output = attachEnrichment(input, catalog);
  assert.equal(output.enrichment.origin, 'model');
  assert.equal(output.enrichment.sourceNote, sourceNote);
  assert.deepEqual({ input, catalog }, before);
});

test('原文变更后旧来源提示和旧译文一并失效', () => {
  const catalog = { [paper.id]: { ...translation, sourceNote } };
  const changed = { ...paper, abstract: paper.abstract + ' 50 units.' };
  assert.equal(translationOf(attachEnrichment(changed, catalog)), null);
  const newer = { ...translation, sourceAbstract: changed.abstract, sourceFingerprint: sourceFingerprint(changed) };
  const output = attachEnrichment({ ...changed, enrichment: newer }, catalog);
  assert.equal(output.enrichment.sourceNote, undefined);
});

test('来源提示只接受有完整英文锚点的有界字符串', () => {
  for (const invalid of [null, [], {}, 123, ' ', 'a'.repeat(1001)]) {
    const output = attachEnrichment({ ...paper, enrichment: { ...translation, sourceNote: invalid } });
    assert.equal(output.enrichment.sourceNote, undefined);
  }
  const { sourceTitle, sourceAbstract, ...legacy } = translation;
  assert.equal(attachEnrichment({ ...paper, enrichment: { ...legacy, sourceNote } }).enrichment.sourceNote, undefined);
});

test('Markdown保留接口截断提示和实际英文片段，不补出不存在的阈值', () => {
  const report = { date: '2026-10-29', windowStart: '2026-10-23', createdAt: '2026-10-29T00:00:00Z', papers: [paper] };
  const output = reportMarkdown(report, { [paper.id]: { ...translation, sourceNote } });
  assert.ok(output.includes(`原文来源提示：${sourceNote}`));
  assert.ok(output.includes(paper.abstract));
  assert.ok(output.includes(translation.abstractZh));
  assert.ok(!output.includes('50 units'));
});

test('真实截断摘要保留逐字来源及辅助译文状态', async () => {
  const rows = JSON.parse(await readFile(new URL('../config/manual-translations/latest-a-20261029.json', import.meta.url), 'utf8'));
  const truncated = rows.find(row => row.doi === '10.21203/rs.3.rs-11272552/v1');
  assert.match(truncated.sourceAbstract, /single-marker false positives to$/);
  assert.match(truncated.sourceNote, /句中截断/);
  assert.match(truncated.abstractZh, /……$/);
  const catalog = JSON.parse(await readFile(new URL('../dist/translations.json', import.meta.url), 'utf8'));
  const enriched = Object.values(catalog.items).find(item => item.sourceAbstract === truncated.sourceAbstract);
  assert.equal(enriched.sourceNote, truncated.sourceNote);
  assert.equal(enriched.reviewed, false);
  assert.equal(enriched.scope, 'abstract_only');
});

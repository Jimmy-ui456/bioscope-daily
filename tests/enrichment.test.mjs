import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sourceFingerprint, attachEnrichment, translationOf, rankDownloads, metricGroup, validateDownloadMetric, rankableDownloadMetric } from '../dist/enrichment.js';
import { reportMarkdown } from '../dist/core.js';
import { validateInterpretation, interpretPaper } from '../backend/interpret.mjs';
import { applyPublisherMetrics, fetchZenodoMetric } from '../backend/downloads.mjs';
import { dueSlot } from '../backend/scheduler.mjs';
const paper = { id: 'paper-1', doi: '10.1234/example', title: 'Metabolic engineering of yeast.', abstract: 'We engineered yeast to produce 10 g/L of a target product in shake flasks.', topics: ['metabolic'], authors: 'A', journal: 'J', url: 'https://doi.org/10.1234/example', publishedAt: '2026-10-28', readingScope: '仅摘要', status: '待核验' };
const translated = { titleZh: '酵母代谢工程', abstractZh: '研究者改造酵母，在摇瓶中生产目标产物，浓度为10 g/L。', sourceFingerprint: sourceFingerprint(paper), origin: 'assistant_translation' };
test('译文仅绑定原文版本，更新摘要后不继续展示旧译文', () => {
  assert.equal(translationOf(attachEnrichment(paper, { [paper.id]: translated })).titleZh, translated.titleZh);
  assert.equal(translationOf(attachEnrichment({ ...paper, abstract: paper.abstract + ' New result.' }, { [paper.id]: translated })), null);
});
test('21篇样本均有与原文匹配的中英对照', async () => {
  const sample = JSON.parse(await readFile(new URL('../dist/sample.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(await readFile(new URL('../dist/translations.json', import.meta.url), 'utf8'));
  assert.equal(sample.papers.length, 21);
  for (const p of sample.papers) { const t = translationOf(attachEnrichment(p, catalog.items)); assert.ok(t, p.id); assert.match(t.titleZh, /[\u3400-\u9fff]/); assert.ok(t.abstractZh.length > 50); }
});
test('Markdown同时导出中文译文与英文原文', () => {
  const report = { date: '2026-10-29', createdAt: '2026-10-29T00:00:00Z', windowStart: '2026-10-23', origin: 'sample', papers: [paper] };
  const output = reportMarkdown(report, { [paper.id]: translated });
  assert.match(output, /酵母代谢工程/); assert.match(output, /Metabolic engineering of yeast/); assert.match(output, /We engineered yeast/); assert.match(output, /中文摘要/);
});
test('自动解读必须有逐字可核对的原文证据', async () => {
  const data = { ...translated, findings: { text: '摇瓶滴度为10 g/L。', evidence: paper.abstract }, methods: null, question: null, limitations: [] };
  assert.equal(validateInterpretation(data, paper).findings.text, data.findings.text);
  assert.throws(() => validateInterpretation({ ...data, findings: { text: '达到100 g/L', evidence: 'Imagined result 100 g/L' } }, paper), /证据/);
  let requests = 0;
  const result = await interpretPaper(paper, { baseUrl: 'https://example.org/v1', apiKey: 'test-only-invalid', model: 'test-model', fetchImpl: async (_url, options) => { requests++; assert.ok(options.headers.Authorization); return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }) }; } });
  assert.equal(requests, 1); assert.equal(result.scope, 'abstract_only');
});
test('缺少模型配置时不发出请求', async () => {
  await assert.rejects(interpretPaper(paper, { fetchImpl: () => { throw new Error('Should not call'); } }), /尚未配置/);
});
test('下载量缺失为未知，0是有效统计，不混入浏览或引用量', () => {
  const metric = { count: 0, kind: 'pdf_downloads', platform: 'Publisher', window: 'cumulative', sourceUrl: 'https://example.org/stats', fetchedAt: '2026-10-29T00:00:00Z' };
  assert.equal(validateDownloadMetric(metric), true);
  assert.equal(validateDownloadMetric({ ...metric, count: null }), false);
  assert.equal(validateDownloadMetric({ ...metric, kind: 'views' }), false);
  const group = metricGroup(metric);
  const rows = rankDownloads([{ ...paper, downloadMetric: metric }, { ...paper, id: 'no-data' }, { ...paper, id: 'other', downloadMetric: { ...metric, platform: 'Other', count: 100 } }], group);
  assert.equal(rows.length, 1); assert.equal(rows[0].downloadMetric.count, 0);
  assert.equal(applyPublisherMetrics([paper], [{ doi: paper.doi, ...metric }])[0].downloadMetric.count, 0);
});
test('Zenodo必须匹配论文自身DOI且不是关联数据集', async () => {
  const p = { ...paper, doi: '10.5281/zenodo.123' };
  const fetchRecord = async resource => ({ ok: true, json: async () => ({ doi: p.doi, metadata: { resource_type: { id: resource } }, stats: { downloads: 28 } }) });
  assert.equal((await fetchZenodoMetric(p, () => fetchRecord('publication-article'))).count, 28);
  assert.equal(await fetchZenodoMetric(p, () => fetchRecord('dataset')), null);
  await assert.rejects(fetchZenodoMetric(p, async () => ({ ok: true, json: async () => ({ doi: '10.5281/zenodo.456' }) })), /DOI/);
});
test('缺少部分PDF月份的计数不冒充完整累计排行', () => {
  const metric = { count: 12, kind: 'pdf_downloads', platform: 'PLOS', window: 'cumulative', sourceUrl: 'https://journals.plos.org/plosone/', fetchedAt: '2026-10-29T00:00:00Z', missingPdfMonths: ['2026-09'] };
  assert.equal(validateDownloadMetric(metric), true); assert.equal(rankableDownloadMetric(metric), false);
  assert.equal(rankDownloads([{ ...paper, downloadMetric: metric }]).length, 0);
});
test('北京时间定时边界，不依赖运行主机时区', () => {
  assert.equal(dueSlot(new Date('2026-10-28T23:16:59Z')), null);
  assert.equal(dueSlot(new Date('2026-10-28T23:17:00Z')), '2026-10-29');
  assert.throws(() => dueSlot(new Date(), '24:99'), /HH:MM/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sourceFingerprint, attachEnrichment, translationOf, rankDownloads, metricGroup, validateDownloadMetric, rankableDownloadMetric, metricCoverageLabel, metricFetchedAtLabel } from '../dist/enrichment.js';
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
test('完整原文锚点不匹配时，即使指纹字段相同也不能展示译文', () => {
  const enriched = { ...paper, enrichment: { ...translated, sourceTitle: paper.title, sourceAbstract: paper.abstract + ' changed' } };
  assert.equal(translationOf(enriched), null);
  enriched.enrichment.sourceAbstract = paper.abstract;
  assert.ok(translationOf(enriched));
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

test('下载统计导入支持单标识或一致的双标识，不把另篇下载量关联到当前论文', () => {
  const metric = { count: 0, kind: 'pdf_downloads', platform: 'Publisher', window: 'cumulative', sourceUrl: 'https://example.org/stats', fetchedAt: '2026-10-29T00:00:00Z' };
  for (const identity of [{ doi: paper.doi }, { doi: `https://doi.org/${paper.doi.toUpperCase()}` }, { paperId: paper.id }, { doi: paper.doi, paperId: paper.id }]) {
    assert.equal(applyPublisherMetrics([paper], [{ ...identity, ...metric }])[0].downloadMetric.count, 0);
  }
  assert.equal(applyPublisherMetrics([{ ...paper, doi: null }], [{ paperId: paper.id, ...metric }])[0].downloadMetric.count, 0);
  for (const identity of [
    { doi: '10.1234/another', paperId: paper.id },
    { doi: paper.doi, paperId: 'another-paper' },
    { doi: '10.1234/another', paperId: 'another-paper' },
  ]) assert.equal(applyPublisherMetrics([paper], [{ ...identity, ...metric }])[0].downloadMetric, undefined);
  assert.equal(applyPublisherMetrics([{ ...paper, doi: null }], [{ doi: paper.doi, paperId: paper.id, ...metric }])[0].downloadMetric, undefined);
});

test('下载统计中已提供但无效的DOI或论文编号不能由另一个匹配标识掩盖', () => {
  const metric = { count: 9, kind: 'pdf_downloads', platform: 'Publisher', window: 'cumulative', sourceUrl: 'https://example.org/stats', fetchedAt: '2026-10-29T00:00:00Z' };
  for (const doi of [null, undefined, '', 'not-a-doi', [paper.doi], 123]) {
    assert.equal(applyPublisherMetrics([paper], [{ ...metric, doi, paperId: paper.id }])[0].downloadMetric, undefined);
  }
  for (const paperId of [null, undefined, '', 123]) {
    assert.equal(applyPublisherMetrics([paper], [{ ...metric, doi: paper.doi, paperId }])[0].downloadMetric, undefined);
  }
  assert.equal(applyPublisherMetrics([paper], [metric])[0].downloadMetric, undefined);
});

test('无效首条下载导出不遮挡后续有效记录，导入不修改输入', () => {
  const metric = { doi: paper.doi, count: 4, kind: 'pdf_downloads', platform: 'Publisher', window: 'cumulative', sourceUrl: 'https://example.org/stats', fetchedAt: '2026-10-29T00:00:00Z' };
  const records = [null, [], { ...metric, count: null }, { ...metric, paperId: 'wrong-paper' }, metric];
  const papers = [paper];
  const before = structuredClone({ papers, records });
  const imported = applyPublisherMetrics(papers, records);
  assert.equal(imported[0].downloadMetric.count, 4);
  assert.equal(imported[0].downloadMetric.provenance, 'publisher_export');
  assert.equal(Object.hasOwn(imported[0].downloadMetric, 'doi'), false);
  assert.deepEqual({ papers, records }, before);
});

test('下载统计的期间必须是真实日历日期，拒绝日期回绕且保留合法闰日与0次', () => {
  const metric = { count: 0, kind: 'pdf_downloads', platform: 'Publisher', window: 'interval', start: '2024-02-29', end: '2024-03-01', sourceUrl: 'https://example.org/stats', fetchedAt: '2024-03-02T00:00:00Z' };
  assert.equal(validateDownloadMetric(metric), true);
  for (const date of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-00-01', '2026-13-01', '2026-10-00', 20260228]) {
    assert.equal(validateDownloadMetric({ ...metric, start: date, end: '2026-12-31' }), false, `start=${date}`);
    assert.equal(validateDownloadMetric({ ...metric, end: date }), false, `end=${date}`);
  }
  assert.equal(validateDownloadMetric({ ...metric, start: '2024-03-02' }), false);
  const invalid = { ...metric, doi: paper.doi, start: '2026-02-30', end: '2026-03-01' };
  assert.equal(applyPublisherMetrics([paper], [invalid])[0].downloadMetric, undefined);
  assert.equal(rankDownloads([{ ...paper, downloadMetric: invalid }]).length, 0);
});

test('累计下载的可选起止字段也拒绝JSON对象和非法日期，兼容未提供范围及明确0次', () => {
  const metric = { count: 0, kind: 'pdf_downloads', platform: 'Publisher', window: 'cumulative', sourceUrl: 'https://example.org/stats', fetchedAt: '2026-10-29T00:00:00Z' };
  for (const value of [{ toString: null }, {}, [], 0, false, '2026-02-30']) {
    for (const field of ['start', 'end']) {
      const malformed = { ...metric, [field]: value };
      assert.equal(validateDownloadMetric(malformed), false);
      assert.equal(rankableDownloadMetric(malformed), false);
      assert.equal(metricGroup(malformed), null);
      assert.deepEqual(rankDownloads([{ ...paper, downloadMetric: malformed }]), []);
    }
  }
  assert.equal(validateDownloadMetric({ ...metric, start: '2026-10-29', end: '2026-10-01' }), false);
  for (const range of [{}, { start: null, end: '' }, { start: '', end: null }, { start: '2024-02-29', end: '2024-03-01' }]) {
    const valid = { ...metric, ...range };
    assert.equal(validateDownloadMetric(valid), true);
    assert.equal(rankableDownloadMetric(valid), true);
    assert.equal(typeof metricGroup(valid), 'string');
    assert.equal(rankDownloads([{ ...paper, downloadMetric: valid }])[0].downloadMetric.count, 0);
  }
});

test('下载统计采集时间必须是有效日期字符串，出处不得携带登录凭据', () => {
  const metric = { count: 0, kind: 'pdf_downloads', platform: 'Publisher', window: 'cumulative', sourceUrl: 'https://example.org/stats', fetchedAt: '2026-10-29T00:00:00Z' };
  for (const fetchedAt of [0, null, '', '0', 'not-a-date', '2026-02-30T00:00:00Z', '2026-02-29']) {
    assert.equal(validateDownloadMetric({ ...metric, fetchedAt }), false, `fetchedAt=${fetchedAt}`);
  }
  for (const fetchedAt of ['2024-02-29T08:00:00+08:00', '2024-02-29']) assert.equal(validateDownloadMetric({ ...metric, fetchedAt }), true);
  for (const sourceUrl of ['https://username:example-password@example.org/stats', 'https://username@example.org/stats', 'https://:example-password@example.org/stats', 'http://example.org/stats']) {
    const imported = { ...metric, sourceUrl, doi: paper.doi };
    assert.equal(validateDownloadMetric(imported), false);
    assert.equal(applyPublisherMetrics([paper], [imported])[0].downloadMetric, undefined);
  }
  assert.equal(validateDownloadMetric({ ...metric, sourceUrl: 'https://example.org/stats?paper=1&format=pdf' }), true);
});

test('缺失PDF月份的导入字段不能用错误类型或非法月份绕过排行限制', () => {
  const metric = { count: 12, kind: 'pdf_downloads', platform: 'Publisher', window: 'cumulative', sourceUrl: 'https://example.org/stats', fetchedAt: '2026-10-29T00:00:00Z' };
  for (const missingPdfMonths of ['2026-09', null, {}, ['2026-13'], ['2026-00'], [202609]]) {
    const malformed = { ...metric, missingPdfMonths };
    assert.equal(validateDownloadMetric(malformed), false);
    assert.equal(rankableDownloadMetric(malformed), false);
    assert.equal(rankDownloads([{ ...paper, downloadMetric: malformed }]).length, 0);
  }
  assert.equal(validateDownloadMetric({ ...metric, missingPdfMonths: ['2026-09'] }), true);
  assert.equal(rankableDownloadMetric({ ...metric, missingPdfMonths: ['2026-09'] }), false);
  assert.equal(rankableDownloadMetric({ ...metric, missingPdfMonths: [] }), true);
});

test('下载统计整月缺报字段必须为有效月份数组，旧数据缺字段保持兼容', () => {
  const metric = { count: 12, kind: 'pdf_downloads', platform: 'Publisher', window: 'cumulative', sourceUrl: 'https://example.org/stats', fetchedAt: '2026-10-29T00:00:00Z' };
  for (const unreportedMonths of ['2026-09', null, {}, ['2026-13'], ['2026-00'], [202609]]) {
    const malformed = { ...metric, unreportedMonths };
    assert.equal(validateDownloadMetric(malformed), false);
    assert.equal(rankableDownloadMetric(malformed), false);
  }
  const partial = { ...metric, unreportedMonths: ['2026-02'] };
  assert.equal(validateDownloadMetric(partial), true); assert.equal(rankableDownloadMetric(partial), false);
  assert.equal(rankDownloads([{ ...paper, downloadMetric: partial }]).length, 0);
  assert.equal(rankableDownloadMetric(metric), true);
  assert.equal(rankableDownloadMetric({ ...metric, unreportedMonths: [] }), true);
});

test('旧下载缓存已知月份跨度大于有效计数月数时，缺少新标志也不进入完整排行', () => {
  const metric = { count: 12, kind: 'pdf_downloads', platform: 'PLOS', window: 'cumulative', sourceUrl: 'https://journals.plos.org/plosone/', fetchedAt: '2026-10-29T00:00:00Z', coverageStart: '2026-01', coverageEnd: '2026-03', coverageMonths: 2, reportedMonths: 2, missingPdfMonths: [] };
  assert.equal(validateDownloadMetric(metric), true);
  assert.equal(rankableDownloadMetric(metric), false);
  assert.equal(rankDownloads([{ ...paper, downloadMetric: metric }]).length, 0);
  assert.equal(rankableDownloadMetric({ ...metric, coverageStart: '2025-12', coverageEnd: '2026-02' }), false);
  assert.equal(rankableDownloadMetric({ ...metric, coverageStart: undefined, coverageEnd: undefined, reportedStart: '2026-01', reportedEnd: '2026-03' }), false);
});

test('旧下载缓存报告月份多于有效PDF月份时排除，真实单月265次及0次仍可排行', () => {
  const metric = { count: 265, kind: 'pdf_downloads', platform: 'PLOS', window: 'cumulative', sourceUrl: 'https://journals.plos.org/plosbiology/', fetchedAt: '2026-10-29T00:00:00Z', coverageStart: '2026-10', coverageEnd: '2026-10', coverageMonths: 1, reportedMonths: 1, missingPdfMonths: [] };
  assert.equal(rankableDownloadMetric({ ...metric, reportedMonths: 2 }), false);
  assert.equal(rankableDownloadMetric(metric), true);
  assert.equal(rankableDownloadMetric({ ...metric, count: 0 }), true);
  // An old publication date is outside the known statistic range and proves no gap.
  assert.equal(rankDownloads([{ ...paper, publishedAt: '2000-01-01', downloadMetric: metric }]).length, 1);
});

test('下载统计覆盖说明区分报告范围与计数月份，旧单月数据和未提供范围不被夸大', () => {
  const metric = { count: 12, kind: 'pdf_downloads', platform: 'Publisher', window: 'cumulative', sourceUrl: 'https://example.org/stats', fetchedAt: '2026-10-29T00:00:00Z' };
  const legacy = { ...metric, coverageStart: '2026-10', coverageEnd: '2026-10', coverageMonths: 1, reportedMonths: 1, missingPdfMonths: [] };
  assert.match(metricCoverageLabel(legacy), /已知PDF计数月份：2026-10（1个月）/);
  assert.match(metricCoverageLabel(legacy), /完整起止月份范围未提供/);
  const partial = { ...metric, reportedStart: '2026-01', reportedEnd: '2026-04', coverageStart: '2026-02', coverageEnd: '2026-02', coverageMonths: 1, missingPdfMonths: ['2026-01', '2026-04'], unreportedMonths: ['2026-03'] };
  const label = metricCoverageLabel(partial);
  assert.match(label, /平台返回月份：2026-01—2026-04/);
  assert.match(label, /已知PDF计数月份：2026-02（1个月）/);
  assert.match(label, /已报告但缺PDF计数：2026-01、2026-04（未按0计）/);
  assert.match(label, /整月缺报：2026-03（未按0计）/);
  assert.equal(metricCoverageLabel({ ...metric, window: 'interval', start: '2026-10-01', end: '2026-10-28' }), '统计期间：2026-10-01—2026-10-28');
  assert.match(metricCoverageLabel(metric), /范围未提供/);
  assert.equal(metricCoverageLabel({ ...metric, count: null }), '暂无可核对的统计范围');
});

test('下载统计完整时区时间换算北京时间并保留到分钟，跨日不丢失', () => {
  assert.equal(metricFetchedAtLabel({ fetchedAt: '2026-10-29T23:45:30Z' }), '2026-10-30 07:45（北京）');
  assert.equal(metricFetchedAtLabel({ fetchedAt: '2026-10-30T07:45:30+08:00' }), '2026-10-30 07:45（北京）');
});

test('下载统计只有日期时不虚构具体时间', () => {
  assert.equal(metricFetchedAtLabel({ fetchedAt: '2026-10-29' }), '2026-10-29（具体时间未提供）');
});

test('下载统计无时区时间保留原字串，非法或缺失时间不冒充记录', () => {
  assert.equal(metricFetchedAtLabel({ fetchedAt: '2026-10-29T07:17:30' }), '2026-10-29T07:17:30（时区未提供）');
  assert.equal(metricFetchedAtLabel({ fetchedAt: '2026-02-30T07:17:30Z' }), '采集时间未提供');
  assert.equal(metricFetchedAtLabel(null), '采集时间未提供');
});

test('未选统计组时只自动排列同口径数据，多平台或不同窗口不混排', () => {
  const metric = { count: 0, kind: 'pdf_downloads', platform: 'Publisher', window: 'cumulative', sourceUrl: 'https://example.org/stats', fetchedAt: '2026-10-29T00:00:00Z' };
  const rows = [{ ...paper, downloadMetric: metric }, { ...paper, id: 'same', downloadMetric: { ...metric, count: 10 } }];
  const before = JSON.stringify(rows);
  assert.deepEqual(rankDownloads(rows).map(p => p.id), ['same', paper.id]);
  assert.equal(JSON.stringify(rows), before);
  for (const other of [
    { ...metric, platform: 'Other' },
    { ...metric, kind: 'file_downloads' },
    { ...metric, window: 'interval', start: '2026-10-01', end: '2026-10-29' },
  ]) {
    const mixed = [...rows, { ...paper, id: 'other', downloadMetric: other }];
    assert.deepEqual(rankDownloads(mixed), []);
    assert.deepEqual(rankDownloads(mixed, metricGroup(metric)).map(p => p.id), ['same', paper.id]);
  }
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

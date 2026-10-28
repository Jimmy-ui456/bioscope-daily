import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaper, reportMarkdown } from '../dist/core.js';
import { sourceFingerprint } from '../dist/enrichment.js';
import { createPublicReport, updatePublicReportHistory } from '../backend/reports.mjs';

const now = new Date('2026-10-28T23:17:00Z'); // Beijing 2026-10-29 07:17.
test('公开日报导出明确标为自动清单，不冒充使用者人工精选', () => {
  const report = createPublicReport([paper('export')], { now });
  const markdown = reportMarkdown(report);
  assert.match(markdown, /公共文献简报/); assert.match(markdown, /非人工科研价值精选/); assert.equal(markdown.includes('由使用者手动精选'), false);
});
function paper(id, date = '2026-10-28', topics = ['synthetic']) {
  return { ...normalizePaper({
    id: String(id), source: 'MED', doi: `10.1234/report-${id}`, title: `Source title ${id}`,
    abstractText: `Source abstract ${id}.`, firstPublicationDate: date,
    journalInfo: { journal: { title: 'Example journal' } }, pubTypeList: { pubType: ['Journal Article'] },
  }, null, '2026-10-29T00:00:00Z'), topics };
}

test('公开日报按北京日历包含D-6与当天，排除旧文、未来、缺失或无效日期及撤稿', () => {
  const boundary = paper('boundary', '2026-10-23');
  const today = paper('today', '2026-10-29');
  const records = [boundary, today, paper('old', '2026-10-22'), paper('future', '2026-10-30'), paper('invalid', '2026-02-30'), { ...paper('missing'), publishedAt: null }, { ...paper('retracted'), isRetraction: true }];
  const report = createPublicReport(records, { now });
  assert.equal(report.date, '2026-10-29');
  assert.equal(report.windowStart, '2026-10-23');
  assert.deepEqual(new Set(report.papers.map(p => p.id)), new Set([boundary.id, today.id]));
  assert.equal(report.kind, 'public_daily');
  assert.match(report.selectionPolicy.description, /非人工科研价值精选/);
});

test('去重后按主题轮取，少量主题不会被大量较新论文挤出，全文总数不超过10', () => {
  const synthetic = Array.from({ length: 20 }, (_, i) => paper(`s-${i}`, '2026-10-29', ['synthetic']));
  const metabolic = paper('m', '2026-10-25', ['metabolic']);
  const microbial = paper('b', '2026-10-23', ['microbial']);
  const duplicate = { ...synthetic[0], id: 'alternate-source', topics: ['synthetic', 'metabolic'] };
  const report = createPublicReport([...synthetic, metabolic, microbial, duplicate], { now, limit: 100 });
  assert.equal(report.papers.length, 10);
  assert.ok(report.papers.some(p => p.id === metabolic.id));
  assert.ok(report.papers.some(p => p.id === microbial.id));
  assert.equal(new Set(report.papers.map(p => p.doi)).size, report.papers.length);
  assert.equal(report.sections.reduce((n, section) => n + section.paperIds.length, 0), 10);
});

test('同一论文的较完整或较旧副本不能掩盖已有撤稿信号', () => {
  const original = paper('same');
  const retracted = { ...original, id: 'retracted-copy', doi: null, isRetraction: true };
  const innocentCopy = { ...original, id: 'newer-metadata', isRetraction: false };
  const report = createPublicReport([retracted, innocentCopy], { now });
  assert.equal(report.papers.length, 0);
});

test('只使用有效原文译文，生成后不受源文献或译文目录后续变化影响', () => {
  const source = paper('translated');
  const translation = { titleZh: '已有中文题名', abstractZh: '已有中文摘要。', origin: 'assistant_translation', sourceFingerprint: sourceFingerprint(source) };
  const report = createPublicReport([source], { now, translations: { [source.id]: translation } });
  assert.equal(report.papers[0].enrichment.titleZh, '已有中文题名');
  assert.equal(report.papers[0].title, source.title);
  source.title = 'Changed title';
  source.topics.push('metabolic');
  translation.titleZh = 'Changed translation';
  assert.equal(report.papers[0].enrichment.titleZh, '已有中文题名');
  assert.equal(report.papers[0].title, 'Source title translated');
  assert.deepEqual(report.papers[0].topics, ['synthetic']);
  const stale = createPublicReport([source], { now, translations: { [source.id]: translation } });
  assert.equal(stale.papers[0].enrichment, undefined);
});

test('同日期快照只保留首次发表版本，既有历史不会被修改或共享引用', () => {
  const first = createPublicReport([paper('first')], { now });
  const later = createPublicReport([paper('later')], { now: new Date('2026-10-29T03:00:00Z') });
  const history = updatePublicReportHistory([first], later);
  assert.equal(history.length, 1);
  assert.equal(history[0].papers[0].id, first.papers[0].id);
  history[0].papers[0].title = 'Edited output';
  assert.equal(first.papers[0].title, 'Source title first');
});

test('历史保留最近14个日历日而非14份任意旧刊，空结果也如实成刊', () => {
  const make = (date, id) => createPublicReport([paper(id, date)], { now: `${date}T08:00:00+08:00`, date });
  const history = [make('2026-10-15', 'too-old'), make('2026-10-16', 'boundary'), make('2026-10-20', 'mid')];
  const empty = createPublicReport([], { now });
  const updated = updatePublicReportHistory(history, empty);
  assert.deepEqual(updated.map(r => r.date), ['2026-10-29', '2026-10-20', '2026-10-16']);
  assert.equal(updated[0].papers.length, 0);
  assert.equal(updated[0].metrics.selectedCount, 0);
});

test('不把不在配置主题中的文献补进日报，也不从发现时间推算发表日期', () => {
  const unknown = paper('unknown', '2026-10-29', ['unconfigured']);
  const oldButDiscoveredToday = paper('late-indexed', '2026-09-01');
  const report = createPublicReport([unknown, oldButDiscoveredToday], { now, topics: ['synthetic'] });
  assert.equal(report.papers.length, 0);
  assert.deepEqual(report.selectionPolicy.topicOrder, ['synthetic']);
});

test('未来报告日和非法窗口拒绝生成，避免输出看似有效的错误刊期', () => {
  assert.throws(() => createPublicReport([], { now, date: '2026-10-30' }), /不晚于今天/);
  assert.throws(() => createPublicReport([], { now, date: '2026-02-30' }), /真实/);
  assert.throws(() => createPublicReport([], { now, days: 0 }), /正整数/);
  assert.throws(() => createPublicReport([], { now, topics: [] }), /有效主题/);
});

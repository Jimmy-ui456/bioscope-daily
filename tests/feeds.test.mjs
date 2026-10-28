import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyRss, publicReportUrl } from '../backend/feeds.mjs';
import { sourceFingerprint } from '../dist/enrichment.js';

const siteUrl = 'https://jimmy-ui456.github.io/bioscope-daily/';
function issue(date, overrides = {}) {
  return { kind: 'public_daily', id: `public-daily-${date}`, date, windowStart: date,
    createdAt: `${date}T07:17:00+08:00`, papers: [{ id: 'paper-1', title: 'Original title', abstract: 'PRIVATE-ABSTRACT-NOT-FOR-FEED', url: 'https://doi.org/10.1234/example' }], ...overrides };
}

test('每期RSS链接直达刊期，GUID不随译文或生成时间变化', () => {
  const first = createDailyRss([issue('2026-10-29')], { siteUrl });
  const updated = createDailyRss([issue('2026-10-29', { createdAt: '2026-10-29T09:17:00+08:00', papers: [] })], { siteUrl });
  const guid = first.match(/<guid isPermaLink="false">([^<]+)<\/guid>/)[1];
  assert.equal(guid, updated.match(/<guid isPermaLink="false">([^<]+)<\/guid>/)[1]);
  assert.equal(publicReportUrl('2026-10-29', siteUrl), 'https://jimmy-ui456.github.io/bioscope-daily/?report=public-daily-2026-10-29#daily');
  assert.match(first, /Wed, 28 Oct 2026 23:17:00 GMT/);
});

test('最新刊期在前、同日只保留首刊，至多14期且不包括个人简报', () => {
  const reports = Array.from({ length: 16 }, (_, i) => issue(`2026-10-${String(i + 1).padStart(2, '0')}`));
  reports.push(issue('2026-10-16', { createdAt: '2026-10-16T10:00:00+08:00', papers: [{ title: 'LATER-REVISION', url: 'https://example.org' }] }));
  reports.push(issue('2026-10-29', { kind: 'personal', papers: [{ title: 'PERSONAL-PAPER' }] }));
  const before = JSON.stringify(reports);
  const rss = createDailyRss(reports.reverse(), { siteUrl });
  assert.equal((rss.match(/<item>/g) || []).length, 14);
  assert.ok(rss.indexOf('2026-10-16 公共文献简报') < rss.indexOf('2026-10-15 公共文献简报'));
  assert.equal(rss.includes('2026-10-02 公共文献简报'), false);
  assert.equal(rss.includes('LATER-REVISION'), false);
  assert.equal(rss.includes('PERSONAL-PAPER'), false);
  reports.reverse(); assert.equal(JSON.stringify(reports), before);
});

test('只分发题名和原文链接，有效中译可对照，原文摘要与解读不进入RSS', () => {
  const report = issue('2026-10-29');
  report.papers[0].enrichment = { titleZh: '已有中文题名', abstractZh: 'CHINESE-ABSTRACT-NOT-FOR-FEED', sourceFingerprint: sourceFingerprint(report.papers[0]), findings: { text: 'FINDING-NOT-FOR-FEED' } };
  const rss = createDailyRss([report], { siteUrl });
  assert.match(rss, /已有中文题名/);
  assert.match(rss, /Original title/);
  assert.match(rss, /https:\/\/doi.org\/10\.1234\/example/);
  assert.equal(rss.includes('ABSTRACT-NOT-FOR-FEED'), false);
  assert.equal(rss.includes('FINDING-NOT-FOR-FEED'), false);
});

test('新增译文目录可补历史题名，保留GUID和首刊时间且不分发摘要解读', () => {
  const report = issue('2026-10-28');
  const paper = report.papers[0];
  const before = createDailyRss([report], { siteUrl });
  const translations = { [paper.id]: {
    sourceFingerprint: sourceFingerprint(paper), sourceTitle: paper.title, sourceAbstract: paper.abstract,
    titleZh: '后来补充的中文题名', abstractZh: 'CATALOG-ABSTRACT-NOT-FOR-FEED',
    findings: { text: 'CATALOG-FINDING-NOT-FOR-FEED' },
  } };
  const after = createDailyRss([report], { siteUrl, translations });
  assert.equal(before.includes('后来补充的中文题名'), false);
  assert.match(after, /后来补充的中文题名<br><span lang="en">Original title<\/span>/);
  for (const tag of ['guid', 'pubDate', 'lastBuildDate']) {
    const pattern = new RegExp(`<${tag}(?: [^>]*)?>[^<]+<\\/${tag}>`);
    assert.equal(after.match(pattern)[0], before.match(pattern)[0]);
  }
  assert.equal(after.includes('ABSTRACT-NOT-FOR-FEED'), false);
  assert.equal(after.includes('FINDING-NOT-FOR-FEED'), false);
});

test('原文题名或摘要变更时拒绝目录和快照中的旧译文', () => {
  const original = issue('2026-10-28').papers[0];
  const oldTranslation = {
    sourceFingerprint: sourceFingerprint(original), sourceTitle: original.title, sourceAbstract: original.abstract,
    titleZh: '过期中文题名', abstractZh: '过期中文摘要',
  };
  for (const field of ['title', 'abstract']) {
    const changed = { ...original, [field]: `${original[field]} changed`, enrichment: oldTranslation };
    const report = issue('2026-10-28', { papers: [changed] });
    const rss = createDailyRss([report], { siteUrl, translations: { [original.id]: oldTranslation } });
    assert.equal(rss.includes('过期中文题名'), false, `${field} changed`);
    assert.ok(rss.includes(changed.title));
    assert.equal(rss.includes('PRIVATE-ABSTRACT-NOT-FOR-FEED'), false);
  }
});

test('读取辅助译文不修改冻结日报或译文目录输入', () => {
  const report = issue('2026-10-28');
  const paper = report.papers[0];
  const translations = { [paper.id]: {
    sourceFingerprint: sourceFingerprint(paper), titleZh: '只读中文题名', abstractZh: '只读中文摘要',
    findings: { text: '只读解读' },
  } };
  const reports = [report];
  const before = JSON.stringify({ reports, translations });
  const freeze = value => {
    for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
    return Object.freeze(value);
  };
  freeze(reports); freeze(translations);
  const rss = createDailyRss(reports, { siteUrl, translations });
  assert.match(rss, /只读中文题名/);
  assert.equal(JSON.stringify({ reports, translations }), before);
  assert.equal(Object.hasOwn(paper, 'enrichment'), false);
});

test('XML及嵌入HTML安全转义，移除非法XML字符，不输出危险或含凭据的链接', () => {
  const report = issue('2026-10-29', { selectionPolicy: { description: '规则 & <检查> ]]> "引号"\u0000' }, papers: [
    { title: '<img src=x onerror=bad> & "]]>', url: 'https://example.org/paper?a=1&b=2' },
    { title: 'Unsafe protocol', url: 'javascript:alert(1)' },
    { title: 'Credentials', url: 'https://user:secret@example.org/paper' },
  ] });
  const rss = createDailyRss([report], { siteUrl, title: 'Bio & Science <日报>' });
  assert.match(rss, /<title>Bio &amp; Science &lt;日报&gt;<\/title>/);
  assert.match(rss, /&lt;img src=x onerror=bad&gt;/);
  assert.match(rss, /a=1&amp;b=2/);
  assert.equal(rss.includes('javascript:'), false);
  assert.equal(rss.includes('user:secret'), false);
  assert.equal(rss.includes('\u0000'), false);
  assert.equal((rss.match(/<!\[CDATA\[/g) || []).length, 1);
  assert.equal((rss.match(/\]\]>/g) || []).length, 1);
});

test('空或无效报告仍产生完整频道，不制造日期或文献', () => {
  const rss = createDailyRss([issue('2026-02-30'), issue('2026-10-29', { createdAt: 'invalid' })], { siteUrl });
  assert.match(rss, /<rss version="2\.0"/); assert.match(rss, /<channel>/); assert.match(rss, /<description>/);
  assert.equal(rss.includes('<item>'), false); assert.equal(rss.includes('<lastBuildDate>'), false);
  assert.match(createDailyRss([issue('2026-10-29', { papers: [] })], { siteUrl }), /本期没有符合规则的文献/);
});

test('站点配置不接受危险协议、凭据或站点目录之外的订阅地址', () => {
  assert.throws(() => createDailyRss([], { siteUrl: 'javascript:alert(1)' }), /HTTPS/);
  assert.throws(() => createDailyRss([], { siteUrl: 'https://user:secret@example.org/' }), /不含凭据/);
  assert.throws(() => createDailyRss([], { siteUrl, feedPath: 'https://elsewhere.example/feed.xml' }), /同一公开站点/);
  assert.throws(() => publicReportUrl('2026-02-30', siteUrl), /真实/);
});

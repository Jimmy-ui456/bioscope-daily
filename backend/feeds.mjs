import { attachEnrichment, translationOf } from '../dist/enrichment.js';

// RSS 2.0: https://www.rssboard.org/rss-specification
// Issues expose titles and source links only, not paper abstracts or full text.
const DEFAULT_TITLE = '生研观察 BioScope · 公共日报';
const DEFAULT_DESCRIPTION = '按规则自动整理的生物科研文献简报，保留题名和原文入口；不是人工科研价值精选。';

function xmlText(value) {
  return String(value ?? '')
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

function cdata(value) { return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`; }

function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function siteDirectory(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('RSS 需要有效的公开站点地址 siteUrl'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('RSS 站点地址必须使用不含凭据的 HTTPS URL');
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function sourceLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function publicIssues(reports) {
  const byDate = new Map();
  const valid = (Array.isArray(reports) ? reports : []).filter(report => report?.kind === 'public_daily'
    && validCalendarDate(report.date) && Array.isArray(report.papers)
    && typeof report.createdAt === 'string' && Number.isFinite(Date.parse(report.createdAt)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  // Match the report archive's first-issue-per-date policy.
  for (const report of valid) if (!byDate.has(report.date)) byDate.set(report.date, report);
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
}

function issueDescription(report, papers) {
  const policy = report.selectionPolicy?.description || DEFAULT_DESCRIPTION;
  const window = validCalendarDate(report.windowStart) ? `${report.windowStart} — ${report.date}` : report.date;
  const entries = papers.map(paper => {
    const translated = translationOf(paper);
    const title = translated ? `${xmlText(translated.titleZh)}<br><span lang="en">${xmlText(paper.title)}</span>` : xmlText(paper.title);
    const url = sourceLink(paper.url);
    return `<li>${url ? `<a href="${xmlText(url)}">${title}</a>` : title}</li>`;
  }).join('');
  return `<p>${xmlText(policy)}</p><p>发表日期范围：${xmlText(window)}。</p>${entries ? `<ol>${entries}</ol>` : '<p>本期没有符合规则的文献。</p>'}`;
}

export function publicReportUrl(reportDate, siteUrl) {
  if (!validCalendarDate(reportDate)) throw new Error('RSS 日报链接需要真实的日历日期');
  const url = siteDirectory(siteUrl);
  url.searchParams.set('report', `public-daily-${reportDate}`);
  url.hash = 'daily';
  return url.href;
}

export function createDailyRss(reports, {
  siteUrl, title = DEFAULT_TITLE, description = DEFAULT_DESCRIPTION, feedPath = 'feed.xml',
  translations = {},
} = {}) {
  const site = siteDirectory(siteUrl);
  const self = new URL(feedPath, site);
  if (self.origin !== site.origin || !self.pathname.startsWith(site.pathname) || self.username || self.password) throw new Error('RSS 订阅地址必须位于同一公开站点目录');
  const issues = publicIssues(reports);
  const lastBuilt = issues.length ? new Date(Math.max(...issues.map(report => Date.parse(report.createdAt)))).toUTCString() : null;
  const items = issues.map(report => {
    const papers = report.papers.filter(paper => paper && typeof paper.title === 'string' && paper.title.trim())
      .slice(0, 10).map(paper => attachEnrichment(paper, translations));
    const link = publicReportUrl(report.date, site.href);
    return `    <item>
      <title>${xmlText(`生研观察 · ${report.date} 公共文献简报（${papers.length} 篇）`)}</title>
      <link>${xmlText(link)}</link>
      <guid isPermaLink="false">${xmlText(link)}</guid>
      <pubDate>${new Date(report.createdAt).toUTCString()}</pubDate>
      <description>${cdata(issueDescription(report, papers))}</description>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlText(title)}</title>
    <link>${xmlText(site.href)}</link>
    <description>${xmlText(description)}</description>
    <language>zh-cn</language>
    <generator>BioScope public daily feed</generator>
    <docs>https://www.rssboard.org/rss-specification</docs>
    <ttl>60</ttl>
    <atom:link href="${xmlText(self.href)}" rel="self" type="application/rss+xml"/>${lastBuilt ? `\n    <lastBuildDate>${lastBuilt}</lastBuildDate>` : ''}${items ? `\n${items}` : ''}
  </channel>
</rss>
`;
}

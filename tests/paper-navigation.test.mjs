import test from 'node:test';
import assert from 'node:assert/strict';
import { indexSharedRecords } from '../dist/report-comparison.js';
import { incomingPaperNavigation, resolveSharedPaper, sharedPaperLocation, consumePaperLocation } from '../dist/paper-navigation.js';

const site = 'https://example.org/bioscope/?report=old&context=private#daily';
// Identifiers captured from actual shared snapshot records. They survive library rotation here.
const preprint = { id: 'doi:10.21203/rs.3.rs-10315769/v1', doi: '10.21203/rs.3.rs-10315769/v1', pmid: null,
  source: 'PPR', sourceId: 'PPR1368205', collection: 'Europe PMC', title: 'Snapshot record', abstract: 'Original abstract' };
const pmc = { id: 'epmc:PMC:PMC13751451', doi: null, pmid: null, source: 'PMC', sourceId: 'PMC13751451',
  collection: 'Europe PMC', title: 'PMC record', abstract: '' };
const viaPmid = { ...pmc, source: 'MED', sourceId: '12345', pmid: '12345' };
const locate = (paper, ...current) => sharedPaperLocation(paper, indexSharedRecords(current), site);
const resolve = (href, shared) => resolveSharedPaper(incomingPaperNavigation(href).paper, shared);

test('站内链接使用页面的来源与路径，DOI 版本、PMID 和 Europe PMC 标识均可按原记录打开', () => {
  const index = indexSharedRecords([preprint, pmc, viaPmid]);
  for (const [record, expected] of [[preprint, 'doi:10.21203/rs.3.rs-10315769/v1'], [pmc, 'epmc:PMC:PMC13751451'], [viaPmid, 'pmid:12345']]) {
    const location = sharedPaperLocation(record, index, site);
    const url = new URL(location);
    assert.equal(url.origin, 'https://example.org');
    assert.equal(url.pathname, '/bioscope/');
    assert.equal(url.hash, '#overview');
    assert.deepEqual([...url.searchParams], [['paper', expected]]);
    assert.deepEqual(resolve(location, index), { status: 'found', paper: record });
  }
});

test('URL 编码保留 DOI 后缀中的标点，v1 缺失时不会误开 v2', () => {
  const punctuation = { ...preprint, doi: '10.12345/A+(B)?C#D%23/part/v1' };
  const first = locate(punctuation, punctuation);
  assert.equal(new URL(first).searchParams.get('paper'), 'doi:10.12345/a+(b)?c#d%23/part/v1');
  assert.equal(resolve(first, indexSharedRecords([punctuation])).paper, punctuation);
  const v2 = { ...punctuation, doi: punctuation.doi.replace('/v1', '/v2') };
  assert.deepEqual(resolve(first, indexSharedRecords([v2])), { status: 'missing' });
});

test('共享链接拒绝重复标识、无来源本地文献和经个人覆盖的原始字段', () => {
  const link = locate(preprint, preprint);
  assert.deepEqual(resolve(link, indexSharedRecords([preprint, { ...preprint, title: 'Duplicate' }])), { status: 'ambiguous' });
  assert.equal(locate(preprint, preprint, { ...preprint }), null);
  assert.equal(locate({ ...preprint, abstract: 'Personal abstract' }, preprint), null);
  assert.equal(locate({ ...preprint, authors: 'Personal authors' }, preprint), null);
  assert.equal(locate({ ...pmc, collection: 'sample' }, pmc), null);
  assert.equal(locate({ ...pmc, sourceId: 'local id' }, pmc), null);
  assert.equal(sharedPaperLocation(preprint, indexSharedRecords([preprint]), 'not a URL'), null);
  assert.ok(locate({ ...preprint, enrichment: { titleZh: '译文' }, discoveredAt: 'different cache date' }, preprint));
});

test('区分链接错误、没有可读共享库和共享库无此记录，旧报刊链接优先', () => {
  const good = locate(pmc, pmc);
  assert.deepEqual(resolve(good, null), { status: 'unavailable' });
  assert.deepEqual(resolve(good, indexSharedRecords([])), { status: 'missing' });
  for (const invalid of ['', 'pmid:1e5', 'doi:bad', 'epmc:<script>:id']) {
    const url = new URL(good);
    url.searchParams.set('paper', invalid);
    assert.deepEqual(resolve(url.href, null), { status: 'invalid' });
  }
  const report = new URL(good);
  report.searchParams.set('report', 'public-daily-2026-11-20');
  assert.deepEqual(incomingPaperNavigation(report.href), { reportId: 'public-daily-2026-11-20', paper: null });
  report.searchParams.set('report', 'public-daily-2026-11-40');
  assert.equal(resolve(report.href, indexSharedRecords([pmc])).paper, pmc);
  report.searchParams.append('paper', 'pmid:123');
  assert.deepEqual(resolve(report.href, null), { status: 'invalid' });
  assert.deepEqual(incomingPaperNavigation(site), { reportId: null, paper: null });
});

test('关闭只移除 paper 查询参数，保留其他查询参数、路径和哈希', () => {
  const url = new URL(locate(preprint, preprint));
  url.searchParams.append('context', 'personal value');
  url.searchParams.append('context', 'other');
  const consumed = new URL(consumePaperLocation(url.href));
  assert.equal(consumed.pathname, '/bioscope/');
  assert.equal(consumed.hash, '#overview');
  assert.deepEqual([...consumed.searchParams], [['context', 'personal value'], ['context', 'other']]);
});

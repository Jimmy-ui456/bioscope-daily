import test from 'node:test';
import assert from 'node:assert/strict';
import { indexSharedRecords, sameSharedRecord, changedOriginalFields, sharedReportChanges } from '../dist/report-comparison.js';
import { reportRis } from '../dist/report-ris.js';

const base = { id: 'private-id', doi: '10.1234/example/v1', pmid: '456', source: 'MED', sourceId: '456', collection: 'Europe PMC',
  title: 'Frozen title', abstract: 'Frozen abstract', authors: 'Jia L, O’Neil A.', publishedAt: '2026-10-21', version: 1,
  url: 'https://doi.org/10.1234/example/v1' };
const match = (paper, ...shared) => sameSharedRecord(paper, indexSharedRecords(shared));

test('完整 DOI 优先匹配，版本后缀和已知 DOI 冲突保持独立', () => {
  const exact = { ...base, id: 'shared-id', doi: 'https://doi.org/10.1234/Example/v1' };
  const other = { ...base, doi: '10.1234/example/v2' };
  assert.equal(match(base, exact, other), exact);
  assert.equal(match(base, other), null);
  assert.equal(match(base, exact, { ...exact }), null);
  assert.equal(match(base, { ...other, doi: '10.1234/example' }), null);
});

test('仅在无 DOI 匹配时用确切 PMID 或显式 Europe PMC 源标识，歧义不配对', () => {
  const snapshot = { ...base, doi: null };
  const byPmid = { ...snapshot, sourceId: null, id: 'pmid-record' };
  const bySource = { ...snapshot, pmid: null, id: 'source-record' };
  assert.equal(match(base, byPmid), byPmid);
  assert.equal(match(base, bySource), bySource);
  assert.equal(match(base, snapshot), snapshot);
  assert.equal(match(base, byPmid, bySource), null);
  assert.equal(match(base, { ...bySource, collection: 'personal' }), null);
  assert.equal(match({ ...base, doi: null, pmid: 'pmid:456', sourceId: null }, byPmid), null);
  assert.equal(match(base, { title: base.title, id: base.id }), null);
  assert.equal(match(base), null);
});

test('比较原文字段，排除空白、常见排版差异和解读、发现时间、下载量变化', () => {
  const frozen = { ...base, abstract: 'A non‑breaking dash and cafe\u0301', title: 'Text ‘quoted’' };
  assert.deepEqual(changedOriginalFields(frozen, { ...frozen, title: " text 'Quoted'\n",
    abstract: 'A non-breaking dash and café', authors: "Jia L, O'Neil A.", version: '1',
    enrichment: { titleZh: '译文变更' }, discoveredAt: '2026-11-20', downloadMetric: { count: 10 },
  }), []);
  assert.deepEqual(changedOriginalFields({ ...base, title: 'ABC and mRNA' }, { ...base, title: 'abc and mRNa' }), ['title']);
  assert.deepEqual(changedOriginalFields(base, { ...base,
    title: 'Updated title', abstract: 'New abstract', authors: 'Updated A.', publishedAt: '2026-10-22', version: 2,
  }), ['title', 'abstract', 'authors', 'publishedAt', 'version']);
});

test('无共享库时不显示变化，冻结记录和 RIS 在比较前后保持一致', () => {
  const report = { papers: [Object.freeze({ ...base })] };
  const original = structuredClone(report);
  const ris = reportRis(report);
  assert.deepEqual(sharedReportChanges(report, indexSharedRecords(null)), [[]]);
  const current = { ...base, title: 'Current title' };
  assert.deepEqual(sharedReportChanges(report, indexSharedRecords([current])), [['title']]);
  assert.deepEqual(report, original);
  assert.equal(reportRis(report), ris);
});

test('11 月 13 日公开简报与后续共享快照的真实作者题录差异', () => {
  // Captured authors and identity from the frozen edition and shared copy.
  const doi = '10.64898/2026.11.10.765548';
  const frozen = { doi, authors: 'Rocha CKdS, Rico J, Goni-Moreno A.' };
  const current = { doi, authors: 'Rocha CKS, Rico J, Goñi-Moreno Á.' };
  assert.deepEqual(sharedReportChanges({ papers: [frozen] }, indexSharedRecords([current])), [['authors']]);
});

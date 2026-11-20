import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaper } from '../dist/core.js';
import { planSharedRefresh } from '../dist/shared-refresh.js';
import { incomingPaperNavigation, pendingSharedPaper, sharedPaperLocation } from '../dist/paper-navigation.js';
import { indexSharedRecords } from '../dist/report-comparison.js';

const at = '2026-11-20T03:59:55.690Z';
const record = (id, { source = 'PMC', doi = null } = {}) =>
  normalizePaper({ id, source, doi, title: `Title ${id}`, firstPublicationDate: '2026-11-19' }, 'synthetic', at);
const fallback = { origin: 'sample', containsImported: false, papers: Array.from({ length: 21 }, (_, i) => record(`sample-${i}`)) };
// The actual shared snapshot DOI and Europe PMC accession, with minimal fixture metadata.
const versioned = record('PPR1368205', { source: 'PPR', doi: '10.21203/rs.3.rs-10315769/v1' });
const shared = { fetchedAt: at, papers: [versioned, ...Array.from({ length: 347 }, (_, i) => record(`shared-${i}`))] };
const href = 'https://example.org/bioscope/?paper=doi%3A10.21203%2Frs.3.rs-10315769%2Fv1#overview';
const request = incomingPaperNavigation(href).paper;

test('初次请求失败时保留样本，首个可读的共享库即使没有 completedAt 也会补入', () => {
  const initial = planSharedRefresh(null, null, fallback, false);
  assert.deepEqual(initial, { library: null, status: 'unavailable', patch: null });
  assert.equal(fallback.papers.length, 21);
  assert.equal(pendingSharedPaper(request, null, initial.status).status, 'unavailable');
  const recovered = planSharedRefresh(initial.library, shared, fallback, false);
  assert.equal(recovered.status, 'updated');
  assert.equal(recovered.patch.origin, 'live');
  assert.equal(recovered.patch.papers.length, 348);
  assert.ok(recovered.patch.papers.every(paper => !paper.sourceId.startsWith('sample-')));
  const index = indexSharedRecords(recovered.library.papers);
  assert.equal(pendingSharedPaper(request, index, recovered.status).paper, versioned);
  assert.equal(sharedPaperLocation(recovered.patch.papers.find(p => p.id === versioned.id), index, href), href);
});

test('主动选择样本时只更新共享快照，自动兜底和个人合并库继续按原有规则处理', () => {
  const pinned = planSharedRefresh(null, shared, fallback, true);
  assert.equal(pinned.library, shared);
  assert.equal(pinned.patch, null);
  const personal = record('personal-only');
  const current = { ...fallback, containsImported: true, papers: [personal], readerPresets: ['keep'], readMarks: ['keep'] };
  const reconciled = planSharedRefresh(null, shared, current, false);
  assert.equal(reconciled.patch.origin, 'sample');
  assert.equal(reconciled.patch.papers.length, 349);
  assert.ok(reconciled.patch.papers.some(paper => paper.id === personal.id));
  assert.equal(Object.hasOwn(reconciled.patch, 'readerPresets'), false);
  assert.equal(Object.hasOwn(reconciled.patch, 'readMarks'), false);
  assert.deepEqual(current.papers, [personal]);
});

test('旧快照与不可读响应保留最后可读快照，重复快照不重新替换列表', () => {
  const older = { ...shared, fetchedAt: '2026-11-19T03:59:55.690Z' };
  assert.deepEqual(planSharedRefresh(shared, older, fallback, false), { library: shared, status: 'stale', patch: null });
  assert.deepEqual(planSharedRefresh(shared, { papers: [{}] }, fallback, false), { library: shared, status: 'unavailable', patch: null });
  assert.deepEqual(planSharedRefresh(shared, { ...shared, fetchedAt: '2026-11-20T11:59:55.690+08:00' }, fallback, false).patch, null);
  const legacy = { papers: [versioned] };
  assert.equal(planSharedRefresh(null, legacy, fallback, false).patch.papers.length, 1);
  assert.equal(planSharedRefresh(shared, legacy, fallback, false).status, 'same');
  assert.equal(planSharedRefresh(shared, { ...shared, automation: { completedAt: at } }, fallback, false).status, 'updated');
  const index = indexSharedRecords(shared.papers);
  assert.equal(pendingSharedPaper(request, index, 'stale').status, 'stale');
  assert.equal(pendingSharedPaper(request, index, 'unavailable').status, 'unavailable');
});

test('待打开链接重新按最新共享数据精确匹配，缺失或重复时不打开旧记录', () => {
  const v2 = { ...versioned, doi: versioned.doi.replace('/v1', '/v2') };
  assert.equal(pendingSharedPaper(request, indexSharedRecords([v2]), 'updated').status, 'missing');
  assert.equal(pendingSharedPaper(request, indexSharedRecords([versioned, { ...versioned }]), 'updated').status, 'ambiguous');
  assert.equal(pendingSharedPaper(null, indexSharedRecords([versioned]), 'updated').status, 'invalid');
});

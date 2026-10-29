import { cleanDoi } from '../dist/core.js';
import { validateDownloadMetric } from '../dist/enrichment.js';
import { fetchPlosMetric } from './plos.mjs';

// Europe PMC's citation count and platform-wide bioRxiv usage totals are deliberately not used.
export function applyPublisherMetrics(papers, records = []) {
  return papers.map(paper => {
    const record = records.find(r => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
      const hasDoi = Object.hasOwn(r, 'doi');
      const hasPaperId = Object.hasOwn(r, 'paperId');
      if (!hasDoi && !hasPaperId) return false;
      // Every supplied identifier must agree; one match must not hide another conflict.
      if (hasDoi && (typeof r.doi !== 'string' || !cleanDoi(r.doi) || cleanDoi(r.doi) !== cleanDoi(paper.doi))) return false;
      if (hasPaperId && (typeof r.paperId !== 'string' || !r.paperId || r.paperId !== paper.id)) return false;
      // A malformed first export must not hide a later valid record for the same paper.
      return validateDownloadMetric(r);
    });
    if (!record) return paper;
    const { doi: _doi, paperId: _id, ...metric } = record;
    return { ...paper, downloadMetric: { ...metric, provenance: 'publisher_export' } };
  });
}
export async function fetchZenodoMetric(paper, fetchImpl = fetch) {
  // Only the publication's own record DOI qualifies, never a linked supplementary dataset.
  const match = /^10\.5281\/zenodo\.(\d+)$/i.exec(paper.doi || '');
  if (!match) return null;
  const response = await fetchImpl(`https://zenodo.org/api/records/${match[1]}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Zenodo HTTP ${response.status}`);
  const data = await response.json();
  if (cleanDoi(data.doi || data.metadata?.doi) !== cleanDoi(paper.doi)) throw new Error('下载统计记录与文献 DOI 不一致');
  const type = data.metadata?.resource_type?.id || (data.metadata?.upload_type === 'publication' ? data.metadata.publication_type : '');
  if (!['publication-article', 'publication-preprint', 'publication-report', 'article', 'preprint', 'report'].includes(type)) return null;
  const count = data.stats?.downloads;
  const metric = { count, kind: 'file_downloads', platform: 'Zenodo', window: 'cumulative', sourceUrl: `https://zenodo.org/records/${match[1]}`, fetchedAt: new Date().toISOString(), provenance: 'publisher_api' };
  return validateDownloadMetric(metric) ? metric : null;
}
export async function fetchPublisherMetric(paper, fetchImpl = fetch) {
  if (/^10\.1371\/journal\./i.test(paper.doi || '')) return fetchPlosMetric(paper, fetchImpl);
  return fetchZenodoMetric(paper, fetchImpl);
}

export async function refreshPublisherMetrics(papers, { fetchMetric = fetchPublisherMetric, limit = 20, checkedAt = new Date().toISOString() } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('下载统计批次上限无效');
  let attempted = 0;
  const output = [];
  for (const paper of papers) {
    if (!/^(10\.5281\/zenodo\.|10\.1371\/journal\.)/i.test(paper.doi || '')) { output.push(paper); continue; }
    if (attempted >= limit) { output.push({ ...paper, downloadRefresh: { status: 'skipped', reason: 'batch_limit' } }); continue; }
    attempted++;
    try {
      const metric = await fetchMetric(paper);
      const valid = validateDownloadMetric(metric);
      output.push({ ...paper, ...(valid ? { downloadMetric: metric } : {}), downloadRefresh: { status: valid ? 'updated' : 'not_available', checkedAt } });
    } catch {
      // Preserve both the count and its original collection time. The new
      // attempt is recorded separately and never copies upstream error text.
      output.push({ ...paper, downloadRefresh: { status: 'failed', checkedAt } });
    }
  }
  return output;
}

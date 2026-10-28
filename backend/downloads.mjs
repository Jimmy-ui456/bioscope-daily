import { cleanDoi } from '../dist/core.js';
import { validateDownloadMetric } from '../dist/enrichment.js';

// Europe PMC's citation count and platform-wide bioRxiv usage totals are deliberately not used.
export function applyPublisherMetrics(papers, records = []) {
  return papers.map(paper => {
    const record = records.find(r => (cleanDoi(r.doi) && cleanDoi(r.doi) === cleanDoi(paper.doi)) || (r.paperId && r.paperId === paper.id));
    if (!record || !validateDownloadMetric(record)) return paper;
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

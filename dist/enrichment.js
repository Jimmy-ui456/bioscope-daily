// Shared by the static reader and the unattended collection job. No credentials here.
export function sourceFingerprint(paper) {
  const text = `${paper.title}\n${paper.abstract || ''}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${(hash >>> 0).toString(16)}-${text.length}`;
}
export function validEnrichment(paper, item) {
  return !!item && item.sourceFingerprint === sourceFingerprint(paper) && typeof item.titleZh === 'string' && item.titleZh.length > 0 && typeof item.abstractZh === 'string' && item.titleZh.length < 1000 && item.abstractZh.length < 30000;
}
export function attachEnrichment(paper, catalog = {}) {
  const candidates = [paper.enrichment, catalog[paper.id], paper.doi && catalog[`doi:${paper.doi.toLowerCase()}`], paper.pmid && catalog[`pmid:${paper.pmid}`]];
  const candidate = candidates.find(item => validEnrichment(paper, item));
  if (candidate) return { ...paper, enrichment: candidate };
  const { enrichment: _stale, ...clean } = paper;
  return clean;
}
export function translationOf(paper) { return validEnrichment(paper, paper.enrichment) ? paper.enrichment : null; }
export function validateDownloadMetric(metric) {
  if (!metric || !Number.isSafeInteger(metric.count) || metric.count < 0) return false;
  if (!['pdf_downloads', 'file_downloads'].includes(metric.kind)) return false;
  if (!['cumulative', 'interval'].includes(metric.window)) return false;
  if (typeof metric.platform !== 'string' || !metric.platform.trim() || metric.platform.length > 100) return false;
  try { if (new URL(metric.sourceUrl).protocol !== 'https:') return false; } catch { return false; }
  if (!Number.isFinite(Date.parse(metric.fetchedAt))) return false;
  if (metric.window === 'interval' && (!/^\d{4}-\d{2}-\d{2}$/.test(metric.start) || !/^\d{4}-\d{2}-\d{2}$/.test(metric.end) || metric.start > metric.end)) return false;
  return true;
}
export function metricGroup(metric) {
  return `${metric.platform}|${metric.kind}|${metric.window}|${metric.start || ''}|${metric.end || ''}`;
}
export function rankableDownloadMetric(metric) {
  return validateDownloadMetric(metric) && !(Array.isArray(metric.missingPdfMonths) && metric.missingPdfMonths.length);
}
export function rankDownloads(papers, group) {
  return papers.filter(p => rankableDownloadMetric(p.downloadMetric) && (!group || metricGroup(p.downloadMetric) === group)).sort((a, b) => b.downloadMetric.count - a.downloadMetric.count);
}
export function metricLabel(metric) {
  if (!validateDownloadMetric(metric)) return '暂无下载数据';
  return `${metric.platform} · ${metric.kind === 'pdf_downloads' ? 'PDF 下载' : '文件下载'} · ${metric.window === 'cumulative' ? (metric.platform === 'PLOS' ? '平台返回月份累计' : '累计') : `${metric.start}—${metric.end}`}`;
}

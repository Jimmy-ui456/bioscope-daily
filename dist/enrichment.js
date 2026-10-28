import { checkEvidenceClaim } from './evidence.js?v=0.2.5';

// Shared by the static reader and the unattended collection job. No credentials here.
export function sourceFingerprint(paper) {
  const text = `${paper.title}\n${paper.abstract || ''}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${(hash >>> 0).toString(16)}-${text.length}`;
}
export function validEnrichment(paper, item) {
  return !!item && item.sourceFingerprint === sourceFingerprint(paper)
    && (item.sourceTitle === undefined || item.sourceTitle === paper.title)
    && (item.sourceAbstract === undefined || item.sourceAbstract === (paper.abstract || ''))
    && typeof item.titleZh === 'string' && item.titleZh.length > 0 && typeof item.abstractZh === 'string' && item.titleZh.length < 1000 && item.abstractZh.length < 30000;
}
export function attachEnrichment(paper, catalog = {}) {
  const candidates = [paper.enrichment, catalog[paper.id], paper.doi && catalog[`doi:${paper.doi.toLowerCase()}`], paper.pmid && catalog[`pmid:${paper.pmid}`]];
  const candidate = candidates.find(item => validEnrichment(paper, item));
  if (candidate) return { ...paper, enrichment: candidate };
  const { enrichment: _stale, ...clean } = paper;
  return clean;
}
export function translationOf(paper) { return validEnrichment(paper, paper.enrichment) ? paper.enrichment : null; }
export function interpretationOf(paper) {
  if (!paper || typeof paper !== 'object') return null;
  const translation = translationOf(paper);
  if (!translation || translation.origin !== 'model' || typeof paper.abstract !== 'string' || !paper.abstract.trim()) return null;
  const rejectedFields = [];
  const output = { ...translation, scope: 'abstract_only',
    model: typeof translation.model === 'string' ? translation.model : null,
    createdAt: typeof translation.createdAt === 'string' ? translation.createdAt : null,
    limitations: [], rejectedFields };
  for (const key of ['question', 'methods', 'findings']) {
    output[key] = checkEvidenceClaim(paper, translation[key]);
    if (translation[key] != null && !output[key]) rejectedFields.push(key);
  }
  if (translation.limitations != null && !Array.isArray(translation.limitations)) rejectedFields.push('limitations');
  if (Array.isArray(translation.limitations)) {
    translation.limitations.slice(0, 8).forEach((value, index) => {
      const checked = checkEvidenceClaim(paper, value);
      if (checked) output.limitations.push(checked);
      else rejectedFields.push(`limitations[${index}]`);
    });
    if (translation.limitations.length > 8) rejectedFields.push('limitations[8+]');
  }
  return output;
}
function validMetricDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validMetricTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  const date = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value);
  return !!date && validMetricDate(date[1]);
}
export function validateDownloadMetric(metric) {
  if (!metric || !Number.isSafeInteger(metric.count) || metric.count < 0) return false;
  if (!['pdf_downloads', 'file_downloads'].includes(metric.kind)) return false;
  if (!['cumulative', 'interval'].includes(metric.window)) return false;
  if (typeof metric.platform !== 'string' || !metric.platform.trim() || metric.platform.length > 100) return false;
  if (typeof metric.sourceUrl !== 'string') return false;
  try { const url = new URL(metric.sourceUrl); if (url.protocol !== 'https:' || url.username || url.password) return false; } catch { return false; }
  if (!validMetricTimestamp(metric.fetchedAt)) return false;
  if (metric.window === 'interval' && (!validMetricDate(metric.start) || !validMetricDate(metric.end) || metric.start > metric.end)) return false;
  if (metric.missingPdfMonths !== undefined && (!Array.isArray(metric.missingPdfMonths)
    || !metric.missingPdfMonths.every(month => typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) && validMetricDate(`${month}-01`)))) return false;
  return true;
}
export function metricGroup(metric) {
  return `${metric.platform}|${metric.kind}|${metric.window}|${metric.start || ''}|${metric.end || ''}`;
}
export function rankableDownloadMetric(metric) {
  return validateDownloadMetric(metric) && !(Array.isArray(metric.missingPdfMonths) && metric.missingPdfMonths.length);
}
export function rankDownloads(papers, group) {
  const rankable = papers.filter(p => rankableDownloadMetric(p.downloadMetric));
  // Without an explicit selection, different platforms/formats/windows cannot share a ranking.
  if (!group && new Set(rankable.map(p => metricGroup(p.downloadMetric))).size > 1) return [];
  return rankable.filter(p => !group || metricGroup(p.downloadMetric) === group).sort((a, b) => b.downloadMetric.count - a.downloadMetric.count);
}
export function metricLabel(metric) {
  if (!validateDownloadMetric(metric)) return '暂无下载数据';
  return `${metric.platform} · ${metric.kind === 'pdf_downloads' ? 'PDF 下载' : '文件下载'} · ${metric.window === 'cumulative' ? (metric.platform === 'PLOS' ? '平台返回月份累计' : '累计') : `${metric.start}—${metric.end}`}`;
}

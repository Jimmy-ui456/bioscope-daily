import { checkEvidenceClaim } from './evidence.js?v=0.2.10';

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
  const valid = candidates.filter(item => validEnrichment(paper, item));
  const candidate = valid[0];
  if (candidate) {
    // Source warnings survive a newer translation, but only for the same exact
    // title and abstract. They describe the supplied source, not study quality.
    const noted = valid.find(item => item.sourceTitle === paper.title && item.sourceAbstract === (paper.abstract || '')
      && typeof item.sourceNote === 'string' && item.sourceNote.trim() && item.sourceNote.length <= 1000);
    const { sourceNote: _unchecked, ...enrichment } = candidate;
    return { ...paper, enrichment: { ...enrichment, ...(noted ? { sourceNote: noted.sourceNote.trim() } : {}) } };
  }
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
function validMetricMonth(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) && validMetricDate(`${value}-01`);
}
export function validateDownloadMetric(metric) {
  if (!metric || !Number.isSafeInteger(metric.count) || metric.count < 0) return false;
  if (!['pdf_downloads', 'file_downloads'].includes(metric.kind)) return false;
  if (!['cumulative', 'interval'].includes(metric.window)) return false;
  if (typeof metric.platform !== 'string' || !metric.platform.trim() || metric.platform.length > 100) return false;
  if (typeof metric.sourceUrl !== 'string') return false;
  try { const url = new URL(metric.sourceUrl); if (url.protocol !== 'https:' || url.username || url.password) return false; } catch { return false; }
  if (!validMetricTimestamp(metric.fetchedAt)) return false;
  const hasStart = metric.start !== undefined && metric.start !== null && metric.start !== '';
  const hasEnd = metric.end !== undefined && metric.end !== null && metric.end !== '';
  if ((hasStart && !validMetricDate(metric.start)) || (hasEnd && !validMetricDate(metric.end))) return false;
  if (hasStart && hasEnd && metric.start > metric.end) return false;
  if (metric.window === 'interval' && (!hasStart || !hasEnd)) return false;
  for (const field of ['missingPdfMonths', 'unreportedMonths']) {
    if (metric[field] !== undefined && (!Array.isArray(metric[field]) || !metric[field].every(validMetricMonth))) return false;
  }
  return true;
}
export function metricGroup(metric) {
  if (!validateDownloadMetric(metric)) return null;
  return `${metric.platform}|${metric.kind}|${metric.window}|${metric.start || ''}|${metric.end || ''}`;
}
export function rankableDownloadMetric(metric) {
  if (!validateDownloadMetric(metric) || metric.missingPdfMonths?.length || metric.unreportedMonths?.length) return false;
  const countedMonths = metric.coverageMonths;
  if (Number.isSafeInteger(countedMonths) && countedMonths >= 0) {
    if (Number.isSafeInteger(metric.reportedMonths) && metric.reportedMonths > countedMonths) return false;
    for (const [start, end] of [[metric.coverageStart, metric.coverageEnd], [metric.reportedStart, metric.reportedEnd]]) {
      if (!validMetricMonth(start) || !validMetricMonth(end) || start > end) continue;
      const monthIndex = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
      // Legacy snapshots may predate explicit missing-month flags. A known internal
      // span with fewer counted months still proves that this is a partial total.
      if (monthIndex(end) - monthIndex(start) + 1 > countedMonths) return false;
    }
  }
  return true;
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
export function metricCoverageLabel(metric) {
  if (!validateDownloadMetric(metric)) return '暂无可核对的统计范围';
  const parts = [];
  if (metric.window === 'interval') parts.push(`统计期间：${metric.start}—${metric.end}`);
  else {
    const hasReportedRange = validMetricMonth(metric.reportedStart) && validMetricMonth(metric.reportedEnd) && metric.reportedStart <= metric.reportedEnd;
    if (hasReportedRange) parts.push(`平台返回月份：${metric.reportedStart === metric.reportedEnd ? metric.reportedStart : `${metric.reportedStart}—${metric.reportedEnd}`}`);
    const hasCountRange = validMetricMonth(metric.coverageStart) && validMetricMonth(metric.coverageEnd) && metric.coverageStart <= metric.coverageEnd;
    const countRange = hasCountRange ? (metric.coverageStart === metric.coverageEnd ? metric.coverageStart : `${metric.coverageStart}—${metric.coverageEnd}`) : null;
    const kind = metric.kind === 'pdf_downloads' ? 'PDF' : '文件';
    if (Number.isSafeInteger(metric.coverageMonths) && metric.coverageMonths >= 0) {
      parts.push(countRange ? `已知${kind}计数月份：${countRange}（${metric.coverageMonths}个月）` : `有效${kind}计数月份：${metric.coverageMonths}个月（起止月份未提供）`);
    } else if (countRange) parts.push(`已知${kind}计数月份：${countRange}（有效月份数未提供）`);
    if (!hasReportedRange) parts.push('累计统计的完整起止月份范围未提供');
  }
  if (metric.missingPdfMonths?.length) parts.push(`已报告但缺PDF计数：${metric.missingPdfMonths.join('、')}（未按0计）`);
  if (metric.unreportedMonths?.length) parts.push(`整月缺报：${metric.unreportedMonths.join('、')}（未按0计）`);
  return parts.join('；');
}
export function metricFetchedAtLabel(metric) {
  const value = metric?.fetchedAt;
  if (!validMetricTimestamp(value)) return '采集时间未提供';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}（具体时间未提供）`;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return `${value}（时区未提供）`;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}（北京）`;
}
export function downloadRefreshLabel(paper) {
  const refresh = paper?.downloadRefresh;
  if (!refresh || typeof refresh !== 'object' || Array.isArray(refresh)) return '';
  const retained = validateDownloadMetric(paper.downloadMetric) ? '保留原先计数及其采集时间，不代表本次已更新。' : '下载量保持未知，不记为0。';
  if (refresh.status === 'skipped' && refresh.reason === 'batch_limit') return `最近下载统计批次达到上限，此篇未请求。${retained}`;
  if (!validMetricTimestamp(refresh.checkedAt)) return '';
  const at = metricFetchedAtLabel({ fetchedAt: refresh.checkedAt });
  if (refresh.status === 'updated' && validateDownloadMetric(paper.downloadMetric)) return `最近逐篇刷新：${at}，取得有效原平台统计。`;
  if (refresh.status === 'failed') return `最近逐篇刷新：${at}，下载统计请求失败。${retained}`;
  if (refresh.status === 'not_available') return `最近逐篇刷新：${at}，未返回有效的原平台逐篇统计。${retained}`;
  return '';
}

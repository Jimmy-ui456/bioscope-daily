import { isValidPaper, validPublicationDate } from './core.js?v=0.2.16';

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validTime(value) {
  if (typeof value !== 'string') return false;
  const iso = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  return Boolean(iso) && validPublicationDate(iso[1]) && Number.isFinite(Date.parse(value));
}
function validReport(report) {
  if (!record(report) || report.kind !== 'public_daily'
    || !validPublicationDate(report.date) || report.id !== `public-daily-${report.date}`
    || !validPublicationDate(report.windowStart) || report.windowStart > report.date
    || !validTime(report.createdAt) || !['live', 'sample'].includes(report.origin)
    || !Array.isArray(report.papers) || report.papers.length > 10
    || !report.papers.every(paper => isValidPaper(paper) && paper.id.trim() && paper.title.trim())) return false;
  const ids = new Set(report.papers.map(paper => paper.id));
  if (report.sections !== undefined && (!Array.isArray(report.sections)
    || !report.sections.every(section => record(section) && typeof section.label === 'string'
      && Array.isArray(section.paperIds) && section.paperIds.every(id => typeof id === 'string' && ids.has(id))))) return false;
  // Only these optional policy fields reach the reader's text rendering. A
  // malformed object must not reach String() through a shadowed toString field.
  for (const key of ['description', 'coverageNote']) {
    const value = report.selectionPolicy?.[key];
    if (value !== undefined && value !== null && typeof value !== 'string') return false;
  }
  return true;
}

function firstIssues(reports) {
  const byDate = new Map();
  let skipped = 0;
  for (const report of reports) {
    if (!validReport(report)) { skipped++; continue; }
    const previous = byDate.get(report.date);
    if (!previous) byDate.set(report.date, report);
    else {
      skipped++;
      if (Date.parse(report.createdAt) < Date.parse(previous.createdAt)) byDate.set(report.date, report);
    }
  }
  return { byDate, skipped };
}
function orderedReports(byDate) {
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
}

// Validate whole frozen issues, never silently remove one invalid paper from an
// issued report. Failed/partial reads retain previously validated missing dates.
export function preparePublicArchive(data, previous = { reports: [], status: 'unavailable', skipped: 0 }) {
  const old = firstIssues(Array.isArray(previous?.reports) ? previous.reports : []);
  if (!record(data) || !Array.isArray(data.reports)) {
    return { reports: orderedReports(old.byDate), status: 'unavailable', skipped: 0 };
  }
  const current = firstIssues(data.reports);
  if (!current.skipped) return { reports: orderedReports(current.byDate), status: 'ok', skipped: 0 };
  for (const [date, report] of old.byDate) if (!current.byDate.has(date)) current.byDate.set(date, report);
  return { reports: orderedReports(current.byDate), status: 'partial', skipped: current.skipped };
}

export function publicArchiveNotice(archive) {
  if (archive?.status === 'unavailable') {
    return Array.isArray(archive.reports) && archive.reports.length
      ? '公共日报档案本次未能读取，继续显示上次已校验的期次；暂时无法确认档案是否更新，请稍后重试。'
      : '公共日报档案本次未能读取，暂时无法确认有无可用期次；请稍后重试。';
  }
  if (archive?.status === 'partial') {
    const count = Number.isSafeInteger(archive.skipped) && archive.skipped > 0 ? ` ${archive.skipped} 条` : '';
    return `公共日报档案部分期次未通过校验，已跳过${count}无效或重复记录；只显示已校验的期次，上次有效期次不会因此清空。不能据此认定本次档案完整更新。`;
  }
  return '';
}

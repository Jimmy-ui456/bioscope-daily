import { TOPICS, isValidPaper, mergePapersWithIdMap, validPublicationDate } from './core.js?v=0.2.10';

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validTime(value) {
  if (typeof value !== 'string') return false;
  const iso = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  return Boolean(iso) && validPublicationDate(iso[1]) && Number.isFinite(Date.parse(value));
}
function validReport(report) {
  return record(report) && typeof report.id === 'string' && /^brief-\d+$/.test(report.id)
    && validPublicationDate(report.date) && validPublicationDate(report.windowStart)
    && report.windowStart <= report.date && validTime(report.createdAt)
    && Array.isArray(report.papers) && report.papers.every(isValidPaper);
}

// Ordinary sample caches are not collection results. Explicitly imported papers
// survive a reload alongside the shared library, including their retained IDs.
export function sharedLibraryPapers(cache, sharedPapers) {
  const retainCache = cache?.origin === 'live' || cache?.containsImported === true;
  const cached = retainCache && Array.isArray(cache?.papers) ? cache.papers.filter(isValidPaper) : [];
  const shared = Array.isArray(sharedPapers) ? sharedPapers.filter(isValidPaper) : [];
  return mergePapersWithIdMap(cached, shared).papers.slice(0, 500);
}

// Prepare every value before the caller changes browser state or storage.
// Frozen reports retain their own papers and evidence; existing IDs take priority.
export function prepareBackupImport(current, data, { now = new Date() } = {}) {
  if (!record(data) || data.app !== 'bioscope' || data.version !== 1 || !Array.isArray(data.papers) || data.papers.length > 500) {
    throw new Error('不是有效的 BioScope 备份');
  }
  if (!data.papers.every(isValidPaper)) throw new Error('备份含有无效文献字段');
  if (!record(current) || !['papers', 'selected', 'bookmarks', 'reports'].every(key => Array.isArray(current[key]))) {
    throw new Error('当前个人数据结构无法确认，未合并备份');
  }
  const ids = new Set(data.papers.map(paper => paper.id));
  const merged = mergePapersWithIdMap(current.papers, data.papers);
  const importIds = (existing, incoming) => [...new Set([
    ...existing,
    ...(Array.isArray(incoming) ? incoming.filter(id => typeof id === 'string' && ids.has(id)) : []),
  ].map(id => merged.idMap.get(id) ?? id))];
  let skippedReports = 0;
  const importedReports = [];
  for (const report of Array.isArray(data.reports) ? data.reports : []) {
    if (!validReport(report)) { skippedReports++; continue; }
    importedReports.push({ id: report.id, date: report.date, windowStart: report.windowStart,
      createdAt: report.createdAt, origin: report.origin === 'live' ? 'live' : 'sample', papers: report.papers.slice(0, 10) });
  }
  const reports = [...new Map([...importedReports, ...current.reports].map(report => [report.id, report])).values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 14);
  const importedTopics = Array.isArray(data.settings?.topics)
    ? data.settings.topics.filter(id => TOPICS.some(topic => topic.id === id)) : [];
  const settings = importedTopics.length ? {
    topics: [...new Set(importedTopics)],
    days: [7, 14, 30, 90].includes(Number(data.settings.days)) ? Number(data.settings.days) : 30,
    reportDays: [1, 7, 30].includes(Number(data.settings.reportDays)) ? Number(data.settings.reportDays) : 7,
  } : current.settings;
  const updatedAt = validTime(data.updatedAt) ? data.updatedAt : new Date(now).toISOString();
  return { patch: { papers: merged.papers.slice(0, 500), selected: importIds(current.selected, data.selected),
    bookmarks: importIds(current.bookmarks, data.bookmarks), reports, settings, origin: 'sample', containsImported: true, updatedAt }, skippedReports };
}

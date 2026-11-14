import { TOPICS, isValidPaper, validPublicationDate } from './core.js?v=0.2.20';

const KEYS = ['settings', 'cache', 'readerFilters', 'bookmarks', 'selected', 'reports', 'displayMode'];
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validTime(value) {
  if (typeof value !== 'string') return false;
  const iso = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  return Boolean(iso) && validPublicationDate(iso[1]) && Number.isFinite(Date.parse(value));
}
function usablePaper(value) { return isValidPaper(value) && Boolean(value.id.trim()) && Boolean(value.title.trim()); }
function numberChoice(value, allowed, fallback) {
  if (!['number', 'string'].includes(typeof value)) return { value: fallback, valid: value === undefined };
  const number = Number(value);
  return allowed.includes(number) ? { value: number, valid: true } : { value: fallback, valid: false };
}
function validReport(value) {
  return record(value) && typeof value.id === 'string' && /^brief-\d+$/.test(value.id)
    && (value.kind === undefined || value.kind === 'personal')
    && validPublicationDate(value.date) && validPublicationDate(value.windowStart)
    && value.windowStart <= value.date && validTime(value.createdAt)
    && (value.origin === undefined || ['live', 'sample'].includes(value.origin))
    && Array.isArray(value.papers) && value.papers.length <= 10 && value.papers.every(usablePaper);
}
function restoreStat(value) {
  if (!record(value) || typeof value.topic !== 'string' || !value.topic.trim()) return null;
  for (const key of ['count', 'hitCount']) {
    if (value[key] !== undefined && value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
  }
  if (value.truncated !== undefined && value.truncated !== null && typeof value.truncated !== 'boolean') return null;
  if (value.error !== undefined && typeof value.error !== 'string') return null;
  return { topic: value.topic, count: value.count ?? null, hitCount: value.hitCount ?? null,
    truncated: value.truncated ?? null, ...(value.error !== undefined ? { error: value.error } : {}) };
}

// Startup only reads storage. A recovered in-memory value must never silently
// replace the original record; the caller protects every key reported here.
export function readLocalReaderState(storage, prefix = 'bioscope.v1.') {
  const rawRecords = Object.create(null), values = Object.create(null), issues = [], protectedKeys = [];
  function issue(key, message) {
    if (protectedKeys.includes(key)) return;
    protectedKeys.push(key); issues.push({ key, message });
  }
  for (const key of KEYS) {
    let raw;
    try { raw = storage.getItem(prefix + key); }
    catch { issue(key, '本机此类记录暂时无法读取，当前页面使用安全默认值；原记录未改写。'); continue; }
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string') { issue(key, '本机此类记录格式无法识别，当前页面使用安全默认值；原记录未改写。'); continue; }
    rawRecords[key] = raw;
    try { values[key] = JSON.parse(raw); }
    catch { issue(key, '本机此类记录未能解析，当前页面使用安全默认值；原记录未改写。'); }
  }

  const settings = { topics: TOPICS.map(topic => topic.id), days: 30, reportDays: 7 };
  if (values.settings !== undefined) {
    const saved = values.settings;
    if (!record(saved)) issue('settings', '本机监控设置结构无效，已在本页使用默认设置。');
    else {
      let invalid = false;
      if (saved.topics !== undefined) {
        const topics = Array.isArray(saved.topics) ? saved.topics.filter(id => TOPICS.some(topic => topic.id === id)) : [];
        const unique = [...new Set(topics)];
        invalid ||= !Array.isArray(saved.topics) || topics.length !== saved.topics.length || unique.length !== topics.length || !unique.length;
        if (unique.length) settings.topics = unique;
      }
      for (const [key, allowed, fallback] of [['days', [7, 14, 30, 90], 30], ['reportDays', [1, 7, 30], 7]]) {
        const restored = numberChoice(saved[key], allowed, fallback);
        settings[key] = restored.value; invalid ||= !restored.valid;
      }
      if (invalid) issue('settings', '本机监控设置含无效字段，已在本页保留可用设置。');
    }
  }

  const readerFilters = { journal: 'all', days: 0, kind: 'all', abstract: 'all' };
  if (values.readerFilters !== undefined) {
    const saved = values.readerFilters;
    if (!record(saved)) issue('readerFilters', '本机阅读筛选结构无效，已在本页使用默认筛选。');
    else {
      let invalid = false;
      if (saved.journal !== undefined) {
        if (typeof saved.journal === 'string') readerFilters.journal = saved.journal;
        else invalid = true;
      }
      const days = numberChoice(saved.days, [0, 1, 7, 30, 90], 0);
      readerFilters.days = days.value; invalid ||= !days.valid;
      for (const [key, allowed] of [['kind', ['all', 'article', 'review', 'preprint', 'other']], ['abstract', ['all', 'available', 'missing']]]) {
        if (saved[key] === undefined) continue;
        if (allowed.includes(saved[key])) readerFilters[key] = saved[key];
        else invalid = true;
      }
      if (invalid) issue('readerFilters', '本机阅读筛选含无效字段，已在本页保留可用筛选。');
    }
  }

  const restoreIds = key => {
    const saved = values[key];
    if (saved === undefined) return [];
    if (!Array.isArray(saved)) { issue(key, '本机编号列表结构无效，当前页面暂用空列表；原记录未改写。'); return []; }
    const valid = saved.filter(id => typeof id === 'string' && id.trim());
    const unique = [...new Set(valid)];
    if (unique.length !== saved.length) issue(key, `本机编号列表有 ${saved.length - unique.length} 条无效或重复记录，已在本页跳过；其余编号保留。`);
    return unique;
  };
  const bookmarks = restoreIds('bookmarks'), selected = restoreIds('selected');

  let reports = [];
  if (values.reports !== undefined) {
    if (!Array.isArray(values.reports)) issue('reports', '本机个人日报结构无效，当前页面暂不使用这些期次；原记录未改写。');
    else {
      const byId = new Map();
      let skipped = 0, changed = false;
      for (const report of values.reports) {
        if (!validReport(report) || byId.has(report.id)) { skipped++; continue; }
        changed ||= report.origin === undefined;
        byId.set(report.id, { id: report.id, date: report.date, windowStart: report.windowStart, createdAt: report.createdAt,
          origin: report.origin === 'live' ? 'live' : 'sample', papers: report.papers });
      }
      const valid = [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      reports = valid.slice(0, 14);
      skipped += Math.max(0, valid.length - reports.length);
      if (skipped || changed) issue('reports', skipped
        ? `本机个人日报有 ${skipped} 条无效、重复或超出保留数量的记录未载入；可用期次保留，缺失来源不当作实时采集。`
        : '本机个人日报缺少来源标记，已在本页按来源未核验的记录恢复；原始记录未改写。');
    }
  }

  let cache = null;
  if (values.cache !== undefined) {
    const saved = values.cache;
    if (!record(saved) || !Array.isArray(saved.papers)) issue('cache', '本机文献库结构无效，当前页面将尝试其他可用数据；原记录未改写。');
    else {
      const valid = saved.papers.filter(usablePaper), papers = valid.slice(0, 500);
      const dropped = saved.papers.length - papers.length;
      let invalid = dropped > 0;
      const origin = ['live', 'sample'].includes(saved.origin) ? saved.origin : 'sample';
      invalid ||= !['live', 'sample'].includes(saved.origin);
      const containsImported = saved.containsImported === true;
      invalid ||= saved.containsImported !== undefined && typeof saved.containsImported !== 'boolean';
      const updatedAt = validTime(saved.updatedAt) ? saved.updatedAt : null;
      invalid ||= saved.updatedAt !== undefined && saved.updatedAt !== null && updatedAt === null;
      let stats = [];
      if (saved.stats !== undefined) {
        if (!Array.isArray(saved.stats)) invalid = true;
        else {
          stats = saved.stats.map(restoreStat).filter(Boolean);
          invalid ||= stats.length !== saved.stats.length;
        }
      }
      if (!saved.papers.length || papers.length) cache = { papers, origin, containsImported, updatedAt, stats };
      if (invalid) issue('cache', dropped
        ? `本机文献库有 ${dropped} 条无效或超出上限的文献，已在本页保留可用内容并安全处理异常字段；原记录未改写。`
        : '本机文献库含异常来源、时间或统计字段，已在本页保留可用内容；原记录未改写。');
    }
  }
  let displayMode = 'bilingual';
  if (values.displayMode !== undefined) {
    if (['en', 'bilingual'].includes(values.displayMode)) displayMode = values.displayMode;
    else issue('displayMode', '本机显示语言设置无效，当前页面使用中英对照；原记录未改写。');
  }
  return { settings, cache, readerFilters, bookmarks, selected, reports, displayMode, issues, protectedKeys, rawRecords };
}

// This is an explicit recovery action, separate from startup and routine writes.
// Recheck each original raw value before replacing it so a newer tab's edit is
// preserved. Storage has no multi-key transaction; successful keys are reported.
export function persistLocalRecovery(storage, values, { protectedKeys = [], rawRecords = {}, prefix = 'bioscope.v1.' } = {}) {
  const result = { saved: [], failed: [], changed: [] };
  const keys = [...new Set(Array.isArray(protectedKeys) ? protectedKeys : [])].filter(key => KEYS.includes(key));
  for (const key of keys) {
    try {
      if (!record(values) || !Object.hasOwn(values, key)) { result.failed.push(key); continue; }
      const current = storage.getItem(prefix + key);
      const hasOriginal = record(rawRecords) && Object.hasOwn(rawRecords, key) && typeof rawRecords[key] === 'string';
      if (hasOriginal ? current !== rawRecords[key] : current !== null && current !== undefined) { result.changed.push(key); continue; }
      const serialized = JSON.stringify(values[key]);
      if (typeof serialized !== 'string') { result.failed.push(key); continue; }
      storage.setItem(prefix + key, serialized);
      result.saved.push(key);
    } catch { result.failed.push(key); }
  }
  return result;
}

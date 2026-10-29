import { TOPICS, beijingDay, cleanDoi, dayBefore, mergePapers, isRetracted } from '../dist/core.js';
import { attachEnrichment } from '../dist/enrichment.js';
import { validWorkflowRunUrl } from '../dist/collection-source.js';

export const PUBLIC_REPORT_RULE_VERSION = 'publication-calendar-topic-round-robin-v1';
export const PUBLIC_REPORT_DESCRIPTION = '按发表日期和主题覆盖规则自动整理的文献清单，非人工科研价值精选。';

function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function topicDefinitions(topics) {
  const definitions = new Map();
  for (const topic of topics) {
    const definition = typeof topic === 'string' ? TOPICS.find(t => t.id === topic) : topic;
    if (!definition || typeof definition.id !== 'string' || !definition.id.trim()) continue;
    if (!definitions.has(definition.id)) definitions.set(definition.id, { id: definition.id, name: definition.name || definition.id });
  }
  if (!definitions.size) throw new Error('公开日报至少需要一个有效主题');
  return [...definitions.values()];
}

function identityAliases(paper) {
  return [
    typeof paper.id === 'string' && `id:${paper.id}`,
    cleanDoi(paper.doi) && `doi:${cleanDoi(paper.doi)}`,
    paper.pmid && `pmid:${paper.pmid}`,
  ].filter(Boolean);
}

function usableRecord(paper) {
  return paper && typeof paper === 'object' && typeof paper.id === 'string' && paper.id.trim()
    && typeof paper.title === 'string' && paper.title.trim() && Array.isArray(paper.topics)
    && (paper.publishedAt == null || typeof paper.publishedAt === 'string');
}

function comparePublications(a, b) {
  if (a.publishedAt !== b.publishedAt) return a.publishedAt > b.publishedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function collectionSnapshot(source) {
  if (!source || !['complete', 'partial'].includes(source.status) || !Array.isArray(source.failedTopics)
    || !source.failedTopics.every(topic => typeof topic === 'string' && topic.trim() && topic.length <= 200)) return null;
  return {
    status: source.status,
    failedTopics: [...source.failedTopics],
    trigger: ['schedule', 'workflow_dispatch', 'local'].includes(source.trigger) ? source.trigger : 'unknown',
    runUrl: validWorkflowRunUrl(source.runUrl) ? source.runUrl : null,
  };
}

// A daily issue is a source snapshot, not a model-written evaluation or ranking.
export function createPublicReport(papers, {
  now = new Date(), date, days = 7, limit = 10, topics = TOPICS,
  translations = {}, origin = 'live', sourceUpdatedAt = null, sourceCollection = null,
} = {}) {
  const generatedAt = new Date(now);
  if (!Number.isFinite(generatedAt.getTime())) throw new Error('无效的日报生成时间');
  const today = beijingDay(generatedAt);
  const reportDate = date ?? today;
  if (!validCalendarDate(reportDate) || reportDate > today) throw new Error('日报日期应为真实且不晚于今天的北京日历日期');
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('日报日期范围应为正整数天');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('日报文献数量应为正整数');
  const effectiveLimit = Math.min(limit, 10);
  const definitions = topicDefinitions(topics);
  const knownTopics = new Set(definitions.map(t => t.id));
  const windowStart = dayBefore(days - 1, new Date(`${reportDate}T12:00:00+08:00`));
  const records = Array.isArray(papers) ? papers.filter(usableRecord) : [];
  // Preserve a retraction signal even if a duplicate's less complete metadata comes last.
  const retractedAliases = new Set(records.filter(isRetracted).flatMap(identityAliases));
  const deduplicated = mergePapers([], structuredClone(records));
  const candidates = deduplicated.filter(paper => !isRetracted(paper)
    && !identityAliases(paper).some(alias => retractedAliases.has(alias))
    && validCalendarDate(paper.publishedAt)
    && paper.publishedAt >= windowStart && paper.publishedAt <= reportDate
    && paper.topics.some(topic => knownTopics.has(topic)))
    .sort(comparePublications);

  const queues = definitions.map(topic => ({
    topic, papers: candidates.filter(paper => paper.topics.includes(topic.id)), index: 0, selected: [],
  }));
  const selectedIds = new Set();
  // One new paper per topic per round keeps a large topic from filling the whole issue.
  while (selectedIds.size < effectiveLimit) {
    let advanced = false;
    for (const queue of queues) {
      while (queue.index < queue.papers.length && selectedIds.has(queue.papers[queue.index].id)) queue.index++;
      if (queue.index >= queue.papers.length) continue;
      const paper = queue.papers[queue.index++];
      selectedIds.add(paper.id);
      queue.selected.push(paper);
      advanced = true;
      if (selectedIds.size === effectiveLimit) break;
    }
    if (!advanced) break;
  }
  const sections = queues.filter(queue => queue.selected.length).map(queue => ({
    topicId: queue.topic.id, label: queue.topic.name, paperIds: queue.selected.map(paper => paper.id),
  }));
  const selected = queues.flatMap(queue => queue.selected).map(paper => attachEnrichment(paper, translations));
  const report = {
    id: `public-daily-${reportDate}`,
    kind: 'public_daily',
    date: reportDate,
    windowStart,
    createdAt: generatedAt.toISOString(),
    origin: origin === 'sample' ? 'sample' : 'live',
    papers: selected,
    sections,
    sourceUpdatedAt,
    sourceCollection: collectionSnapshot(sourceCollection),
    selectionPolicy: {
      version: PUBLIC_REPORT_RULE_VERSION,
      description: PUBLIC_REPORT_DESCRIPTION,
      dateBasis: 'first_publication_date',
      windowDays: days,
      limit: effectiveLimit,
      topicOrder: definitions.map(topic => topic.id),
      ordering: '各主题按发表日期倒序，轮流取文献后按主题分节；日期相同时按文献标识排序。',
      coverageNote: '仅整理当前文献库及配置主题，不代表该领域的全部新文献；未依据下载量或科研质量评分排序。',
    },
    metrics: {
      inputCount: Array.isArray(papers) ? papers.length : 0,
      uniqueCount: deduplicated.length,
      candidateCount: candidates.length,
      selectedCount: selected.length,
      sectionCount: sections.length,
    },
  };
  // No nested object from the live library or translation catalog escapes into a frozen issue.
  return structuredClone(report);
}

// First publication of a date wins, including repeated same-day collection runs.
// Callers can offer a separate explicit revision flow if an issued report needs correction.
export function updatePublicReportHistory(history, report, {
  keepDays = 14, referenceDate = report?.date,
} = {}) {
  if (!report || report.kind !== 'public_daily' || !validCalendarDate(report.date) || !Array.isArray(report.papers)) throw new Error('无效的公开日报快照');
  if (!validCalendarDate(referenceDate)) throw new Error('无效的历史保留日期');
  if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > 366) throw new Error('历史保留范围应为正整数天');
  const start = dayBefore(keepDays - 1, new Date(`${referenceDate}T12:00:00+08:00`));
  const byDate = new Map();
  const existing = (Array.isArray(history) ? history : []).filter(item => item?.kind === 'public_daily'
    && validCalendarDate(item.date) && Array.isArray(item.papers))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  for (const item of [...existing, report]) {
    if (item.date < start || item.date > referenceDate || byDate.has(item.date)) continue;
    byDate.set(item.date, structuredClone(item));
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

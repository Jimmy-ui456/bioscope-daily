import { beijingDay, dayBefore } from './core.js';
export function paperKind(paper) {
  if (paper.isPreprint) return 'preprint';
  if (paper.type === '综述') return 'review';
  return paper.type === '期刊论文' ? 'article' : 'other';
}
export function journalName(paper) { return String(paper.journal || '期刊信息未提供').trim() || '期刊信息未提供'; }
export function filterReadingPapers(papers, filters, now = new Date()) {
  const end = beijingDay(now);
  const start = filters.days ? dayBefore(filters.days - 1, now) : null;
  return papers.filter(p =>
    (filters.journal === 'all' || journalName(p) === filters.journal) &&
    (filters.kind === 'all' || paperKind(p) === filters.kind) &&
    (!start || (p.publishedAt && p.publishedAt >= start && p.publishedAt <= end)) &&
    (filters.abstract === 'all' || (filters.abstract === 'available' ? Boolean(p.abstract?.trim()) : !p.abstract?.trim()))
  );
}

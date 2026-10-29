import { beijingDay, dayBefore, validPublicationDate } from './core.js?v=0.2.7';
export function paperKind(paper) {
  if (paper.isPreprint) return 'preprint';
  if (paper.type === '综述') return 'review';
  return paper.type === '期刊论文' ? 'article' : 'other';
}
export function journalName(paper) { return String(paper.journal || '期刊信息未提供').trim() || '期刊信息未提供'; }
export function readingBasePapers(papers, { view, topics, bookmarks }) {
  return view === 'bookmarks'
    ? papers.filter(paper => bookmarks.includes(paper.id))
    : papers.filter(paper => paper.topics.some(topic => topics.includes(topic)));
}

// Keep the composing input node in place. Browsers differ on whether the final
// input arrives before or after compositionend, so apply that final value once.
export function createSearchInputController(apply) {
  let composing = false, originalValue = null, trailingCompositionInput = null;
  return event => {
    const value = event.target?.value;
    if (typeof value !== 'string') return false;
    if (event.type === 'compositionstart') {
      composing = true; originalValue = value; trailingCompositionInput = null;
      return false;
    }
    if (event.type === 'compositionend') {
      const changed = originalValue === null || value !== originalValue;
      composing = false; originalValue = null; trailingCompositionInput = { target: event.target, value };
      if (changed) apply(value);
      return changed;
    }
    if (event.type !== 'input') return false;
    if (composing || event.isComposing) {
      composing = true; trailingCompositionInput = null;
      return false;
    }
    if (trailingCompositionInput !== null) {
      const alreadyApplied = event.target === trailingCompositionInput.target && value === trailingCompositionInput.value;
      trailingCompositionInput = null;
      if (alreadyApplied) return false;
    }
    apply(value);
    return true;
  };
}
export function filterReadingPapers(papers, filters, now = new Date()) {
  const end = beijingDay(now);
  const start = filters.days ? dayBefore(filters.days - 1, now) : null;
  return papers.filter(p =>
    (filters.journal === 'all' || journalName(p) === filters.journal) &&
    (filters.kind === 'all' || paperKind(p) === filters.kind) &&
    (!start || (validPublicationDate(p.publishedAt) && p.publishedAt >= start && p.publishedAt <= end)) &&
    (filters.abstract === 'all' || (filters.abstract === 'available' ? Boolean(p.abstract?.trim()) : !p.abstract?.trim()))
  );
}

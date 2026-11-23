import { TOPICS, cleanDoi, canonicalPmcid, paperPmcid, beijingDay, dayBefore, validPublicationDate, isRetracted } from './core.js?v=0.2.47';
import { attachEnrichment, translationOf } from './enrichment.js?v=0.2.47';
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
export function papersForDownloadRanking(papers) {
  return papers.filter(paper => !isRetracted(paper));
}

function canonicalSearchDoi(value) {
  // Preserve the suffix, including punctuation and Unicode width. Identifier
  // matching must not apply the compatibility folding used for ordinary text.
  return /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/.test(value) ? cleanDoi(value) : null;
}
function searchIdentifier(query) {
  const pmid = /^pmid\s*:\s*(\d+)$/i.exec(query);
  if (pmid) return { kind: 'pmid', value: pmid[1] };
  const taggedPmcid = /^pmcid\s*:\s*(?:PMC)?([1-9]\d*)$/i.exec(query);
  const pmcid = taggedPmcid ? `PMC${taggedPmcid[1]}` : canonicalPmcid(query);
  if (pmcid) return { kind: 'pmcid', value: pmcid };
  const candidate = query.replace(/^doi\s*:\s*/i, '');
  const bareHost = /^(?:doi\.org|dx\.doi\.org|pubmed\.ncbi\.nlm\.nih\.gov|europepmc\.org|pmc\.ncbi\.nlm\.nih\.gov)\//i.test(candidate);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) || bareHost) {
    try {
      if (/[\u0000-\u0020\u007f]/.test(candidate)) return null;
      const url = new URL(bareHost ? 'https://' + candidate : candidate);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
      const pathname = decodeURIComponent(url.pathname);
      if (url.hostname === 'doi.org' || url.hostname === 'dx.doi.org') {
        const doi = canonicalSearchDoi(pathname.slice(1));
        return doi ? { kind: 'doi', value: doi } : null;
      }
      if (url.hostname === 'pubmed.ncbi.nlm.nih.gov') {
        const match = /^\/(\d+)\/?$/.exec(pathname);
        return match ? { kind: 'pmid', value: match[1] } : null;
      }
      const pathPattern = url.hostname === 'europepmc.org' ? /^\/article\/PMC\/([^/]+)\/?$/
        : url.hostname === 'pmc.ncbi.nlm.nih.gov' ? /^\/articles\/([^/]+)\/?$/ : null;
      const pmcMatch = pathPattern?.exec(url.pathname);
      const pmcid = pmcMatch && canonicalPmcid(decodeURIComponent(pmcMatch[1]));
      if (pmcid) return { kind: 'pmcid', value: pmcid };
    } catch { /* Malformed URLs remain ordinary text queries, never navigation. */ }
    return null;
  }
  const doi = canonicalSearchDoi(candidate);
  return doi ? { kind: 'doi', value: doi } : null;
}
function searchableText(value) {
  return (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
    .normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}
export function searchReadingPapers(papers, query, catalog = {}) {
  const raw = typeof query === 'string' || typeof query === 'number' ? String(query).trim() : '';
  if (!raw) return papers.slice();
  const identifier = searchIdentifier(raw);
  if (identifier?.kind === 'doi') return papers.filter(paper => {
    const stored = typeof paper.doi === 'string' ? searchIdentifier(paper.doi.trim()) : null;
    return stored?.kind === 'doi' && stored.value === identifier.value;
  });
  if (identifier?.kind === 'pmid') return papers.filter(paper => {
    const value = typeof paper.pmid === 'string' ? paper.pmid.trim()
      : Number.isSafeInteger(paper.pmid) && paper.pmid >= 0 ? String(paper.pmid) : null;
    return value === identifier.value;
  });
  if (identifier?.kind === 'pmcid') return papers.filter(paper => paperPmcid(paper) === identifier.value);
  const text = searchableText(raw);
  if (!text) return papers.slice();
  return papers.filter(paper => {
    const translation = translationOf(attachEnrichment(paper, catalog));
    const topics = Array.isArray(paper.topics) ? paper.topics.flatMap(id => {
      const topic = TOPICS.find(item => item.id === id);
      return [id, topic?.name, topic?.en];
    }) : [];
    const fields = [paper.title, paper.abstract, translation?.titleZh, translation?.abstractZh,
      paper.authors, paper.journal, paper.doi, paper.pmid, ...topics];
    return fields.map(searchableText).join(' ').includes(text);
  });
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
  const byDiscovery = filters.dateBasis === 'discovered';
  const selected = papers.filter(p => {
    if (start) {
      const date = byDiscovery ? discoveryDay(p, now) : p.publishedAt;
      if (!validPublicationDate(date) || date < start || date > end) return false;
    }
    return (filters.journal === 'all' || journalName(p) === filters.journal) &&
      (filters.kind === 'all' || paperKind(p) === filters.kind) &&
      (filters.abstract === 'all' || (filters.abstract === 'available' ? Boolean(p.abstract?.trim()) : !p.abstract?.trim()));
  });
  if (byDiscovery) selected.sort((a, b) => discoveryTime(b, now) - discoveryTime(a, now));
  return selected;
}

function discoveryTime(paper, now) {
  const raw = paper.discoveredAt;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || !validPublicationDate(raw.slice(0, 10))) return -Infinity;
  const time = Date.parse(raw);
  return Number.isFinite(time) && time <= now.getTime() ? time : -Infinity;
}

export function discoveryDay(paper, now = new Date()) {
  const time = discoveryTime(paper, now);
  return Number.isFinite(time) ? beijingDay(new Date(time)) : null;
}

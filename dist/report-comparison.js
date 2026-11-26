import { cleanDoi, validPublicationDate } from './core.js?v=0.2.49';

function canonicalDoi(paper) {
  const value = paper?.doi;
  return typeof value === 'string' && value.length <= 2000 && !/[\p{Cc}\p{Cf}]/u.test(value) ? cleanDoi(value) : null;
}

export function sharedRecordIdentity(paper) {
  const doi = canonicalDoi(paper);
  const pmid = typeof paper?.pmid === 'string' && /^\d{1,20}$/.test(paper.pmid) ? paper.pmid : null;
  const source = paper?.collection === 'Europe PMC' && typeof paper.source === 'string'
    && /^[A-Z][A-Z0-9]{1,11}$/.test(paper.source) && typeof paper.sourceId === 'string'
    && /^[\w.:-]{1,160}$/u.test(paper.sourceId) ? `${paper.source}:${paper.sourceId}` : null;
  return { doi, pmid, source };
}

function add(index, key, paper) {
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(paper);
}

export function indexSharedRecords(papers) {
  const indexes = { doi: new Map(), pmid: new Map(), source: new Map() };
  for (const paper of Array.isArray(papers) ? papers : []) {
    const keys = sharedRecordIdentity(paper);
    for (const [key, value] of Object.entries(keys)) add(indexes[key], value, paper);
  }
  return indexes;
}

export function sameSharedRecord(paper, index) {
  const keys = sharedRecordIdentity(paper);
  const exact = index.doi.get(keys.doi);
  if (exact) return exact.length === 1 ? exact[0] : null;
  const candidates = new Set([...(index.pmid.get(keys.pmid) || []), ...(index.source.get(keys.source) || [])]);
  if (candidates.size !== 1) return null;
  const [candidate] = candidates;
  const otherDoi = canonicalDoi(candidate);
  return keys.doi && otherDoi && keys.doi !== otherDoi ? null : candidate;
}

function normalizedText(value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/[‘’`]/gu, "'").replace(/[“”]/gu, '"')
    .replace(/[‐‑–]/gu, '-').replace(/\s+/gu, ' ').trim() : '';
}
function normalizedTitle(value) {
  // Normalize conventional capitalization of words while retaining internal case and acronyms.
  return normalizedText(value).replace(/(?<![\p{L}\p{M}\p{N}])\p{Lu}(?=\p{Ll}{2,}(?![\p{L}\p{M}\p{N}]))/gu, char => char.toLowerCase());
}

function sourceVersion(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : normalizedText(value);
}

export function changedOriginalFields(before, after) {
  const normalizeAuthors = value => normalizedText(value).replace(/\s*,\s*/gu, ',');
  const date = value => validPublicationDate(value) ? value : null;
  return [
    ['title', normalizedTitle],
    ['abstract', normalizedText],
    ['authors', normalizeAuthors],
    ['publishedAt', date],
    ['version', sourceVersion],
  ].filter(([field, normalize]) => normalize(before[field]) !== normalize(after[field])).map(([field]) => field);
}

export function sharedReportChanges(report, index) {
  return report.papers.map(paper => {
    const current = sameSharedRecord(paper, index);
    return current ? changedOriginalFields(paper, current) : [];
  });
}

import { cleanDoi } from './core.js?v=0.2.43';
import { sourceFingerprint } from './enrichment.js?v=0.2.43';

export const READ_MARK_LIMIT = 5000;

function compact(value, limit) {
  return typeof value === 'string' && value.length <= limit && value.trim() && !/[\p{Cc}]/u.test(value) ? value : null;
}

export function readMarkFor(paper) {
  const id = compact(paper.id, 1200);
  if (!id) return null;
  const doi = cleanDoi(compact(paper.doi, 1024)) || (id.startsWith('doi:') ? cleanDoi(compact(id, 1028)) : null);
  const pmid = typeof paper.pmid === 'string' && /^\d{1,20}$/.test(paper.pmid) ? paper.pmid : null;
  const rawVersion = typeof paper.version === 'number' && Number.isSafeInteger(paper.version) ? String(paper.version) : paper.version;
  return { id, doi, pmid, fingerprint: sourceFingerprint(paper), version: compact(rawVersion, 100) };
}

export function restoreReadMarks(value) {
  if (value === undefined) return { marks: [], skipped: 0 };
  if (!Array.isArray(value)) return { marks: [], skipped: 1 };
  const marks = [], seen = new Set();
  for (const entry of value) {
    if (marks.length >= READ_MARK_LIMIT) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { id, doi, pmid, fingerprint, version } = entry;
    if (!compact(id, 1200) || (doi !== null && (!compact(doi, 1024) || cleanDoi(doi) !== doi))
      || (pmid !== null && (typeof pmid !== 'string' || !/^\d{1,20}$/.test(pmid)))
      || typeof fingerprint !== 'string' || !/^[a-f\d]{1,8}-\d{1,12}$/.test(fingerprint)
      || (version !== null && !compact(version, 100))) continue;
    const mark = { id, doi, pmid, fingerprint, version };
    const key = JSON.stringify(mark);
    if (seen.has(key)) continue;
    seen.add(key); marks.push(mark);
  }
  return { marks, skipped: value.length - marks.length };
}

function aliases({ id, doi, pmid }) {
  return [`id:${id}`, ...(doi ? [`doi:${doi}`] : []), ...(pmid ? [`pmid:${pmid}`] : [])];
}

export function indexReadMarks(marks) {
  const index = new Map();
  for (const mark of marks) for (const alias of aliases(mark)) {
    if (!index.has(alias)) index.set(alias, []);
    index.get(alias).push(mark);
  }
  return index;
}

export function matchingReadMarks(index, version) {
  if (!version) return new Set();
  const matches = new Set(aliases(version).flatMap(alias => index.get(alias) || []).filter(mark =>
    mark.fingerprint === version.fingerprint && mark.version === version.version
    && (!mark.doi || !version.doi || mark.doi === version.doi)));
  if (!version.doi && new Set([...matches].map(mark => mark.doi).filter(Boolean)).size > 1) return new Set();
  return matches;
}

export function filterByReadProgress(papers, progress, index) {
  if (progress !== 'read' && progress !== 'unread') return papers;
  return papers.filter(paper => Boolean(matchingReadMarks(index, readMarkFor(paper)).size) === (progress === 'read'));
}

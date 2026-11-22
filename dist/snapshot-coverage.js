import { beijingDay, dayBefore, mergePapersWithIdMap, validPublicationDate } from './core.js?v=0.2.39';
import { discoveryDay } from './reader.js?v=0.2.39';

export function snapshotTime(value) {
  const iso = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  return iso && validPublicationDate(iso[1]) && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
}

const coverageByLibrary = new WeakMap();
function deriveCoverage(library) {
  const asOf = snapshotTime(library?.fetchedAt);
  let total = null;
  const counts = new Map();
  if (Array.isArray(library?.papers)) {
    const papers = library.papers.filter(paper => typeof paper?.id === 'string' && paper.id.trim())
      .map(({ id, doi, pmid, discoveredAt }) => ({ id, doi, pmid, discoveredAt, title: id, topics: [] }));
    const unique = mergePapersWithIdMap([], papers);
    total = unique.papers.length;
    const firstDiscovery = new Map();
    if (asOf) for (const paper of papers) {
      const day = discoveryDay(paper, asOf);
      if (!day) continue;
      const id = unique.idMap.get(paper.id);
      const previous = firstDiscovery.get(id);
      if (!previous || day < previous) firstDiscovery.set(id, day);
    }
    for (const day of firstDiscovery.values()) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return { asOf, total, counts };
}
export function snapshotCoverage(library, now = new Date()) {
  // Library objects come from complete JSON reads and are replaced on refresh.
  let coverage = coverageByLibrary.get(library);
  if (!coverage) {
    coverage = deriveCoverage(library);
    if (library && typeof library === 'object') coverageByLibrary.set(library, coverage);
  }
  const { asOf, total, counts } = coverage;
  const snapshotDay = asOf && asOf <= now ? beijingDay(asOf) : null;
  const days = [beijingDay(now), dayBefore(1, now)].map(date => ({
    date, count: total !== null && snapshotDay && date <= snapshotDay ? counts.get(date) ?? 0 : null,
  }));
  return { asOf: asOf ? library.fetchedAt : null, total, days };
}

export function snapshotDirections(stats) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return (Array.isArray(stats) ? stats : []).flatMap(row => {
    if (typeof row?.topic !== 'string' || !row.topic.trim()) return [];
    const hits = count(row.hitCount), received = count(row.count);
    const error = typeof row.error === 'string' ? row.error.trim() : '';
    const status = error ? (received > 0 ? 'partial' : 'failed')
      : row.truncated === true ? 'capped'
        : row.truncated === false && hits !== null && received !== null ? 'complete' : 'unknown';
    return [{ topic: row.topic, hits, received, error, status }];
  });
}

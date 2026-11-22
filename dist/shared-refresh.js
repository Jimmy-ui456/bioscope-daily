import { isValidPaper } from './core.js?v=0.2.36';
import { sharedLibraryPapers } from './backup.js?v=0.2.36';
import { snapshotTime } from './snapshot-coverage.js?v=0.2.36';

function readableSharedLibrary(data) {
  return Array.isArray(data?.papers) && data.papers.length <= 500 && data.papers.every(isValidPaper);
}

export function planSharedRefresh(previous, incoming, current, samplePinned) {
  if (!readableSharedLibrary(incoming)) return { library: previous, status: 'unavailable', patch: null };
  const previousAt = snapshotTime(previous?.fetchedAt)?.getTime() ?? null;
  const incomingAt = snapshotTime(incoming.fetchedAt)?.getTime() ?? null;
  if (previousAt !== null && incomingAt !== null && incomingAt < previousAt) {
    return { library: previous, status: 'stale', patch: null };
  }
  const changed = !previous || (incomingAt !== null && incomingAt !== previousAt)
    || Boolean(incoming.automation?.completedAt && incoming.automation.completedAt !== previous.automation?.completedAt);
  const patch = changed && !samplePinned ? {
    papers: sharedLibraryPapers(current, incoming.papers),
    origin: current.containsImported === true ? 'sample' : 'live',
    updatedAt: incoming.fetchedAt,
    stats: Array.isArray(incoming.stats) ? incoming.stats : [],
  } : null;
  return { library: incoming, status: changed ? 'updated' : 'same', patch };
}

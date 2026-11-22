import { collectionTopicStats, mergePapers, mergePapersWithIdMap } from './core.js?v=0.2.39';

export function manualCollectionOutcome(topics, results, current, updatedAt) {
  const stats = results.map((result, index) => collectionTopicStats(topics[index], result));
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  if (!fulfilled.length) return { stats, patch: null, received: null, retained: null, incomplete: [] };

  const incoming = fulfilled.flatMap(result => result.value.papers);
  const received = mergePapers([], incoming);
  const base = current.origin === 'live' || current.containsImported ? current.papers : [];
  const merged = mergePapersWithIdMap(base, incoming);
  const papers = merged.papers.slice(0, 500);
  const activeIds = new Set(papers.map(paper => paper.id));
  const retained = new Set(received.map(paper => merged.idMap.get(paper.id)).filter(id => activeIds.has(id))).size;
  return {
    stats,
    patch: { papers, origin: current.containsImported ? 'sample' : 'live', updatedAt, stats },
    received: received.length,
    retained,
    incomplete: stats.filter(stat => stat.error).map(stat => stat.topic),
  };
}

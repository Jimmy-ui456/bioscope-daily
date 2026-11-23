import { cleanDoi, isRetracted, validPublicationDate } from './core.js?v=0.2.43';

export const RECOMMENDATION_VOTE_LIMIT = 200;
const stop = new Set('about against among analysis based between during effects from into novel paper study their these this through using were which with without'.split(' '));
const DAY_MS = 86_400_000;

export function recommendationTerms(title) {
  const words = typeof title === 'string' ? title.slice(0, 300).normalize('NFKC').toLowerCase().match(/\p{L}[\p{L}\p{M}\d]{3,39}/gu) || [] : [];
  return [...new Set(words.filter(word => !stop.has(word)))].slice(0, 24);
}

export function recommendationId(paper) {
  const doi = typeof paper.doi === 'string' && !/[\p{Cc}\p{Cf}]/u.test(paper.doi) ? cleanDoi(paper.doi) : null;
  if (doi && doi.length <= 500) return `doi:${doi}`;
  return typeof paper.id === 'string' && paper.id.trim() && paper.id.length <= 500 && !/\p{Cc}/u.test(paper.id)
    ? `id:${paper.id}` : null;
}

export function restoreRecommendationVotes(value) {
  if (value === undefined) return { votes: [], skipped: 0 };
  if (!Array.isArray(value)) return { votes: [], skipped: 1 };
  const votes = [], seen = new Set();
  for (const vote of value) {
    if (votes.length >= RECOMMENDATION_VOTE_LIMIT) break;
    const { id, title, choice } = vote || {};
    if (typeof id !== 'string' || id.length > 504 || /[\p{Cc}\p{Cf}]/u.test(id)
      || !(id.startsWith('doi:') && cleanDoi(id) === id.slice(4) || id.startsWith('id:') && id.slice(3).trim())
      || typeof title !== 'string' || !title.trim() || title.length > 300 || ![-1, 1].includes(choice) || seen.has(id)) continue;
    votes.push({ id, title, choice });
    seen.add(id);
  }
  return { votes, skipped: value.length - votes.length };
}

export function rankRecommendations(papers, votes) {
  const signals = votes.map(vote => ({ ...vote, terms: new Set(recommendationTerms(vote.title)) }));
  return papers.filter(paper => !isRetracted(paper)).map((paper, index) => {
    const id = recommendationId(paper), terms = recommendationTerms(paper.title);
    const matched = new Set();
    let score = 0;
    for (const vote of signals) {
      if (vote.id === id) continue;
      const common = terms.filter(term => vote.terms.has(term));
      for (const term of common) matched.add(term);
      score += vote.choice * Math.min(common.length, 3);
    }
    const date = validPublicationDate(paper.publishedAt) ? Date.parse(paper.publishedAt) / DAY_MS : -Infinity;
    const bounded = Math.max(-8, Math.min(8, score));
    return { paper, index, score: bounded, date, rankDay: date + 2 * bounded, matched: [...matched].slice(0, 4) };
  }).sort((a, b) => (b.rankDay - a.rankDay) || (b.date - a.date) || a.index - b.index);
}

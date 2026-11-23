import { beijingDay, dayBefore } from '../dist/core.js';
import { CROSSREF_DIRECTIONS, CROSSREF_ROWS, CROSSREF_RECORD_LIMIT, crossrefDoi, crossrefRecord } from '../dist/crossref-supplement.js';

export async function collectCrossrefSupplement({ topics, days, now, primary, fetchImpl = fetch,
  wait = () => new Promise(resolve => setTimeout(resolve, 1050)) }) {
  const through = beijingDay(now);
  const duration = Number.isSafeInteger(days) && days > 0 && days <= 90 ? days : 30;
  const from = dayBefore(duration - 1, now);
  const known = new Set(primary.map(paper => crossrefDoi(paper.doi)).filter(Boolean));
  const directions = [];
  let limited = false, attempted = false;
  for (const [id, phrase] of CROSSREF_DIRECTIONS) {
    if (!topics.some(topic => topic.id === id)) continue;
    if (limited) { directions.push({ id, status: 'skipped' }); continue; }
    if (attempted) await wait();
    attempted = true;
    try {
      const url = new URL('https://api.crossref.org/works');
      url.search = new URLSearchParams({ 'query.bibliographic': phrase, filter: `type:journal-article,from-pub-date:${from},until-pub-date:${through}`,
        rows: String(CROSSREF_ROWS), select: 'DOI,title,issued,published,type' }).toString();
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (response.status === 429) { limited = true; directions.push({ id, status: 'limited' }); continue; }
      if (!response.ok) throw new Error();
      const data = await response.json();
      const hits = data?.message?.['total-results'], items = data?.message?.items;
      if (data?.status !== 'ok' || !Number.isSafeInteger(hits) || !Array.isArray(items) || hits < items.length) throw new Error();
      const first = items.slice(0, CROSSREF_ROWS);
      const eligible = [...new Map(first.map(row => crossrefRecord(row, phrase, from, through)).filter(Boolean).map(row => [row.doi, row])).values()];
      const fresh = eligible.filter(row => !known.has(row.doi));
      const records = fresh.slice(0, CROSSREF_RECORD_LIMIT);
      for (const row of fresh) known.add(row.doi);
      directions.push({ id, status: 'ok', hits, received: first.length, eligible: eligible.length, fresh: fresh.length, records });
    } catch { directions.push({ id, status: 'failed' }); }
  }
  return { version: 1, from, through, directions };
}

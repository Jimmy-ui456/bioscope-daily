import { API_URL, cleanDoi, plainText, validPublicationDate } from './core.js?v=0.2.42';

export const ONLINE_LIMIT = 20;
export const ONLINE_SAVE_LIMIT = 200;
const fields = { terms: '', title: 'TITLE:', author: 'AUTH:', journal: 'JOURNAL:' };
function phrase(value) { return '"' + value.replace(/["\\]/g, '\\$&') + '"'; }
function doiValue(value) { return typeof value === 'string' && value.length <= 400 && !/[\p{Cc}\p{Cf}]/u.test(value) ? cleanDoi(value) : null; }

export function onlineQuery(input) {
  const clauses = [];
  for (const [key, field] of Object.entries(fields)) {
    const value = (input[key] ?? '').trim();
    if (value.length > 160 || /\p{Cc}/u.test(value)) throw new Error('每个检索字段最多 160 字，请检查输入。');
    if (value) clauses.push(field + phrase(value));
  }
  const exact = (input.doi ?? '').trim();
  const doi = doiValue(exact);
  if (exact && !doi) throw new Error('请输入完整 DOI。');
  if (doi) clauses.push('DOI:' + phrase(doi));
  const { from = '', to = '' } = input;
  if ((from && !validPublicationDate(from)) || (to && !validPublicationDate(to)) || (from && to && from > to)) {
    throw new Error('请检查发表日期范围。');
  }
  if (from || to) clauses.push(`FIRST_PDATE:[${from || '*'} TO ${to || '*'}]`);
  if (!clauses.length) throw new Error('请输入至少一个检索条件。');
  return { query: clauses.join(' AND '), doi };
}

function text(value, limit) { return typeof value === 'string' ? plainText(value.slice(0, limit)) : ''; }
export function onlineCitation(value) {
  const { source, sourceId = value?.id } = value || {};
  if (typeof source !== 'string' || !/^[A-Z][A-Z0-9]{1,11}$/.test(source)
    || typeof sourceId !== 'string' || !/^[\w.:-]{1,160}$/.test(sourceId) || /^\.{1,2}$/.test(sourceId)) return null;
  const title = text(value.title, 2000);
  if (!title) return null;
  const doi = doiValue(value.doi);
  const authors = text(value.authors ?? value.authorString, 2000);
  const journal = text(value.journal ?? value.journalTitle, 500);
  const rawDate = value.publishedAt ?? value.firstPublicationDate;
  const publishedAt = validPublicationDate(rawDate) ? rawDate : null;
  const rawYear = value.year ?? value.pubYear;
  const year = ['string', 'number'].includes(typeof rawYear) ? String(rawYear) : '';
  return { id: doi ? `doi:${doi}` : `epmc:${source}:${sourceId}`, source, sourceId, title, authors, journal, publishedAt,
    year: /^\d{4}$/.test(year) ? year : null, doi, url: `https://europepmc.org/article/${source}/${encodeURIComponent(sourceId)}` };
}

export function restoreOnlineCitations(value) {
  if (value === undefined) return { items: [], skipped: 0 };
  if (!Array.isArray(value)) return { items: [], skipped: 1 };
  const items = [], seen = new Set();
  for (const row of value) {
    if (items.length >= ONLINE_SAVE_LIMIT) break;
    const citation = onlineCitation(row);
    if (!citation || seen.has(citation.id)) continue;
    seen.add(citation.id); items.push(citation);
  }
  return { items, skipped: value.length - items.length };
}

export async function fetchOnlineCitations(input, { signal, fetchImpl = fetch } = {}) {
  const { query, doi } = onlineQuery(input);
  const url = new URL(API_URL);
  url.search = new URLSearchParams({ query, format: 'json', resultType: 'lite', pageSize: String(ONLINE_LIMIT) }).toString();
  const response = await fetchImpl(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  if (!response.ok) throw new Error('Europe PMC 暂时无法返回检索结果。');
  const data = await response.json();
  if (data?.errCode || !Array.isArray(data?.resultList?.result)) throw new Error('Europe PMC 返回了无法读取的结果。');
  const hitCount = Number.isSafeInteger(data.hitCount) && data.hitCount >= 0 ? data.hitCount : null;
  const rows = data.resultList.result.slice(0, ONLINE_LIMIT).map(onlineCitation).filter(row => row && (!doi || row.doi === doi));
  return { hitCount, items: [...new Map(rows.map(row => [row.id, row])).values()] };
}

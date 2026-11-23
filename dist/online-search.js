import { API_URL, cleanDoi, plainText, validPublicationDate } from './core.js?v=0.2.45';

export const ONLINE_LIMIT = 20;
export const ONLINE_SAVE_LIMIT = 200;
export const ONLINE_SOURCES = { europepmc: 'Europe PMC', crossref: 'Crossref', datacite: 'DataCite' };
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
  const provider = value?.provider ?? 'europepmc';
  if (provider === 'crossref' || provider === 'datacite') {
    const doi = doiValue(value.doi), title = text(value.title, 2000);
    if (!doi || !title) return null;
    const publishedAt = validPublicationDate(value.publishedAt) ? value.publishedAt : null;
    const year = typeof value.year === 'string' && /^\d{4}$/.test(value.year) ? value.year : null;
    const publicationType = ['journal', 'preprint'].includes(value.publicationType) ? value.publicationType : null;
    const recordEndpoint = provider === 'crossref' ? 'https://api.crossref.org/works/' : 'https://api.datacite.org/dois/';
    return { provider, id: `${provider}:doi:${doi}`, title, doi, publishedAt, year,
      authors: text(value.authors, 2000), journal: text(value.journal, 500),
      ...(publicationType ? { publicationType } : {}), recordUrl: recordEndpoint + encodeURIComponent(doi),
      url: 'https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/') };
  }
  if (provider !== 'europepmc') return null;
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
  const { url, doi, provider, singleton } = onlineRequest(input);
  const response = await fetchImpl(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  if (response.status === 429) throw Object.assign(new Error('来源暂时限制检索频率，请稍后重试。'), { rateLimited: true });
  if (singleton && response.status === 404) return { hitCount: 0, items: [] };
  if (!response.ok) throw new Error('暂时无法返回检索结果。');
  const data = await response.json();
  if (provider === 'crossref') {
    if (data?.status !== 'ok' || !data.message || typeof data.message !== 'object') throw new Error('结果格式无效。');
    return providerResult(singleton ? [data.message] : data.message.items,
      singleton ? null : data.message['total-results'], crossrefRow, doi, singleton);
  }
  if (provider === 'datacite') return providerResult(singleton ? (data?.data && !Array.isArray(data.data) ? [data.data] : null) : data?.data,
    singleton ? null : data?.meta?.total, dataciteRow, doi, singleton);
  if (data?.errCode || !Array.isArray(data?.resultList?.result)) throw new Error('Europe PMC 返回了无法读取的结果。');
  const hitCount = Number.isSafeInteger(data.hitCount) && data.hitCount >= 0 ? data.hitCount : null;
  const rows = data.resultList.result.slice(0, ONLINE_LIMIT).map(onlineCitation).filter(row => row && (!doi || row.doi === doi));
  return { hitCount, items: [...new Map(rows.map(row => [row.id, row])).values()] };
}

export function onlineRequest(input) {
  const provider = input.provider || 'europepmc';
  const active = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'provider'));
  if (provider === 'datacite' && ['terms', 'author', 'journal', 'from', 'to'].some(key => active[key])) throw new Error('DataCite 在线检索支持题名或完整 DOI。');
  const { query, doi } = onlineQuery(active);
  if (provider === 'europepmc') {
    const url = new URL(API_URL);
    url.search = new URLSearchParams({ query, format: 'json', resultType: 'lite', pageSize: String(ONLINE_LIMIT) }).toString();
    return { provider, url, doi, singleton: false };
  }
  if (provider !== 'crossref' && provider !== 'datacite') throw new Error('请选择有效的检索来源。');
  const url = new URL(provider === 'crossref' ? 'https://api.crossref.org/works' : 'https://api.datacite.org/dois');
  if (doi) {
    if (['terms', 'title', 'author', 'journal', 'from', 'to'].some(key => active[key]?.trim())) throw new Error('完整 DOI 查询仅使用 DOI，请清空其他条件。');
    url.pathname += '/' + encodeURIComponent(doi);
  } else if (provider === 'crossref') {
    const bibliography = [active.title, active.terms].map(value => value?.trim()).filter(Boolean).join(' ');
    const filters = ['type:journal-article'];
    if (active.from) filters.push('from-pub-date:' + active.from);
    if (active.to) filters.push('until-pub-date:' + active.to);
    url.searchParams.set('filter', filters.join(','));
    url.searchParams.set('rows', String(ONLINE_LIMIT));
    if (bibliography) url.searchParams.set('query.bibliographic', bibliography);
    if (active.author?.trim()) url.searchParams.set('query.author', active.author.trim());
    if (active.journal?.trim()) url.searchParams.set('query.container-title', active.journal.trim());
  } else {
    url.searchParams.set('query', 'types.resourceTypeGeneral:(JournalArticle OR Preprint) AND titles.title:' + phrase(active.title.trim()));
    url.searchParams.set('page[size]', String(ONLINE_LIMIT));
  }
  return { provider, url, doi, singleton: Boolean(doi) };
}

function providerResult(rows, count, normalize, doi, singleton) {
  if (!Array.isArray(rows)) throw new Error('结果格式无效。');
  const items = rows.slice(0, ONLINE_LIMIT).map(normalize).filter(row => row && (!doi || row.doi === doi));
  const hitCount = singleton ? items.length : Number.isSafeInteger(count) && count >= 0 ? count : null;
  return { hitCount, items: [...new Map(items.map(row => [row.id, row])).values()] };
}
function dateParts(parts) {
  if (!Array.isArray(parts) || !parts.every(Number.isSafeInteger)) return { publishedAt: null, year: null };
  const [year, month, day] = parts;
  const publishedAt = parts.length === 3 ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
  return { publishedAt, year: String(year ?? '') };
}
function crossrefRow(row) {
  if (row?.type !== 'journal-article' && !(row?.type === 'posted-content' && row.subtype === 'preprint')) return null;
  const authors = Array.isArray(row.author) ? row.author.slice(0, 30).map(person =>
    [person?.given, person?.family].filter(value => typeof value === 'string').join(' ')).filter(Boolean).join(', ') : '';
  return onlineCitation({ provider: 'crossref', doi: row.DOI, title: Array.isArray(row.title) ? row.title[0] : null,
    publicationType: row.type === 'journal-article' ? 'journal' : 'preprint',
    journal: Array.isArray(row['container-title']) ? row['container-title'][0] : null, authors,
    ...dateParts((row.published ?? row.issued)?.['date-parts']?.[0]) });
}
function dataciteRow(row) {
  const item = row?.attributes;
  if (row?.type !== 'dois' || !['JournalArticle', 'Preprint'].includes(item?.types?.resourceTypeGeneral)) return null;
  const title = Array.isArray(item.titles) ? item.titles[0]?.title : null;
  const authors = Array.isArray(item.creators) ? item.creators.slice(0, 30).map(person => person?.name).filter(value => typeof value === 'string').join(', ') : '';
  return onlineCitation({ provider: 'datacite', doi: item.doi ?? row.id, title, authors, year: String(Number.isSafeInteger(item.publicationYear) ? item.publicationYear : ''),
    publicationType: item.types.resourceTypeGeneral === 'JournalArticle' ? 'journal' : 'preprint',
    journal: item.container?.title });
}

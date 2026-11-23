import { cleanDoi, plainText, validPublicationDate } from './core.js?v=0.2.47';

export const CROSSREF_DIRECTIONS = [['synthetic', 'synthetic biology'], ['metabolic', 'metabolic engineering'], ['microbial', 'biomanufacturing']];
export const CROSSREF_ROWS = 20;
export const CROSSREF_RECORD_LIMIT = 8;
export const crossrefText = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim() : '';

export function crossrefDoi(value) {
  return typeof value === 'string' && value.length <= 500 && !/[\p{Cc}\p{Cf}]/u.test(value) ? cleanDoi(value) : null;
}
export function crossrefIssued(field) {
  const parts = field?.['date-parts']?.[0];
  if (!Array.isArray(parts) || parts.length !== 3 || !parts.every(Number.isSafeInteger)) return null;
  const date = String(parts[0]) + '-' + String(parts[1]).padStart(2, '0') + '-' + String(parts[2]).padStart(2, '0');
  return validPublicationDate(date) ? date : null;
}
export function crossrefRecord(row, phrase, from, through) {
  if (row?.type !== 'journal-article' || !Array.isArray(row.title)) return null;
  const doi = crossrefDoi(row.DOI), date = crossrefIssued(row.issued), published = crossrefIssued(row.published);
  const title = typeof row.title[0] === 'string' ? plainText(row.title[0].slice(0, 1000)) : '';
  if (!doi || !date || date < from || date > through || (published && published !== date) || !crossrefText(title).includes(phrase)) return null;
  return { doi, date, title };
}
export function crossrefSupplementView(value) {
  const { from, through, directions } = value || {};
  if (value?.version !== 1 || !validPublicationDate(from) || !validPublicationDate(through) || from > through || !Array.isArray(directions)) return null;
  const seenDirections = new Set();
  const seenRecords = new Set();
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const rows = [];
  for (const row of directions) {
    const phrase = CROSSREF_DIRECTIONS.find(([id]) => id === row?.id)?.[1];
    if (!phrase || seenDirections.has(row.id) || !['ok', 'failed', 'limited', 'skipped'].includes(row.status)) return null;
    seenDirections.add(row.id);
    if (row.status !== 'ok') { rows.push({ id: row.id, phrase, status: row.status }); continue; }
    const { hits, received, eligible, fresh, records } = row;
    if (![hits, received, eligible, fresh].every(count) || received > CROSSREF_ROWS || hits < received || eligible > received || fresh > eligible
      || !Array.isArray(records) || records.length !== Math.min(fresh, CROSSREF_RECORD_LIMIT)) return null;
    const clean = [];
    for (const record of records) {
      const { doi, date, title } = record || {};
      if (!doi || crossrefDoi(doi) !== doi || seenRecords.has(doi) || !validPublicationDate(date) || date < from || date > through
        || typeof title !== 'string' || title.length > 1000 || !crossrefText(title).includes(phrase)) return null;
      seenRecords.add(doi); clean.push({ doi, date, title });
    }
    rows.push({ id: row.id, phrase, status: row.status, hits, received, eligible, fresh, records: clean });
  }
  return rows.length ? { from, through, directions: rows } : null;
}

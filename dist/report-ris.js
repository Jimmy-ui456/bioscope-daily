import { cleanDoi, validPublicationDate } from './core.js?v=0.2.27';

const LINE_BREAK = '\r\n';

function fieldText(value, limit) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return flat.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
}

function authorsOf(paper) {
  const text = fieldText(paper.authors, 32000);
  if (!text || text === '作者信息未提供') return [];
  const fromEuropePmc = paper.collection === 'Europe PMC';
  // Europe PMC's authorString lists authors separated by commas.
  return (fromEuropePmc ? text.split(',') : [text]).slice(0, 500).map(value => {
    const author = fieldText(value, 500);
    if (!fromEuropePmc) return author;
    const initials = /^([\p{L}\p{M}'’ -]+) ((?:\p{Lu}\.?){1,4})$/u.exec(author);
    return initials ? `${initials[1]},${initials[2]}` : author;
  }).filter(Boolean);
}

function originalDoi(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\p{Cc}\p{Cf}]/u.test(value)) return '';
  const doi = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  return cleanDoi(doi) ? doi : '';
}

function originalUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || value.length > 4096 || /[\s\p{Cc}\p{Cf}]/u.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : '';
  } catch { return ''; }
}

function paperRis(paper) {
  const preprint = paper.isPreprint === true || paper.source === 'PPR' || paper.type === '预印本';
  const type = preprint ? 'MANSCPT' : ['期刊论文', '综述'].includes(paper.type) ? 'JOUR' : 'GEN';
  const venue = fieldText(paper.journal, 1000);
  const fields = [
    ['TY', type],
    ['TI', fieldText(paper.title, 4000)],
    ...authorsOf(paper).map(author => ['AU', author]),
    ['T2', ['期刊信息未提供', '预印本平台'].includes(venue) ? '' : venue],
    ['PY', validPublicationDate(paper.publishedAt) ? paper.publishedAt.replaceAll('-', '/') + '/' : ''],
    ['DO', originalDoi(paper.doi)],
    ['UR', originalUrl(paper.url)],
    ['DP', fieldText(paper.collection || paper.source, 200)],
    ['N1', preprint ? 'Preprint' : ''],
    ['N1', typeof paper.pmid === 'string' && /^\d{1,20}$/.test(paper.pmid) ? `PMID: ${paper.pmid}` : ''],
  ];
  return [...fields.filter(([, value]) => value).map(([tag, value]) => `${tag}  - ${value}`), 'ER  - ', ''].join(LINE_BREAK);
}

export function reportRis(report) {
  // Report entries are frozen snapshots. Keep original order and versioned links.
  return (report?.papers ?? []).map(paperRis).join(LINE_BREAK);
}

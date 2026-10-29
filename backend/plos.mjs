import { cleanDoi } from '../dist/core.js';
import { validateDownloadMetric } from '../dist/enrichment.js';

const JOURNALS = {
  pone: 'plosone', pbio: 'plosbiology', pmed: 'plosmedicine',
  pgen: 'plosgenetics', ppat: 'plospathogens', pcbi: 'ploscompbiol',
  pntd: 'plosntds',
};

// This is the public endpoint used by PLOS's own metrics_viewed_section.js.
// "total" mixes formats; only explicit monthly "get-pdf" counts qualify.
export async function fetchPlosMetric(paper, fetchImpl = fetch) {
  const doi = cleanDoi(paper?.doi);
  const article = /^10\.1371\/journal\.([a-z0-9]+)\.([a-z0-9.]+)$/i.exec(doi || '');
  if (!article) return null;
  const dataUrl = `https://counter.plos.org/api/v1.0/stats/doi/${doi}/format/json`;
  const response = await fetchImpl(dataUrl, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`PLOS 下载统计 HTTP ${response.status}`);
  const data = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('PLOS 下载统计格式无效');

  const months = [];
  const missingPdfMonths = [];
  const seenPeriods = new Set();
  let count = 0;
  let reportedMonths = 0;
  for (const [key, rows] of Object.entries(data)) {
    if (key === 'total') continue;
    const match = /^\(\s*(\d{4})\s*,\s*(\d{1,2})\s*\)$/.exec(key);
    if (!match) {
      // Metadata can be added without affecting counts; malformed month keys cannot.
      if (key.startsWith('(')) throw new Error('PLOS 下载统计月份无效');
      continue;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year < 1900 || month < 1 || month > 12 || !Array.isArray(rows)) throw new Error('PLOS 下载统计月份无效');
    const period = `${match[1]}-${String(month).padStart(2, '0')}`;
    if (seenPeriods.has(period)) throw new Error('PLOS 下载统计月份重复');
    seenPeriods.add(period);
    reportedMonths++;
    let pdf;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2 || typeof row[0] !== 'string') throw new Error('PLOS 下载统计记录无效');
      if (row[0] !== 'get-pdf') continue;
      if (pdf !== undefined || !Number.isSafeInteger(row[1]) || row[1] < 0) throw new Error('PLOS PDF 下载次数无效');
      pdf = row[1];
    }
    if (pdf === undefined) { missingPdfMonths.push(period); continue; }
    count += pdf;
    if (!Number.isSafeInteger(count)) throw new Error('PLOS PDF 下载次数超出范围');
    months.push(period);
  }
  if (!months.length) return null;
  months.sort();
  missingPdfMonths.sort();
  const reportedPeriods = [...seenPeriods].sort();
  const monthIndex = period => Number(period.slice(0, 4)) * 12 + Number(period.slice(5)) - 1;
  const unreportedMonths = [];
  // Only infer holes inside the API's own first/last reported months, never from
  // publication time or the current date. Missing months are not zero downloads.
  for (let index = monthIndex(reportedPeriods[0]) + 1; index < monthIndex(reportedPeriods.at(-1)); index++) {
    const period = `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
    if (!seenPeriods.has(period)) unreportedMonths.push(period);
  }
  const journal = JOURNALS[article[1]];
  const sourceUrl = journal ? `https://journals.plos.org/${journal}/article/metrics?id=${encodeURIComponent(doi)}` : dataUrl;
  const metric = {
    count, kind: 'pdf_downloads', platform: 'PLOS', window: 'cumulative', sourceUrl, dataUrl,
    fetchedAt: new Date().toISOString(), provenance: 'publisher_api',
    coverageStart: months[0], coverageEnd: months.at(-1), coverageMonths: months.length,
    reportedStart: reportedPeriods[0], reportedEnd: reportedPeriods.at(-1),
    reportedMonths, missingPdfMonths, unreportedMonths,
    coverageNote: '仅累加接口明确返回的逐篇 get-pdf 月计数，不含 HTML/XML，不代表独立读者；最近数据可能延迟48小时。'
      + (missingPdfMonths.length ? `另有${missingPdfMonths.length}个报告月份未返回PDF字段，未将缺失推定为0。` : '')
      + (unreportedMonths.length ? `平台首末已报告月份之间另有${unreportedMonths.length}个月份完全未返回，未将缺报推定为0。` : ''),
  };
  return validateDownloadMetric(metric) ? metric : null;
}

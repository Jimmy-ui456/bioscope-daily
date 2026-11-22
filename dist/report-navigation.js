import { validPublicationDate } from './core.js?v=0.2.41';
export function publicReportId(value) {
  return typeof value === 'string' && value.startsWith('public-daily-') && validPublicationDate(value.slice('public-daily-'.length)) ? value : null;
}
export function requestedPublicReport(href) {
  try { return publicReportId(new URL(href).searchParams.get('report')); } catch { return null; }
}
export function reportLocation(id, href) {
  const url = new URL(href);
  if (publicReportId(id)) url.searchParams.set('report', id);
  else url.searchParams.delete('report'); // Personal report IDs stay inside the browser.
  url.hash = 'daily';
  return url.href;
}
export function sharedReportLocation(id, href) {
  if (!publicReportId(id)) return null;
  let url;
  try { url = new URL(href); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  url.username = ''; url.password = '';
  url.search = '';
  url.searchParams.set('report', id);
  url.hash = 'daily';
  return url.href;
}

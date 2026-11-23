import { requestedPublicReport } from './report-navigation.js?v=0.2.42';
import { sharedRecordIdentity } from './report-comparison.js?v=0.2.42';

function paperIdentity(value) {
  if (typeof value !== 'string' || value.length > 2004 || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  if (value.startsWith('doi:')) {
    const raw = value.slice(4);
    if (!/^10\.\d{4,9}\/\S+$/u.test(raw)) return null;
    const { doi } = sharedRecordIdentity({ doi: raw });
    return doi ? { kind: 'doi', value: doi } : null;
  }
  const pmid = /^pmid:(\d{1,20})$/.exec(value);
  if (pmid) return { kind: 'pmid', value: pmid[1] };
  const source = /^epmc:([A-Z][A-Z0-9]{1,11}:[\w.:-]{1,160})$/u.exec(value);
  return source ? { kind: 'source', value: source[1] } : null;
}

export function incomingPaperNavigation(href) {
  const reportId = requestedPublicReport(href);
  if (reportId) return { reportId, paper: null };
  try {
    const values = new URL(href).searchParams.getAll('paper');
    return { reportId: null, paper: values.length ? { identity: values.length === 1 ? paperIdentity(values[0]) : null } : null };
  } catch { return { reportId: null, paper: null }; }
}

export function resolveSharedPaper(request, index) {
  if (!request?.identity) return { status: 'invalid' };
  if (!index) return { status: 'unavailable' };
  const { kind, value } = request.identity;
  const matches = index[kind].get(value) || [];
  if (matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'missing' };
  return { status: 'found', paper: matches[0] };
}
export function pendingSharedPaper(request, index, snapshotStatus) {
  if (!request?.identity) return { status: 'invalid' };
  if (snapshotStatus === 'stale') return { status: 'stale' };
  return resolveSharedPaper(request, snapshotStatus === 'unavailable' ? null : index);
}

const exactFields = ['title', 'abstract', 'authors', 'journal', 'publishedAt', 'source', 'sourceId', 'collection',
  'url', 'version', 'type', 'status', 'isPreprint', 'isRetraction'];

export function sharedPaperLocation(paper, index, href) {
  if (!index || !paper) return null;
  const keys = sharedRecordIdentity(paper);
  const kind = keys.doi ? 'doi' : keys.pmid ? 'pmid' : 'source';
  const value = keys[kind];
  if (!value) return null;
  const original = resolveSharedPaper({ identity: { kind, value } }, index).paper;
  if (!original || !exactFields.every(field => original[field] === paper[field])) return null;
  const originalKeys = sharedRecordIdentity(original);
  if (keys.doi !== originalKeys.doi || keys.pmid !== originalKeys.pmid) return null;
  let url;
  try { url = new URL(href); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  url.username = ''; url.password = '';
  url.search = '';
  url.searchParams.set('paper', `${kind === 'source' ? 'epmc' : kind}:${value}`);
  url.hash = 'overview';
  return url.href;
}

export function consumePaperLocation(href) {
  const url = new URL(href);
  url.searchParams.delete('paper');
  return url.href;
}

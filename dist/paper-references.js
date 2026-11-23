import { cleanDoi } from './core.js?v=0.2.47';

function doiAlias(value) {
  const doi = typeof value === 'string' && !/[\p{Cc}\p{Cf}]/u.test(value) ? cleanDoi(value) : null;
  return doi ? `doi:${doi}` : null;
}

export function indexPaperReferences(papers) {
  const ids = new Set();
  const aliases = new Map();
  for (const paper of papers) {
    ids.add(paper.id);
    const pmid = typeof paper.pmid === 'string' && /^\d{1,20}$/.test(paper.pmid) ? `pmid:${paper.pmid}` : null;
    for (const alias of [doiAlias(paper.doi), pmid]) {
      if (alias) aliases.set(alias, aliases.has(alias) ? null : paper.id);
    }
  }
  return reference => {
    if (ids.has(reference)) return reference;
    if (typeof reference !== 'string') return null;
    const alias = /^doi:10\.\d{4,9}\/\S+$/i.test(reference) ? doiAlias(reference.slice(4))
      : /^pmid:\d{1,20}$/.test(reference) ? reference : null;
    return aliases.get(alias) ?? null;
  };
}

export function togglePaperReference(references, id, resolve) {
  const activeId = resolve(id);
  if (activeId === null) return references;
  const unmatched = references.filter(reference => resolve(reference) !== activeId);
  return unmatched.length === references.length ? [...references, activeId] : unmatched;
}

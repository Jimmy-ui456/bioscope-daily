// Check quotes against one original field, never against a joined title/abstract string.
// All positions use JavaScript string offsets (UTF-16); end is exclusive.
export function checkEvidenceClaim(paper, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2500) return null;
  if (typeof value.evidence !== 'string' || [...value.evidence.replace(/\s/g, '')].length < 8) return null;
  for (const source of ['title', 'abstract']) {
    const original = paper?.[source];
    if (typeof original !== 'string') continue;
    const start = original.indexOf(value.evidence);
    if (start !== -1) return { text: value.text.trim(), evidence: value.evidence, source, start, end: start + value.evidence.length };
  }
  return null;
}

export function evidenceContext(paper, claim, radius = 90) {
  const checked = checkEvidenceClaim(paper, claim);
  if (!checked) return null;
  const original = paper[checked.source];
  const distance = Number.isFinite(radius) ? Math.max(0, Math.floor(radius)) : 90;
  const start = Math.max(0, checked.start - distance), end = Math.min(original.length, checked.end + distance);
  return {
    source: checked.source, start, end, claimStart: checked.start, claimEnd: checked.end,
    before: original.slice(start, checked.start), match: checked.evidence, after: original.slice(checked.end, end),
    truncatedBefore: start > 0, truncatedAfter: end < original.length,
  };
}

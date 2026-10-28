import test from 'node:test';
import assert from 'node:assert/strict';
import { knownRetraction, reportMarkdown, normalizePaper } from '../dist/core.js';

const paper = normalizePaper({ id: '123', source: 'MED', doi: '10.1234/abc', title: 'Original title', abstractText: 'Original abstract.', firstPublicationDate: '2026-10-28', pubTypeList: { pubType: ['Journal Article'] } }, 'metabolic');
const report = { date: '2026-10-29', createdAt: '2026-10-29T00:00:00Z', windowStart: '2026-10-23', origin: 'live', papers: [paper] };

test('历史快照保留原状态，同时按 DOI 或 PMID 叠加本库已知撤稿信号', () => {
  const before = JSON.stringify(report);
  const byDoi = { ...paper, id: 'other-source', doi: 'https://doi.org/10.1234/ABC', pmid: null, isRetraction: true };
  assert.equal(knownRetraction(paper, [byDoi]), byDoi);
  const byPmid = { ...byDoi, doi: null, pmid: paper.pmid };
  assert.equal(knownRetraction(paper, [byPmid]), byPmid);
  const markdown = reportMarkdown(report, {}, [byDoi]);
  assert.match(markdown, /已知撤稿相关信号/);
  assert.match(markdown, /原刊快照保持原样/);
  assert.match(markdown, /期刊记录 · 待核验/);
  assert.equal(JSON.stringify(report), before);
});

test('不会把其他论文的撤稿状态关联到本篇，也不推断未发现的状态', () => {
  const unrelated = { ...paper, id: 'unrelated', doi: '10.1234/unrelated', pmid: '456', isRetraction: true };
  assert.equal(knownRetraction(paper, [unrelated]), null);
  assert.equal(knownRetraction(paper, [{ ...paper, isRetraction: false }]), null);
  assert.equal(reportMarkdown(report).includes('已知撤稿相关信号'), false);
  assert.equal(knownRetraction({ ...paper, isRetraction: true }).isRetraction, true);
});

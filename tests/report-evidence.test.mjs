import test from 'node:test';
import assert from 'node:assert/strict';
import { knownRetraction, reportMarkdown, normalizePaper } from '../dist/core.js';
import { sourceFingerprint } from '../dist/enrichment.js';

const paper = normalizePaper({ id: '123', source: 'MED', doi: '10.1234/abc', title: 'Original title', abstractText: 'Original abstract.', firstPublicationDate: '2026-10-28', pubTypeList: { pubType: ['Journal Article'] } }, 'metabolic');
const report = { date: '2026-10-29', createdAt: '2026-10-29T00:00:00Z', windowStart: '2026-10-23', origin: 'live', papers: [paper] };

test('仅题录的首刊保留 PMCID 和原文链接，空白摘要也不生成待翻译提示', () => {
  for (const abstract of ['', ' \n ']) {
    const source = { ...paper, doi: null, pmid: null, pmcid: null, source: 'PMC', sourceId: 'PMC13751451',
      collection: 'Europe PMC', abstract, url: 'https://europepmc.org/article/PMC/PMC13751451' };
    const issue = { ...report, papers: [source] };
    const output = reportMarkdown(issue);
    assert.match(output, /- PMCID：PMC13751451/);
    assert.match(output, /阅读范围：仅题录\n/);
    assert.match(output, /接口未提供摘要/);
    assert.doesNotMatch(output, /待翻译|中文摘要|\*\*原文摘要\*\*/);
    const translated = { titleZh: '辅助中文题名', abstractZh: '不应显示的补写内容',
      sourceFingerprint: sourceFingerprint(source), sourceTitle: source.title, sourceAbstract: source.abstract };
    const titleOnly = reportMarkdown(issue, { [source.id]: translated });
    assert.match(titleOnly, /辅助中文题名.*\n\n\*\*English title\*\*: Original title/);
    assert.doesNotMatch(titleOnly, /待翻译|中文摘要|补写内容/);
    assert.doesNotMatch(reportMarkdown({ ...issue, papers: [{ ...source, collection: 'unverified', pmcid: 'PMC13751451/v1' }] }), /- PMCID/);
  }
});

test('已验证的双语摘要继续导出，空译文只留下原文和现有待翻译提示', () => {
  const translated = { titleZh: '有效中文题名', abstractZh: '有效中文摘要。',
    sourceFingerprint: sourceFingerprint(paper), sourceTitle: paper.title, sourceAbstract: paper.abstract };
  const valid = reportMarkdown(report, { [paper.id]: translated });
  assert.match(valid, /中文摘要（辅助译文，未审核）.*\n\n有效中文摘要。/);
  assert.match(valid, /\*\*原文摘要\*\*\n\nOriginal abstract/);
  const blank = reportMarkdown(report, { [paper.id]: { ...translated, abstractZh: '   ' } });
  assert.match(blank, /中文摘要：待翻译/);
  assert.doesNotMatch(blank, /辅助译文，未审核/);
});

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

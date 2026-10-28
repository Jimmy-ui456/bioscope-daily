import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaper, reportMarkdown } from '../dist/core.js';
import { sourceFingerprint } from '../dist/enrichment.js';

const paper = normalizePaper({ id: '123', source: 'MED', doi: '10.1234/evidence', title: 'Metabolic engineering of yeast', abstractText: 'We engineered yeast to produce 10 g/L in shake flasks. This study included only three biological replicates.', firstPublicationDate: '2026-10-28' }, 'metabolic');
const base = { titleZh: '酵母代谢工程', abstractZh: '研究者改造酵母，在摇瓶中生产10 g/L产物。本研究仅包含三个生物学重复。', sourceFingerprint: sourceFingerprint(paper), origin: 'model', model: 'test-fixture-only', createdAt: '2026-10-29T00:00:00Z', question: null, methods: null, findings: { text: '摇瓶中产物滴度为10 g/L。', evidence: 'We engineered yeast to produce 10 g/L in shake flasks.' }, limitations: [{ text: '研究仅包含三个生物学重复。', evidence: 'This study included only three biological replicates.' }] };
const report = enrichment => ({ date: '2026-10-29', createdAt: '2026-10-29T00:00:00Z', windowStart: '2026-10-23', origin: 'live', papers: [{ ...paper, enrichment }] });

test('Markdown完整保留有效局限、来源段落和逐字引文，并说明匹配的边界', () => {
  const markdown = reportMarkdown(report(base));
  assert.match(markdown, /摘要明确报告的局限 1/);
  assert.match(markdown, /研究仅包含三个生物学重复/);
  assert.match(markdown, /原文依据（原文摘要）：\n> This study included only three biological replicates/);
  assert.match(markdown, /不等于中文结论已经核实/);
  assert.match(markdown, /test-fixture-only/);
});

test('备份带入不存在的证据或错误limitations形状时不导出伪论述，也不崩溃', () => {
  const invalid = { ...base, findings: { text: 'UNSUPPORTED-CLAIM-NEVER-PRINT', evidence: 'UNRELATED-QUOTE' }, limitations: 'not-an-array' };
  const markdown = reportMarkdown(report(invalid));
  assert.equal(markdown.includes('UNSUPPORTED-CLAIM-NEVER-PRINT'), false);
  assert.equal(markdown.includes('UNRELATED-QUOTE'), false);
  assert.match(markdown, /部分解读未通过当前原文证据校验/);
  assert.match(markdown, /酵母代谢工程/);
});

test('原文更新后不继续导出旧译文或旧解读', () => {
  const snapshot = report(base);
  snapshot.papers[0].abstract += ' The source was updated.';
  const markdown = reportMarkdown(snapshot);
  assert.equal(markdown.includes('摇瓶中产物滴度为10 g/L'), false);
  assert.equal(markdown.includes('test-fixture-only'), false);
  assert.match(markdown, /待翻译/);
});

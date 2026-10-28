import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidenceClaim, evidenceContext } from '../dist/evidence.js';
import { sourceFingerprint, translationOf, interpretationOf } from '../dist/enrichment.js';
import { validateInterpretation } from '../backend/interpret.mjs';

const paper = {
  id: 'evidence-paper', title: 'Metabolic engineering of yeast.',
  abstract: 'We engineered yeast to produce 10 g/L in shake flasks. Small sample size limits interpretation.',
};
const claim = { text: '摇瓶培养得到10 g/L产物。', evidence: 'produce 10 g/L in shake flasks.' };
const limitation = { text: '小样本限制结果解读。', evidence: 'Small sample size limits interpretation.' };
const translated = {
  titleZh: '酵母代谢工程', abstractZh: '工程酵母在摇瓶中生产产物，浓度为10 g/L。小样本限制结果解读。',
  origin: 'model', sourceFingerprint: sourceFingerprint(paper), sourceTitle: paper.title, sourceAbstract: paper.abstract,
};
const enriched = extra => ({ ...paper, enrichment: { ...translated, ...extra } });

test('逐字证据返回所在原文字段和重算的半开位置，不相信导入的伪造定位', () => {
  const checked = checkEvidenceClaim(paper, { ...claim, source: 'title', start: 999, end: 1000 });
  const start = paper.abstract.indexOf(claim.evidence);
  assert.deepEqual(checked, { ...claim, source: 'abstract', start, end: start + claim.evidence.length });
  const titleClaim = checkEvidenceClaim(paper, { text: '研究酵母代谢工程。', evidence: paper.title });
  assert.equal(titleClaim.source, 'title');
  assert.equal(titleClaim.start, 0);
  assert.equal(titleClaim.end, paper.title.length);
  assert.equal(checkEvidenceClaim(paper, { ...claim, text: '  有效解读  ' }).text, '有效解读');
});

test('不能把题名末尾和摘要开头拼接成一条原文证据', () => {
  const crossing = 'yeast.\nWe engineered yeast';
  assert.equal(`${paper.title}\n${paper.abstract}`.includes(crossing), true);
  assert.equal(checkEvidenceClaim(paper, { ...claim, evidence: crossing }), null);
});

test('原文证据至少包含8个非空白字符，拒绝编造引文和错误字段形状', () => {
  const spacedPaper = { title: 'A       B', abstract: '12345678' };
  assert.equal(checkEvidenceClaim(spacedPaper, { text: '太短', evidence: spacedPaper.title }), null);
  assert.equal(checkEvidenceClaim(spacedPaper, { text: '正好八个', evidence: spacedPaper.abstract }).source, 'abstract');
  for (const value of [null, [], 'claim', {}, { ...claim, text: '' }, { ...claim, text: ' '.repeat(9) }, { ...claim, text: 'x'.repeat(2501) }, { ...claim, evidence: 'Human patients were cured.' }, { ...claim, evidence: 12345678 }]) {
    assert.equal(checkEvidenceClaim(paper, value), null);
  }
});

test('证据上下文保留连续原文并标明省略，不信任旧坐标或失效的原文', () => {
  const original = { title: 'Another title', abstract: 'prefix '.repeat(30) + claim.evidence + ' suffix'.repeat(30) };
  const checked = checkEvidenceClaim(original, claim);
  const context = evidenceContext(original, { ...checked, start: 0, end: 1 }, 12);
  assert.equal(context.source, 'abstract');
  assert.equal(context.claimStart, checked.start);
  assert.equal(context.claimEnd, checked.end);
  assert.equal(context.before + context.match + context.after, original.abstract.slice(context.start, context.end));
  assert.equal(context.before.length, 12);
  assert.equal(context.after.length, 12);
  assert.equal(context.truncatedBefore, true);
  assert.equal(context.truncatedAfter, true);
  const titleContext = evidenceContext(paper, { text: '题名证据', evidence: paper.title });
  assert.equal(titleContext.before, ''); assert.equal(titleContext.after, '');
  assert.equal(titleContext.truncatedBefore, false); assert.equal(titleContext.truncatedAfter, false);
  assert.equal(evidenceContext({ ...original, abstract: 'Changed abstract.' }, claim), null);
});

test('后台复用相同证据校验，拒绝无效论述及畸形局限，不请求模型', () => {
  const data = { ...translated, question: null, methods: null, findings: claim, limitations: [limitation] };
  const checked = validateInterpretation(data, paper);
  assert.equal(checked.findings.source, 'abstract');
  assert.equal(checked.limitations[0].evidence, limitation.evidence);
  assert.throws(() => validateInterpretation({ ...data, findings: { ...claim, evidence: 'Invented human efficacy result.' } }, paper), /证据/);
  assert.throws(() => validateInterpretation({ ...data, limitations: 'not-an-array' }, paper), /证据/);
  assert.throws(() => validateInterpretation({ ...data, limitations: [null] }, paper), /证据/);
  assert.throws(() => validateInterpretation({ ...data, methods: { ...claim, evidence: 'yeast.\nWe engineered yeast' } }, paper), /证据/);
});

test('备份中的伪造模型论述会被隐藏，但保留当前版本的有效中文译文', () => {
  const imported = enriched({ findings: { text: '已证明人体疗效。', evidence: 'All human patients were cured.' }, methods: claim, limitations: 'not-an-array', model: { toString: 5 }, createdAt: { toString: 5 } });
  const checked = interpretationOf(imported);
  assert.equal(checked.findings, null);
  assert.equal(checked.methods.evidence, claim.evidence);
  assert.deepEqual(checked.limitations, []);
  assert.deepEqual(checked.rejectedFields, ['findings', 'limitations']);
  assert.equal(checked.titleZh, translated.titleZh);
  assert.equal(checked.model, null); assert.equal(checked.createdAt, null);
  assert.equal(translationOf(imported).abstractZh, translated.abstractZh);
});

test('局限数组逐项过滤并报告原下标，只使用前8项，不因null等错误项崩溃', () => {
  const checked = interpretationOf(enriched({ limitations: [null, limitation, { ...limitation, evidence: 'Not in original text.' }] }));
  assert.equal(checked.limitations.length, 1);
  assert.equal(checked.limitations[0].evidence, limitation.evidence);
  assert.deepEqual(checked.rejectedFields, ['limitations[0]', 'limitations[2]']);
  const capped = interpretationOf(enriched({ limitations: Array(9).fill(limitation) }));
  assert.equal(capped.limitations.length, 8);
  assert.deepEqual(capped.rejectedFields, ['limitations[8+]']);
  for (const limitations of [undefined, null, []]) {
    const empty = interpretationOf(enriched({ limitations }));
    assert.deepEqual(empty.limitations, []); assert.deepEqual(empty.rejectedFields, []);
  }
});

test('只有绑定当前原文且有摘要的模型解读能进入证据展示，普通译文不冒充模型解读', () => {
  const current = enriched({ findings: claim });
  assert.ok(interpretationOf(current));
  assert.equal(interpretationOf({ ...current, abstract: paper.abstract + ' Changed.' }), null);
  const noAbstract = { ...paper, abstract: ' ' };
  noAbstract.enrichment = { ...translated, sourceAbstract: ' ', sourceFingerprint: sourceFingerprint(noAbstract) };
  assert.equal(interpretationOf(noAbstract), null);
  const manual = enriched({ origin: 'assistant_translation' });
  assert.equal(interpretationOf(manual), null);
  assert.equal(translationOf(manual).titleZh, translated.titleZh);
});

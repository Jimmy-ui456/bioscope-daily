import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidenceClaim } from '../dist/evidence.js';
import { sourceFingerprint } from '../dist/enrichment.js';
import { PROMPT_VERSION, LEGACY_PROMPT_VERSIONS, SYSTEM_PROMPT, evidenceSources, validateInterpretation,
  interpretPaper, modelFailureDetails } from '../backend/interpret.mjs';

const paper = {
  title: 'Yeast growth under laboratory conditions',
  abstract: 'We studied yeast growth in shake flasks. Growth increased by 2.5-fold at 30 °C. Further validation is needed in bioreactors.  \n',
  isPreprint: true, readingScope: 'abstract_only',
};
const translated = { titleZh: '实验室条件下的酵母生长', abstractZh: '研究者在摇瓶中研究了酵母生长。在30 °C时，生长增加至2.5倍。仍需在生物反应器中进一步验证。',
  question: null, methods: null, findings: null, limitations: [] };
function invalidEvidence(data, input = paper) {
  assert.throws(() => validateInterpretation(data, input), error => {
    assert.deepEqual(modelFailureDetails(error), { failureCode: 'invalid_evidence' });
    return true;
  });
}

test('协议v2保留不可变的v1兼容清单，提示词要求已有ID及完整翻译', () => {
  assert.equal(PROMPT_VERSION, 'bioscope-zh-interpret-v2');
  assert.deepEqual(LEGACY_PROMPT_VERSIONS, ['bioscope-zh-interpret-v1']);
  assert.equal(Object.isFrozen(LEGACY_PROMPT_VERSIONS), true);
  assert.match(SYSTEM_PROMPT, /evidenceId/);
  assert.match(SYSTEM_PROMPT, /不能自造、改写、合并ID/);
  assert.match(SYSTEM_PROMPT, /不要返回自由文本 evidence 字段/);
  assert.match(SYSTEM_PROMPT, /覆盖全部原摘要/);
  assert.match(SYSTEM_PROMPT, /把综述当作新实验/);
});

test('句段来源完整覆盖ASCII、Unicode、多段落、缩写和末尾空白，不截断改写任何字符', () => {
  const abstracts = [
    'A complete ASCII sentence. A second complete sentence!',
    'β-alanine increased 2.5-fold at 30 °C. 酵母 🧬 remained viable; μ = 0.23 h⁻¹.\u00a0\n',
    ' \r\nFirst paragraph contains the result.\r\n\r\nSecond paragraph reports limitations.\r\n \t',
    'Dr. Lee tested E. coli at pH 7.0, e.g. strain MG1655. Fig. 2 shows 3.5 g/L at 24 h.\n',
    'No terminating punctuation and trailing spaces   \t\n',
    '', ' \r\n\t',
  ];
  for (const abstract of abstracts) {
    const input = { title: '  A complete title β 🧬\n', abstract };
    const bank = evidenceSources(input);
    assert.ok(bank instanceof Map);
    assert.equal(bank.get('T1'), input.title);
    const segments = [...bank].slice(1);
    assert.deepEqual(segments.map(([id]) => id), segments.map((_item, index) => `A${index + 1}`));
    assert.equal(segments.map(([, text]) => text).join(''), abstract);
    let offset = 0;
    for (const [, text] of segments) {
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
      assert.equal(abstract.slice(offset, offset + text.length), text);
      offset += text.length;
    }
    assert.equal(offset, abstract.length);
  }
});

test('合法ID使用本纸原文还原标准证据、字段和UTF-16位置，不持久化ID及额外字段', () => {
  const bank = evidenceSources(paper);
  const data = { ...translated,
    question: { text: '研究实验室条件下的酵母生长。', evidenceId: 'T1', extra: 'discard' },
    methods: { text: '在摇瓶中研究生长。', evidenceId: 'A1' },
    findings: { text: '在30 °C时，生长增加至2.5倍。', evidenceId: 'A2' },
    limitations: [{ text: '仍需进行生物反应器验证。', evidenceId: 'A3' }],
  };
  const checked = validateInterpretation(data, paper);
  for (const field of ['question', 'methods', 'findings']) {
    const evidence = bank.get(data[field].evidenceId);
    assert.deepEqual(checked[field], checkEvidenceClaim(paper, { text: data[field].text, evidence }));
    assert.equal(paper[checked[field].source].slice(checked[field].start, checked[field].end), evidence);
    assert.deepEqual(Object.keys(checked[field]).sort(), ['text', 'evidence', 'source', 'start', 'end'].sort());
  }
  assert.equal(checked.question.source, 'title');
  assert.equal(checked.methods.source, 'abstract');
  assert.ok(checked.findings.start > checked.methods.end - 1);
  assert.deepEqual(checked.limitations[0], checkEvidenceClaim(paper, { text: data.limitations[0].text, evidence: bank.get('A3') }));
  assert.equal(Object.hasOwn(checked.findings, 'evidenceId'), false);
  assert.equal(Object.hasOwn(checked.question, 'extra'), false);
});

test('未知、近似或非字符串ID一律拒绝，不回退到模型同时附带的有效英文quote', () => {
  for (const evidenceId of ['A0', 'A999', 'a1', ' A1', 'A1 ', 'A01', 'A1,A2', 'T2', '', 1, null, false, {}, ['A1']]) {
    invalidEvidence({ ...translated, findings: { text: '酵母生长结果。', evidenceId, evidence: paper.abstract } });
  }
  invalidEvidence({ ...translated, limitations: [{ text: '局限描述。', evidenceId: 'unknown' }] });
});

test('合法ID附带伪造英文或模型来源表不能覆盖服务器生成的原文bank', () => {
  const bank = evidenceSources(paper);
  const data = { ...translated,
    findings: { text: '在30 °C时，生长增加至2.5倍。', evidenceId: 'A2', evidence: 'Invented human clinical efficacy.', source: 'title', start: 0, end: 99 },
    abstractSources: [{ id: 'A2', text: 'Invented human clinical efficacy.' }],
    evidenceSources: { A2: 'Invented human clinical efficacy.' },
  };
  const output = validateInterpretation(data, paper);
  assert.deepEqual(output.findings, checkEvidenceClaim(paper, { text: data.findings.text, evidence: bank.get('A2') }));
  assert.equal(JSON.stringify(output).includes('Invented'), false);
  assert.equal(Object.hasOwn(output, 'abstractSources'), false);
  assert.equal(Object.hasOwn(output, 'evidenceSources'), false);
});

test('其它论文或模型伪造的ID不能从外部bank注入，每次校验使用当前论文', () => {
  const otherPaper = { title: 'Another study title', abstract: 'An entirely different result. A second unrelated result. A third unrelated result. A fourth unrelated result.' };
  const outside = evidenceSources(otherPaper);
  const fakeBank = evidenceSources(paper);
  fakeBank.set('A99', outside.get('A4'));
  invalidEvidence({ ...translated, findings: { text: '其他研究的结果。', evidenceId: 'A99' },
    evidenceSources: Object.fromEntries(fakeBank), abstractSources: [...fakeBank].map(([id, text]) => ({ id, text })) });
  const validId = validateInterpretation({ ...translated, findings: { text: '当前原文的结果。', evidenceId: 'A1' },
    evidenceSources: Object.fromEntries(outside) }, paper);
  assert.equal(validId.findings.evidence, evidenceSources(paper).get('A1'));
  assert.notEqual(validId.findings.evidence, outside.get('A1'));
});

test('ID不会放宽八个非空白字符门槛，空或短原文仍然拒绝', () => {
  invalidEvidence({ ...translated, findings: { text: '短依据。', evidenceId: 'T1' } }, { title: 'Short', abstract: paper.abstract });
  invalidEvidence({ ...translated, findings: { text: '短依据。', evidenceId: 'A1' } }, { title: paper.title, abstract: 'OK.  ' });
  invalidEvidence({ ...translated, findings: { text: '空依据。', evidenceId: 'A1' } }, { title: paper.title, abstract: ' \n\t' });
});

test('无ID的v1英文quote继续逐字核验，近似标点、trim补齐或拼接均不接受', () => {
  const exact = 'Growth increased by 2.5-fold at 30 °C.';
  const output = validateInterpretation({ ...translated, findings: { text: '生长增加至2.5倍。', evidence: exact } }, paper);
  assert.deepEqual(output.findings, checkEvidenceClaim(paper, { text: '生长增加至2.5倍。', evidence: exact }));
  for (const evidence of [exact.replace('°C', 'degrees C'), exact.replace('2.5', '2.50'), `\t${exact}`, `${paper.title}${paper.abstract}`]) {
    invalidEvidence({ ...translated, findings: { text: '生长结果。', evidence } });
  }
});

test('真实入口的mock请求只发送一次完整分段摘要，响应ID转成标准证据而非保留模型bank', async () => {
  let calls = 0, sent;
  const modelOutput = { ...translated, methods: { text: '在摇瓶中研究酵母生长。', evidenceId: 'A1' },
    findings: { text: '在30 °C时，生长增加至2.5倍。', evidenceId: 'A2', evidence: 'Fake quote cannot override.' },
    limitations: [{ text: '仍需进行生物反应器验证。', evidenceId: 'A3' }] };
  const output = await interpretPaper(paper, { baseUrl: 'https://example.invalid/v1', apiKey: 'offline-test-only', model: 'fixture-model',
    fetchImpl: async (_url, options) => {
      calls++;
      sent = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(modelOutput) } }] }) };
    } });
  assert.equal(calls, 1);
  assert.equal(sent.messages[0].content, SYSTEM_PROMPT);
  const input = JSON.parse(sent.messages[1].content);
  assert.deepEqual(Object.keys(input).sort(), ['title', 'titleEvidenceId', 'abstractSources', 'isPreprint', 'readingScope'].sort());
  assert.equal(Object.hasOwn(input, 'abstract'), false);
  assert.equal(input.title, paper.title);
  assert.equal(input.titleEvidenceId, 'T1');
  assert.equal(input.abstractSources.map(item => item.text).join(''), paper.abstract);
  assert.deepEqual(input.abstractSources, [...evidenceSources(paper)].slice(1).map(([id, text]) => ({ id, text })));
  assert.equal(input.isPreprint, true);
  assert.deepEqual(output.findings, checkEvidenceClaim(paper, { text: modelOutput.findings.text, evidence: evidenceSources(paper).get('A2') }));
  assert.equal(output.sourceTitle, paper.title);
  assert.equal(output.sourceAbstract, paper.abstract);
  assert.equal(output.sourceFingerprint, sourceFingerprint(paper));
  assert.equal(output.promptVersion, PROMPT_VERSION);
  assert.equal(output.origin, 'model'); assert.equal(output.reviewed, false); assert.equal(output.scope, 'abstract_only');
  assert.equal(JSON.stringify(output).includes('evidenceId'), false);
  assert.equal(JSON.stringify(output).includes('Fake quote'), false);
  assert.equal(JSON.stringify(output).includes('offline-test-only'), false);
});

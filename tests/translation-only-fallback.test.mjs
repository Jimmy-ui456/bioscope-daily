import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretPaper, modelFailureDetails } from '../backend/interpret.mjs';
import { translationOf, interpretationOf } from '../dist/enrichment.js';
const paper = { title: 'Yeast growth in shake flasks.', abstract: 'We measured yeast growth in shake flasks.' };
const configuration = { baseUrl: 'https://example.invalid/v1', model: 'fixture', apiKey: 'never-send' };
const data = { titleZh: '摇瓶中的酵母生长', abstractZh: '我们在摇瓶中测量了酵母生长。',
  question: { text: '不受支持的论述', evidenceId: 'unknown' }, methods: null, findings: null, limitations: [] };
const fetchResponse = (value, reason = 'stop') => async () => ({ ok: true, json: async () => ({ usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  choices: [{ finish_reason: reason, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }) });

test('显式翻译优先时保留中文、丢弃全部未验收研究解读，不冒充解读通过', async () => {
  await assert.rejects(interpretPaper(paper, { ...configuration, fetchImpl: fetchResponse(data) }), /证据/);
  const result = await interpretPaper(paper, { ...configuration, allowTranslationOnly: true, fetchImpl: fetchResponse(data) });
  assert.equal(result.titleZh, data.titleZh); assert.equal(result.abstractZh, data.abstractZh);
  assert.equal(result.analysisStatus, 'translation_only'); assert.equal(result.analysisFailureCode, 'invalid_evidence');
  for (const key of ['question', 'methods', 'findings']) assert.equal(result[key], null);
  assert.deepEqual(result.limitations, []); assert.equal(JSON.stringify(result).includes('不受支持的论述'), false);
  assert.ok(translationOf({ ...paper, enrichment: result })); assert.equal(interpretationOf({ ...paper, enrichment: result }), null);
  assert.equal(result.reviewed, false); assert.deepEqual(result.modelUsage, { inputTokens: 100, outputTokens: 200, totalTokens: 300 });
});
test('严格真值才允许降级；中文无效、截断和坏JSON仍然拒绝并保留合法用量', async () => {
  for (const flag of [undefined, false, 'true', 1]) await assert.rejects(interpretPaper(paper, { ...configuration, allowTranslationOnly: flag, fetchImpl: fetchResponse(data) }));
  for (const [value, reason] of [[{ ...data, titleZh: 'not Chinese' }, 'stop'], ['bad-json', 'stop'], [data, 'length']]) {
    let caught;
    try { await interpretPaper(paper, { ...configuration, allowTranslationOnly: true, fetchImpl: fetchResponse(value, reason) }); }
    catch (error) { caught = error; }
    assert.ok(caught); assert.equal(modelFailureDetails(caught).modelUsage.totalTokens, 300);
  }
});
test('有效编号证据仍正常保留，不把所有结果强制降为只译文', async () => {
  const valid = { ...data, question: { text: '测量酵母生长', evidenceId: 'A1' } };
  const result = await interpretPaper(paper, { ...configuration, allowTranslationOnly: true, fetchImpl: fetchResponse(valid) });
  assert.equal(result.question.evidence, paper.abstract); assert.equal(result.analysisStatus, undefined);
});

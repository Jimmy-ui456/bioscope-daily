import test from 'node:test';
import assert from 'node:assert/strict';
import { runTranslationBatch, translationReportHtml } from '../scripts/translate-library.mjs';
const status = { date: '2026-11-14', reportedAt: '2026-11-14T08:00:00Z', deadlineMet: false, scope: { total: 3, bilingual: 2, missing: 1, noAbstract: 1, blockedByReceipt: 0, inputTooLarge: 0 },
  attempts: 1, passed: 1, failed: 0, remainingPaperIds: ['<script>bad</script>'], budget: { knownCostMicroYuan: 777, unknownReservedMicroYuan: 11200, budgetMicroYuan: 5000000, inputTokens: 789, outputTokens: 774 } };
test('批量入口仅精确手动真值，近似值/其他触发不能调用模型', async () => {
  let calls = 0;
  for (const [event, flag] of [['schedule', 'true'], ['push', 'true'], ['workflow_dispatch', true], ['workflow_dispatch', 'TRUE'], ['workflow_dispatch', 'false']]) {
    await assert.rejects(runTranslationBatch({ env: { GITHUB_EVENT_NAME: event, BIOSCOPE_BATCH_AUTHORIZED: flag }, run: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
});
test('只传模型三字段，报告保留逾期/未知预留/非账单边界并转义文献ID', async () => {
  let received; const saved = [];
  await runTranslationBatch({ root: '/fixture', env: { GITHUB_EVENT_NAME: 'workflow_dispatch', BIOSCOPE_BATCH_AUTHORIZED: 'true',
    LLM_BASE_URL: 'endpoint', LLM_MODEL: 'model', LLM_API_KEY: 'private-key', GITHUB_TOKEN: 'do-not-copy' },
    run: async options => { received = options; return status; }, saveReport: async (...args) => saved.push(args) });
  assert.deepEqual(received.env, { LLM_BASE_URL: 'endpoint', LLM_MODEL: 'model', LLM_API_KEY: 'private-key' });
  const html = saved[0][1]; assert.ok(html.includes('0.000777')); assert.ok(html.includes('0.011200'));
  assert.ok(html.includes('未在原定')); assert.ok(html.includes('不是百炼账单'));
  assert.equal(html.includes('<script>bad'), false); assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(html.includes('private-key'), false);
});

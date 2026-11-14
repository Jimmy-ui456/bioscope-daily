import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTranslationTask, translationBudget, approveTranslationRequest, translationReceiptUsage } from '../backend/translation-task.mjs';
const configuration = { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-flash', apiKey: 'never-copy-this' };
const raw = { schemaVersion: 1, taskId: 'test-task', date: '2026-11-14', authorizedAt: '2026-11-13T14:28:22Z', expiresAt: '2026-11-14T10:00:00Z',
  requestedDeadline: '2026-11-14T01:30:00Z', budgetMicroYuan: 5000000, maxRequests: 500, concurrency: 3, validationReceiptKey: null };
const task = validateTranslationTask(raw), now = new Date('2026-11-14T07:20:00Z');
const receipt = { taskId: task.taskId, status: 'failed_or_unknown', at: now.toISOString(), reservedMicroYuan: 11200 };
const approve = receipts => approveTranslationRequest({ task, receipts, configuration, now, inputUpperBound: 32000 });

test('五元预算对未知用量预留上界，第447次请求前拒绝，旧任务不混入', () => {
  const receipts = Object.fromEntries(Array.from({ length: 446 }, (_, i) => [String(i), { ...receipt }]));
  receipts.unrelated = { ...receipt, taskId: 'another-task' };
  const budget = translationBudget(task, receipts, configuration);
  assert.equal(budget.attempts, 446); assert.equal(budget.unknownReservedMicroYuan, 4995200);
  assert.equal(approve(receipts).reason, 'budget_limit'); assert.equal(approve(receipts).approved, false);
  delete receipts['445']; assert.equal(approve(receipts).approved, true);
});
test('真实合法用量替换预留，仅显示官方原价估算，未知仍不当0', () => {
  const usage = { inputTokens: 1000, outputTokens: 2000, totalTokens: 3000 };
  const fields = translationReceiptUsage(configuration, usage);
  assert.equal(fields.costEstimate.estimatedMicroYuan, 1800); assert.equal(fields.costEstimate.actualBill, false);
  const budget = translationBudget(task, { one: { ...receipt, ...fields }, two: receipt }, configuration);
  assert.equal(budget.knownCostMicroYuan, 1800); assert.equal(budget.unknownReservedMicroYuan, 11200);
  assert.equal(budget.committedMicroYuan, 13000); assert.equal(budget.inputTokens, 1000);
  assert.equal(JSON.stringify(fields).includes(configuration.apiKey), false);
});
test('损坏的本任务预算不能归零绕过，但不相关旧回执保持未知', () => {
  for (const patch of [{ reservedMicroYuan: 0 }, { reservedMicroYuan: '11200' }, { status: 'ok' }, { at: 'not-a-date' }, { modelUsage: { inputTokens: '100' } }]) {
    assert.throws(() => approve({ broken: { ...receipt, ...patch } }));
  }
  assert.equal(approve({ old: { status: 'failed_or_unknown' } }).approved, true);
});
test('预算不能提高到五元以上，日期/并发/次数/证明结构都严格校验', () => {
  for (const patch of [{ budgetMicroYuan: 5000001 }, { budgetMicroYuan: '5' }, { concurrency: 4 }, { maxRequests: 501 }, { expiresAt: raw.authorizedAt }, { validationReceiptKey: 'not-a-receipt' }]) {
    assert.throws(() => validateTranslationTask({ ...raw, ...patch }));
  }
});
test('过期、跨日期、超长输入、用量超预留各自拒绝，不发后续请求', () => {
  assert.equal(approveTranslationRequest({ task, receipts: {}, configuration, now: task.expiresAt, inputUpperBound: 1 }).reason, 'outside_execution_window');
  assert.equal(approveTranslationRequest({ task, receipts: {}, configuration, now: '2026-11-13T15:00:00Z', inputUpperBound: 1 }).reason, 'outside_execution_window');
  assert.equal(approveTranslationRequest({ task, receipts: {}, configuration, now, inputUpperBound: 32001 }).reason, 'input_too_large');
  const high = { ...receipt, modelUsage: { inputTokens: 32001, outputTokens: 1, totalTokens: 32002 } };
  assert.equal(approve({ high }).reason, 'unexpected_token_usage');
});

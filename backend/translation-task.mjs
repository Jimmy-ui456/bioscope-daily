import { estimateModelCost, modelRequestReservation, validateModelUsage } from './model-cost.mjs';
import { beijingDay } from '../dist/core.js';

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function timestamp(value) { return typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)); }
export function validateTranslationTask(value) {
  if (!record(value) || value.schemaVersion !== 1 || !/^[a-z0-9-]{1,80}$/.test(value.taskId || '')
    || !/^\d{4}-\d\d-\d\d$/.test(value.date || '') || !timestamp(value.authorizedAt) || !timestamp(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.authorizedAt)
    || !Number.isSafeInteger(value.budgetMicroYuan) || value.budgetMicroYuan <= 0 || value.budgetMicroYuan > 5000000
    || !Number.isSafeInteger(value.maxRequests) || value.maxRequests <= 0 || value.maxRequests > 500
    || !Number.isSafeInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 3
    || !(value.validationReceiptKey === null || /^[a-f0-9]{40,64}$/.test(value.validationReceiptKey || ''))) throw new Error('翻译任务配置无效，未调用模型');
  return { schemaVersion: 1, taskId: value.taskId, date: value.date, authorizedAt: value.authorizedAt,
    expiresAt: value.expiresAt, requestedDeadline: timestamp(value.requestedDeadline) ? value.requestedDeadline : null,
    budgetMicroYuan: value.budgetMicroYuan, maxRequests: value.maxRequests, concurrency: value.concurrency,
    validationReceiptKey: value.validationReceiptKey };
}

export function translationBudget(task, receipts, configuration) {
  if (!record(receipts)) throw new Error('模型回执结构无效，未调用模型');
  const reservation = modelRequestReservation(configuration);
  if (!reservation) throw new Error('翻译预算仅支持已核价的百炼北京模型');
  let attempts = 0, knownUsageRequests = 0, knownCostMicroYuan = 0, unknownReservedMicroYuan = 0, inputTokens = 0, outputTokens = 0, unsafeUsage = false;
  for (const receipt of Object.values(receipts)) {
    if (!record(receipt) || receipt.taskId !== task.taskId) continue;
    if (!['pending', 'completed', 'failed_or_unknown'].includes(receipt.status) || receipt.reservedMicroYuan !== reservation.reservedMicroYuan || !timestamp(receipt.at)) throw new Error('已有翻译预算回执损坏，未调用模型');
    attempts++;
    const usage = Object.hasOwn(receipt, 'modelUsage') ? validateModelUsage(receipt.modelUsage) : null;
    if (Object.hasOwn(receipt, 'modelUsage') && !usage) throw new Error('已有Token用量记录损坏，未调用模型');
    const cost = usage && estimateModelCost({ ...configuration, usage });
    if (cost) {
      knownUsageRequests++; knownCostMicroYuan += cost.estimatedMicroYuan;
      inputTokens += usage.inputTokens; outputTokens += usage.outputTokens;
      if (usage.inputTokens > reservation.inputTokenCeiling || usage.outputTokens > reservation.maxOutputTokens) unsafeUsage = true;
    } else unknownReservedMicroYuan += receipt.reservedMicroYuan;
  }
  const committedMicroYuan = knownCostMicroYuan + unknownReservedMicroYuan;
  if (![attempts, knownCostMicroYuan, unknownReservedMicroYuan, committedMicroYuan, inputTokens, outputTokens].every(Number.isSafeInteger)) throw new Error('预算数值超限，未调用模型');
  return { attempts, knownUsageRequests, inputTokens, outputTokens, knownCostMicroYuan, unknownReservedMicroYuan,
    committedMicroYuan, remainingMicroYuan: Math.max(0, task.budgetMicroYuan - committedMicroYuan), unsafeUsage,
    currency: 'CNY', actualBill: false, basis: 'undiscounted_realtime_list_price' };
}

export function approveTranslationRequest({ task, receipts, configuration, now = new Date(), inputUpperBound }) {
  const budget = translationBudget(task, receipts, configuration), reservation = modelRequestReservation(configuration);
  const time = new Date(now).getTime();
  const reason = !Number.isFinite(time) ? 'invalid_clock'
    : time < Date.parse(task.authorizedAt) || time >= Date.parse(task.expiresAt) || beijingDay(new Date(time)) !== task.date ? 'outside_execution_window'
    : budget.unsafeUsage ? 'unexpected_token_usage'
    : budget.attempts >= task.maxRequests ? 'request_limit'
    : budget.remainingMicroYuan < reservation.reservedMicroYuan ? 'budget_limit'
    : !Number.isSafeInteger(inputUpperBound) || inputUpperBound <= 0 || inputUpperBound > reservation.inputTokenCeiling ? 'input_too_large' : null;
  return { approved: reason === null, reason, budget, reservedMicroYuan: reservation.reservedMicroYuan };
}

export function translationReceiptUsage(configuration, value) {
  const modelUsage = validateModelUsage(value);
  const costEstimate = modelUsage && estimateModelCost({ ...configuration, usage: modelUsage });
  return { ...(modelUsage ? { modelUsage } : {}), ...(costEstimate ? { costEstimate } : {}) };
}

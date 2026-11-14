// Token metadata is untrusted input. Unknown values remain unknown, never zero.
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }

export function validateModelUsage(value) {
  if (!record(value) || !count(value.inputTokens) || !count(value.outputTokens) || !count(value.totalTokens)
    || !Number.isSafeInteger(value.inputTokens + value.outputTokens)
    || value.inputTokens + value.outputTokens !== value.totalTokens) return null;
  if (Object.hasOwn(value, 'cachedInputTokens') && (!count(value.cachedInputTokens) || value.cachedInputTokens > value.inputTokens)) return null;
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens,
    ...(Object.hasOwn(value, 'cachedInputTokens') ? { cachedInputTokens: value.cachedInputTokens } : {}) };
}

export function parseModelUsage(value) {
  if (!record(value)) return null;
  const detailsPresent = Object.hasOwn(value, 'prompt_tokens_details');
  if (detailsPresent && value.prompt_tokens_details !== null && !record(value.prompt_tokens_details)) return null;
  const cachedPresent = record(value.prompt_tokens_details) && Object.hasOwn(value.prompt_tokens_details, 'cached_tokens');
  return validateModelUsage({ inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens, totalTokens: value.total_tokens,
    ...(cachedPresent ? { cachedInputTokens: value.prompt_tokens_details.cached_tokens } : {}) });
}

// Source checked on 2026-11-13. Official K=1,000, not 1,024. Every token in
// a request uses the tier chosen by that request's total input token count.
// https://help.aliyun.com/zh/model-studio/model-pricing
// These rates assume real-time text requests without explicit cache creation.
// Implicit-cache discounts, free quota, coupons and account offers are omitted:
// this is a conservative list-price estimate, never an invoice or a deduction.
export const MODEL_PRICE_SNAPSHOT = Object.freeze({
  priceDate: '2026-11-13', currency: 'CNY', region: 'cn-beijing',
  provider: 'Alibaba Cloud Model Studio', model: 'qwen3.7-flash',
  basis: 'undiscounted_realtime_list_price', actualBill: false,
  sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing',
  tiers: Object.freeze([
    Object.freeze({ maxInputTokens: 32000, inputPerMillionYuan: '0.2', outputPerMillionYuan: '0.8', inputTenthMicroYuan: 2, outputTenthMicroYuan: 8 }),
    Object.freeze({ maxInputTokens: 256000, inputPerMillionYuan: '0.6', outputPerMillionYuan: '2.4', inputTenthMicroYuan: 6, outputTenthMicroYuan: 24 }),
    Object.freeze({ maxInputTokens: 1000000, inputPerMillionYuan: '1.2', outputPerMillionYuan: '4.8', inputTenthMicroYuan: 12, outputTenthMicroYuan: 48 }),
  ]),
});
const beijingBase = /^https:\/\/(?:dashscope\.aliyuncs\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com)\/compatible-mode\/v1\/?$/;
const pricedModels = new Set(['qwen3.7-flash', 'qwen3.7-flash-2026-07-15']);
function pricedProvider(baseUrl, model) { return typeof baseUrl === 'string' && beijingBase.test(baseUrl) && pricedModels.has(model); }
function decimalYuan(tenthMicroYuan) {
  const whole = tenthMicroYuan / 10000000n, fraction = tenthMicroYuan % 10000000n;
  return `${whole}.${String(fraction).padStart(7, '0')}`;
}

export function estimateModelCost({ baseUrl, model, usage } = {}) {
  const checked = validateModelUsage(usage);
  if (!checked || !pricedProvider(baseUrl, model)) return null;
  const tier = MODEL_PRICE_SNAPSHOT.tiers.find(value => checked.inputTokens <= value.maxInputTokens);
  if (!tier) return null;
  const amount = BigInt(checked.inputTokens) * BigInt(tier.inputTenthMicroYuan)
    + BigInt(checked.outputTokens) * BigInt(tier.outputTenthMicroYuan);
  const roundedMicroYuan = (amount + 9n) / 10n;
  if (roundedMicroYuan > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    currency: MODEL_PRICE_SNAPSHOT.currency, estimatedMicroYuan: Number(roundedMicroYuan),
    estimatedYuan: decimalYuan(amount), priceDate: MODEL_PRICE_SNAPSHOT.priceDate,
    basis: MODEL_PRICE_SNAPSHOT.basis, actualBill: false, inputTierMaxTokens: tier.maxInputTokens,
    inputPerMillionYuan: tier.inputPerMillionYuan, outputPerMillionYuan: tier.outputPerMillionYuan,
  };
}

// Reserve before sending a bounded request. Unknown/failed receipts retain this
// amount; a known usage estimate may replace it after the receipt is persisted.
// The caller must independently enforce its request input/output token ceiling.
export function modelRequestReservation({ baseUrl, model } = {}) {
  const estimate = estimateModelCost({ baseUrl, model, usage: { inputTokens: 32000, outputTokens: 6000, totalTokens: 38000 } });
  if (!estimate) return null;
  return { ...estimate, inputTokenCeiling: 32000, maxOutputTokens: 6000, reservedMicroYuan: estimate.estimatedMicroYuan };
}

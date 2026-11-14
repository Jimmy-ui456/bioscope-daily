import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelUsage, validateModelUsage, estimateModelCost, modelRequestReservation, MODEL_PRICE_SNAPSHOT } from '../backend/model-cost.mjs';

const config = { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-flash' };
const raw = { prompt_tokens: 2000, completion_tokens: 3000, total_tokens: 5000 };
const usage = { inputTokens: 2000, outputTokens: 3000, totalTokens: 5000 };

test('provider用量只接受三个明确一致的非负安全整数，不从缺字段或错误类型补0', () => {
  assert.deepEqual(parseModelUsage(raw), usage);
  assert.deepEqual(parseModelUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const bad = [undefined, null, [], {}, usage, { ...raw, prompt_tokens: undefined }, { ...raw, total_tokens: 4999 }];
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) for (const value of [-1, 1.1, '2000', true, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) bad.push({ ...raw, [field]: value });
  bad.push({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER });
  for (const value of bad) assert.equal(parseModelUsage(value), null);
});

test('可选缓存统计不虚构0，已给缓存数必须有效且不超过输入', () => {
  assert.deepEqual(parseModelUsage({ ...raw, prompt_tokens_details: { cached_tokens: 1200 } }), { ...usage, cachedInputTokens: 1200 });
  assert.deepEqual(parseModelUsage({ ...raw, prompt_tokens_details: { cached_tokens: 0 } }), { ...usage, cachedInputTokens: 0 });
  assert.deepEqual(parseModelUsage({ ...raw, prompt_tokens_details: {} }), usage);
  assert.deepEqual(parseModelUsage({ ...raw, prompt_tokens_details: null }), usage);
  for (const value of [-1, 2001, 1.5, '0', null, true, undefined]) assert.equal(parseModelUsage({ ...raw, prompt_tokens_details: { cached_tokens: value } }), null);
  for (const value of [[], true, 'cached']) assert.equal(parseModelUsage({ ...raw, prompt_tokens_details: value }), null);
});

test('canonical用量复制只保留白名单，不让provider任意字段或密钥进入保存结果', () => {
  const source = { ...usage, cachedInputTokens: 0, apiKey: 'never-publish-fixture', message: 'private-response' };
  const checked = validateModelUsage(source);
  assert.deepEqual(checked, { ...usage, cachedInputTokens: 0 });
  assert.notEqual(checked, source);
  assert.equal(JSON.stringify(checked).includes('private'), false);
  assert.deepEqual(parseModelUsage({ ...raw, id: 'private-request-id', secret: 'never-publish-fixture', completion_tokens_details: { reasoning_tokens: 3000 } }), usage);
  for (const value of [null, {}, raw, { ...usage, cachedInputTokens: 2001 }, { ...usage, totalTokens: 4999 }]) assert.equal(validateModelUsage(value), null);
});

test('北京低档费用用整数十分之一微元计算，预算微元向上取整且明确不是账单', () => {
  const cost = estimateModelCost({ ...config, usage });
  assert.equal(cost.estimatedYuan, '0.0028000'); assert.equal(cost.estimatedMicroYuan, 2800);
  assert.equal(cost.currency, 'CNY'); assert.equal(cost.priceDate, '2026-11-13');
  assert.equal(cost.actualBill, false); assert.equal(cost.basis, 'undiscounted_realtime_list_price');
  const fraction = estimateModelCost({ ...config, usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } });
  assert.equal(fraction.estimatedYuan, '0.0000002'); assert.equal(fraction.estimatedMicroYuan, 1);
  assert.equal(estimateModelCost({ ...config, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }).estimatedMicroYuan, 0);
});

test('价格K按1000计算，超过32000或256000时整次请求均切到对应阶梯', () => {
  for (const [inputTokens, tier, exact] of [
    [32000, 32000, '0.0064008'], [32001, 256000, '0.0192030'],
    [32768, 256000, '0.0196632'], [256000, 256000, '0.1536024'],
    [256001, 1000000, '0.3072060'], [1000000, 1000000, '1.2000048'],
  ]) {
    const cost = estimateModelCost({ ...config, usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 } });
    assert.equal(cost.inputTierMaxTokens, tier); assert.equal(cost.estimatedYuan, exact);
  }
  assert.equal(estimateModelCost({ ...config, usage: { inputTokens: 1000001, outputTokens: 1, totalTokens: 1000002 } }), null);
});

test('缓存和免费额度不被猜测成优惠或实际扣款，未知用量始终不能估为0元', () => {
  assert.deepEqual(estimateModelCost({ ...config, usage: { ...usage, cachedInputTokens: 2000 } }), estimateModelCost({ ...config, usage }));
  assert.equal(estimateModelCost({ ...config, usage: null }), null);
  assert.equal(estimateModelCost({ ...config, usage: {} }), null);
});

test('只对已核对的北京官方接口和已知模型估价，不对中转、国际地域或新快照乱定价', () => {
  for (const baseUrl of ['https://example.invalid/v1', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com.evil.invalid/compatible-mode/v1', 'http://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://user:password@dashscope.aliyuncs.com/compatible-mode/v1', `${config.baseUrl}?token=private`, `${config.baseUrl}#hash`]) {
    assert.equal(estimateModelCost({ ...config, baseUrl, usage }), null); assert.equal(modelRequestReservation({ ...config, baseUrl }), null);
  }
  for (const model of ['', 'qwen3.8-flash', 'qwen3.7-flash-unknown', null]) assert.equal(estimateModelCost({ ...config, model, usage }), null);
  assert.equal(estimateModelCost({ ...config, model: 'qwen3.7-flash-2026-07-15', usage }).estimatedMicroYuan, 2800);
  assert.equal(estimateModelCost({ ...config, baseUrl: 'https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/', usage }).estimatedMicroYuan, 2800);
});

test('低档单请求预留严格11200微元（0.0112元），保持32000输入和6000输出上限元数据', () => {
  const reserve = modelRequestReservation(config);
  assert.equal(reserve.reservedMicroYuan, 11200); assert.equal(reserve.estimatedYuan, '0.0112000');
  assert.equal(reserve.inputTokenCeiling, 32000); assert.equal(reserve.maxOutputTokens, 6000);
  assert.equal(reserve.actualBill, false);
  assert.equal(modelRequestReservation(), null);
  assert.ok(Object.isFrozen(MODEL_PRICE_SNAPSHOT)); assert.ok(Object.isFrozen(MODEL_PRICE_SNAPSHOT.tiers));
  assert.ok(MODEL_PRICE_SNAPSHOT.tiers.every(Object.isFrozen));
});

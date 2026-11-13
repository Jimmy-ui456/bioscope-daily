import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflowCollection } from '../scripts/collect-workflow.mjs';
import { modelConfig, configuredModel } from '../backend/pipeline.mjs';

const modelEnv = { LLM_BASE_URL: 'https://example.invalid/v1', LLM_MODEL: 'not-a-real-model', LLM_API_KEY: 'test-only-never-send' };
const library = {
  papers: [{ id: 'kept-paper' }],
  stats: [{ topic: '合成生物学', count: 1 }, { topic: '代谢工程', count: 0 }],
  automation: { modelRequestsThisRun: 0 },
};

test('手动补采即使继承完整模型Secrets也显式传空env，不触发模型配置', async () => {
  const environment = { ...modelEnv, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_TOKEN: 'not-for-pipeline' };
  const before = structuredClone(environment);
  let modelAttempts = 0, passedEnv;
  const result = await runWorkflowCollection({ env: environment, run: async options => {
    passedEnv = options.env;
    if (configuredModel(modelConfig(options.env))) modelAttempts++;
    return library;
  } });
  assert.deepEqual(passedEnv, {});
  assert.equal(modelAttempts, 0);
  assert.equal(result, library);
  assert.deepEqual(environment, before);
});

test('push、未知或近似schedule的事件也不能借进程配置启用模型', async () => {
  for (const eventName of ['', 'push', 'pull_request', 'Schedule', 'schedule ', 'unknown']) {
    let passedEnv;
    await runWorkflowCollection({ env: modelEnv, eventName, run: async options => { passedEnv = options.env; return library; } });
    assert.deepEqual(passedEnv, {}, eventName);
    assert.equal(configuredModel(modelConfig(passedEnv)), false);
  }
});

test('精确schedule且明确开启自动模型才保留三个配置字段，不把其它凭据传入pipeline', async () => {
  let passedEnv;
  await runWorkflowCollection({
    env: { ...modelEnv, GITHUB_EVENT_NAME: 'schedule', BIOSCOPE_MODEL_AUTO: 'true', GITHUB_TOKEN: 'exclude-this', UNRELATED_SECRET: 'exclude-too' },
    run: async options => { passedEnv = options.env; return library; },
  });
  assert.deepEqual(passedEnv, modelEnv);
  assert.equal(configuredModel(modelConfig(passedEnv)), true);
});

test('自动模型默认暂停，近似开启值及单篇标志不能让定时采集收费', async () => {
  for (const flag of [undefined, '', 'false', 'TRUE', 'true ', '1', true, false]) {
    let passed; let summary;
    const output = await runWorkflowCollection({
      env: { ...modelEnv, BIOSCOPE_MODEL_AUTO: flag, BIOSCOPE_TRANSLATE_ONE: 'true' }, eventName: 'schedule',
      run: async options => { passed = options; return library; }, summaryFile: '/fake-summary',
      appendSummary: async (_file, markdown) => { summary = markdown; },
    });
    assert.deepEqual(passed, { env: {} });
    assert.equal(output, library);
    assert.match(summary, /自动模型已暂停，文献定时采集与发布继续/);
    assert.equal(summary.includes(modelEnv.LLM_API_KEY), false);
  }
});

test('自动模型标志不能让普通手动、push或未知事件调用模型', async () => {
  for (const eventName of ['workflow_dispatch', 'push', 'unknown', 'Schedule']) {
    let passed;
    await runWorkflowCollection({ env: { ...modelEnv, BIOSCOPE_MODEL_AUTO: 'true' }, eventName,
      run: async options => { passed = options; return library; } });
    assert.deepEqual(passed, { env: {} });
  }
});

test('只有明确手动选择单篇验收才传模型白名单并将运行硬限设为1', async () => {
  let passed;
  const summaries = [];
  await runWorkflowCollection({ env: { ...modelEnv, GITHUB_EVENT_NAME: 'workflow_dispatch', BIOSCOPE_TRANSLATE_ONE: 'true', GITHUB_TOKEN: 'never-forward' },
    run: async options => { passed = options; return library; }, summaryFile: '/fake-summary',
    appendSummary: async (_file, markdown) => summaries.push(markdown) });
  assert.deepEqual(passed, { env: modelEnv, modelRunLimit: 1 });
  assert.match(summaries[0], /明确启用单篇模型验收并补采.*最多1次/);
  assert.equal(summaries[0].includes(modelEnv.LLM_API_KEY), false);
});

test('单篇验收缺密钥时收费和采集前明确拒绝，不能用其它环境凭据代替', async () => {
  let called = false; const warnings = [];
  await assert.rejects(runWorkflowCollection({ env: { LLM_BASE_URL: modelEnv.LLM_BASE_URL, LLM_MODEL: modelEnv.LLM_MODEL,
    GITHUB_TOKEN: 'not-a-model-key', OPENAI_API_KEY: 'not-authorized', BIOSCOPE_TRANSLATE_ONE: 'true' }, eventName: 'workflow_dispatch',
    run: async () => { called = true; return library; }, warn: message => warnings.push(message) }), /缺少完整配置/);
  assert.equal(called, false); assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('not-authorized')); assert.ok(!warnings[0].includes('not-a-model-key'));
});

test('单篇结果未验证时保留输出并明确warning，不以流程完成冒充模型验收成功', async () => {
  for (const automation of [{ modelRequestsThisRun: 0, modelCompletedThisRun: 0 }, { modelRequestsThisRun: 1, modelCompletedThisRun: 0, modelFailuresThisRun: 1 }]) {
    const output = { ...library, automation }, warnings = [];
    const result = await runWorkflowCollection({ env: { ...modelEnv, BIOSCOPE_TRANSLATE_ONE: 'true' }, eventName: 'workflow_dispatch',
      run: async () => output, warn: message => warnings.push(message) });
    assert.equal(result, output); assert.match(warnings.join(''), /单篇模型尚未验收通过/);
  }
});

test('单篇标志的近似值及其它事件不能启用手动收费，schedule不被标志扩大或改成单篇', async () => {
  for (const flag of ['', 'TRUE', 'true ', '1', true, false]) {
    let passed;
    await runWorkflowCollection({ env: { ...modelEnv, BIOSCOPE_TRANSLATE_ONE: flag }, eventName: 'workflow_dispatch', run: async options => { passed = options; return library; } });
    assert.deepEqual(passed, { env: {} });
  }
  for (const eventName of ['push', 'Schedule', 'unknown']) {
    let passed;
    await runWorkflowCollection({ env: { ...modelEnv, BIOSCOPE_TRANSLATE_ONE: 'true' }, eventName, run: async options => { passed = options; return library; } });
    assert.deepEqual(passed, { env: {} });
  }
  let passed;
  await runWorkflowCollection({ env: { ...modelEnv, BIOSCOPE_MODEL_AUTO: 'true', BIOSCOPE_TRANSLATE_ONE: 'true' }, eventName: 'schedule', run: async options => { passed = options; return library; } });
  assert.deepEqual(passed, { env: modelEnv });
});

test('部分方向失败时写采集摘要和受控warning，保留成功结果供后续发布', async () => {
  const partial = { ...library, stats: [library.stats[0], { topic: '代谢工程', error: 'RAW-ERROR-DO-NOT-LOG' }, { topic: 'MICROBIAL-SECRET-LABEL', error: 'SECRET-ERROR' }] };
  const before = structuredClone(partial), summaries = [], warnings = [];
  const result = await runWorkflowCollection({
    env: { ...modelEnv, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_STEP_SUMMARY: '/summary-provided-by-test' },
    run: async () => partial,
    appendSummary: async (...args) => { summaries.push(args); }, warn: message => warnings.push(message),
  });
  assert.equal(result, partial);
  assert.deepEqual(partial, before);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0][0], '/summary-provided-by-test');
  assert.equal(summaries[0][2], 'utf8');
  const markdown = summaries[0][1];
  assert.match(markdown, /本次采集方向：3 个/);
  assert.match(markdown, /完成方向：1 个（合成生物学）/);
  assert.match(markdown, /失败方向：2 个（代谢工程、未识别方向）/);
  assert.match(markdown, /本次模型请求：0 次/);
  assert.match(markdown, /本次强制禁用模型/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^::warning title=文献采集部分失败::/);
  const output = markdown + warnings.join('');
  for (const hidden of ['RAW-ERROR', 'SECRET-ERROR', 'MICROBIAL-SECRET-LABEL', modelEnv.LLM_API_KEY, modelEnv.LLM_BASE_URL]) assert.equal(output.includes(hidden), false);
});

test('定时任务摘要如实报告实际请求数，而不暴露模型密钥', async () => {
  let summary;
  const completed = { ...library, automation: { modelRequestsThisRun: 3 } };
  await runWorkflowCollection({ env: { ...modelEnv, GITHUB_EVENT_NAME: 'schedule', GITHUB_STEP_SUMMARY: '/fake-summary' }, run: async () => completed, appendSummary: async (_file, markdown) => { summary = markdown; } });
  assert.match(summary, /触发方式：定时采集/);
  assert.match(summary, /本次模型请求：3 次/);
  assert.equal(summary.includes(modelEnv.LLM_API_KEY), false);
});

test('摘要附件写入失败也不会丢掉已完成采集或阻止发布', async () => {
  const warnings = [];
  const result = await runWorkflowCollection({ env: { GITHUB_STEP_SUMMARY: '/fake-summary' }, run: async () => library, appendSummary: async () => { throw new Error('RAW-FILESYSTEM-ERROR'); }, warn: message => warnings.push(message) });
  assert.equal(result, library);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^::warning title=采集摘要未写入::/);
  assert.equal(warnings[0].includes('RAW-FILESYSTEM-ERROR'), false);
});

test('采集自身失败保持失败状态，不写成部分成功或继续发布', async () => {
  const error = new Error('Upstream failed'); let appended = false;
  await assert.rejects(runWorkflowCollection({ env: { GITHUB_STEP_SUMMARY: '/fake-summary' }, run: async () => { throw error; }, appendSummary: async () => { appended = true; } }), value => value === error);
  assert.equal(appended, false);
});

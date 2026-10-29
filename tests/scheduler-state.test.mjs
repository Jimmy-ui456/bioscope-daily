import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startScheduler } from '../backend/scheduler.mjs';
import { assertSchedulerState } from '../backend/scheduler-state.mjs';
import { readRuntimeStatus } from '../server.mjs';
import { collectionHealth } from '../dist/health.js';

const now = new Date('2026-10-30T02:00:00Z');
const slot = '2026-10-30';
const base = path.resolve('.cache/scheduler-state-tests');
async function project(t) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'case-'));
  t.after(async () => {
    if (!root.startsWith(base + path.sep)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'config'));
  await mkdir(path.join(root, '.data'));
  await writeFile(path.join(root, 'config/monitor.json'), JSON.stringify({ scheduleBeijing: '07:17' }));
  return root;
}
function runtimeStatus(root) {
  return readRuntimeStatus({ root, environment: {}, schedulerEnabled: true, jobBusy: false, jobError: null, jobErrorAt: null });
}

test('可解析但结构无效的调度状态不启动任务、不覆盖原文件，API明确告警', async t => {
  const root = await project(t);
  const file = path.join(root, '.data/scheduler.json');
  const values = [null, [], true, 7, 'private-state-value', { attempts: '3' }, { attempts: -1 },
    { completion: true }, { completion: 'success' }, { slot: '2026-02-30' }, { lastSuccess: false },
    { lastAttemptAt: [] }, { nextRetryAt: 'later' }, { error: {} }];
  for (const value of values) {
    const original = JSON.stringify(value);
    await writeFile(file, original);
    let calls = 0;
    const logs = [];
    const scheduler = startScheduler({ root, clock: () => now, run: async () => { calls++; }, log: message => logs.push(message) });
    try { await scheduler.tick(); await scheduler.tick(); }
    finally { scheduler.stop(); }
    assert.equal(calls, 0, original);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal(scheduler.busy, false);
    assert.equal(logs.length, 2);
    assert.ok(logs.every(message => /状态格式无效.*原文件保留/.test(message)));
    const backend = await runtimeStatus(root);
    assert.deepEqual(backend.scheduler, {});
    assert.match(backend.statusWarning, /格式无效/);
    assert.equal(JSON.stringify(backend).includes('private-state-value'), false);
    const health = collectionHealth({ backend, now, library: { fetchedAt: now.toISOString(), automation: { completedAt: now.toISOString() } } });
    assert.equal(health.level, 'warning');
    assert.equal(health.label, '本地状态未能读取');
  }
});

test('旧合法状态的完成记录、重试上限和未结束记录不会被清空绕过', async t => {
  const root = await project(t);
  const file = path.join(root, '.data/scheduler.json');
  const values = [{ lastSuccess: slot },
    { slot, attempts: 3, completion: 'failed', error: '已达重试上限', nextRetryAt: null },
    { slot, attempts: 3, completion: 'running', lastAttemptAt: now.toISOString() },
    { slot, attempts: 1, lastAttemptAt: now.toISOString(), error: '旧版重试状态', nextRetryAt: '2026-10-30T02:15:00.000Z' }];
  for (const value of values) {
    const original = JSON.stringify(value);
    await writeFile(file, original);
    let calls = 0;
    const logs = [];
    const scheduler = startScheduler({ root, clock: () => now, run: async () => { calls++; }, log: message => logs.push(message) });
    try { await scheduler.tick(); await scheduler.tick(); }
    finally { scheduler.stop(); }
    assert.equal(calls, 0);
    assert.deepEqual(logs, []);
    assert.equal(await readFile(file, 'utf8'), original);
    const backend = await runtimeStatus(root);
    assert.deepEqual(backend.scheduler, value);
    assert.equal(backend.statusWarning, null);
  }
});

test('缺少状态文件与旧版合法对象仍可正常完成当天任务', async t => {
  const root = await project(t);
  const file = path.join(root, '.data/scheduler.json');
  assert.deepEqual((await runtimeStatus(root)).scheduler, {});
  assert.equal((await runtimeStatus(root)).statusWarning, null);
  const old = { lastSuccess: '2026-10-29', legacyMetadata: { retained: true } };
  assert.equal(assertSchedulerState(old), old);
  await writeFile(file, JSON.stringify(old));
  let calls = 0;
  const scheduler = startScheduler({ root, clock: () => now, run: async () => { calls++; }, log: () => {} });
  try { await scheduler.tick(); await scheduler.tick(); }
  finally { scheduler.stop(); }
  assert.equal(calls, 1);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.lastSuccess, slot);
  assert.equal(saved.completion, 'complete');
  assert.deepEqual(saved.legacyMetadata, old.legacyMetadata);
  assert.equal((await runtimeStatus(root)).statusWarning, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolveAsset, readRuntimeStatus } from '../server.mjs';

test('静态目录带末尾斜线时仍能找到首页和资源', () => {
  const root = path.resolve('dist');
  assert.equal(resolveAsset(root + path.sep, '/'), path.join(root, 'index.html'));
  assert.equal(resolveAsset(root + path.sep, '/app.js'), path.join(root, 'app.js'));
});
test('不能读取静态目录外的文件', () => {
  assert.equal(resolveAsset(path.resolve('dist'), '/../package.json'), null);
  assert.equal(resolveAsset(path.resolve('dist'), '/../../secrets'), null);
});
test('后台状态JSON损坏时安全降级，不泄露模型配置或使网页崩溃', async t => {
  const base = path.resolve('.cache/status-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'case-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('Unsafe cleanup'); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, '.data')); await writeFile(path.join(root, '.data/scheduler.json'), '{broken');
  const result = await readRuntimeStatus({ root, environment: { LLM_BASE_URL: 'https://model.example/v1', LLM_API_KEY: 'test-secret-never-return', LLM_MODEL: 'test-model' }, schedulerEnabled: true });
  assert.equal(result.available, true); assert.equal(result.modelConfigured, true); assert.match(result.statusWarning, /暂不可读取/);
  assert.equal(JSON.stringify(result).includes('test-secret-never-return'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { acquirePipelineLock } from '../backend/lock.mjs';
const base = path.resolve('.cache/lock-tests');
async function fileFor(t) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'case-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('Unsafe cleanup'); await rm(root, { force: true, recursive: true }); });
  return path.join(root, 'pipeline.lock');
}
test('活进程的任务锁不被第二个任务替换', async t => {
  const file = await fileFor(t); const first = await acquirePipelineLock(file);
  await assert.rejects(acquirePipelineLock(file), { code: 'EPIPELINEBUSY' });
  await first.release(); await assert.rejects(readFile(file), { code: 'ENOENT' });
});
test('只恢复同一主机且已确认进程不存在的遗留锁', async t => {
  const file = await fileFor(t);
  await writeFile(file, JSON.stringify({ hostname: 'this-host', pid: 9999999, nonce: 'old' }));
  const lock = await acquirePipelineLock(file, { host: 'this-host', alive: () => false });
  assert.notEqual(JSON.parse(await readFile(file, 'utf8')).nonce, 'old');
  await lock.release();
});
test('主机不一致或内容损坏时不擅自清除锁', async t => {
  const file = await fileFor(t);
  await writeFile(file, JSON.stringify({ hostname: 'other-host', pid: 9999999 }));
  await assert.rejects(acquirePipelineLock(file, { host: 'this-host', alive: () => false }), { code: 'EPIPELINEBUSY' });
  await writeFile(file, 'broken');
  await assert.rejects(acquirePipelineLock(file), { code: 'EPIPELINEBUSY' });
  assert.equal(await readFile(file, 'utf8'), 'broken');
});
test('释放时不会删除已被替换的新锁', async t => {
  const file = await fileFor(t); const lock = await acquirePipelineLock(file);
  await writeFile(file, JSON.stringify({ ...lock.owner, nonce: 'replacement' }));
  await lock.release(); assert.equal(JSON.parse(await readFile(file, 'utf8')).nonce, 'replacement');
});

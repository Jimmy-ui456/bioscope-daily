import { open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

function busy(message = '已有采集任务运行，请等待该任务结束') { const error = new Error(message); error.code = 'EPIPELINEBUSY'; return error; }
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function ownerOf(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw busy('采集锁状态无法确认，未自动移除；请检查本地运行记录'); }
}
function canRecover(owner, host, alive) {
  return owner && owner.hostname === host && Number.isSafeInteger(owner.pid) && owner.pid > 0 && !alive(owner.pid);
}
export async function acquirePipelineLock(file, { host = hostname(), alive = processAlive } = {}) {
  const owner = { pid: process.pid, hostname: host, nonce: randomUUID(), startedAt: new Date().toISOString() };
  async function create() {
    const handle = await open(file, 'wx');
    try { await handle.writeFile(JSON.stringify(owner)); }
    catch (error) { await handle.close(); await unlink(file).catch(() => {}); throw error; }
    return handle;
  }
  let handle;
  try { handle = await create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!canRecover(await ownerOf(file), host, alive)) throw busy();
    // Serialize recovery, then recheck: another process may have acquired a new live lock.
    const recoveryPath = `${file}.recovery`;
    let recovery;
    try { recovery = await open(recoveryPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw busy('另一个进程正在恢复采集锁；若异常持续，请检查恢复锁文件'); throw error; }
    try {
      const latest = await ownerOf(file);
      if (latest && !canRecover(latest, host, alive)) throw busy();
      if (latest) await unlink(file);
      try { handle = await create(); } catch (error) { if (error.code === 'EEXIST') throw busy(); throw error; }
    } finally { await recovery.close(); await unlink(recoveryPath).catch(() => {}); }
  }
  return { owner, async release() {
    await handle.close();
    const current = await ownerOf(file);
    // Never remove a lock that an operator or a different process replaced.
    if (current?.nonce === owner.nonce && current?.pid === owner.pid && current?.hostname === owner.hostname) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } };
}

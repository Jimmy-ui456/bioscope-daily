import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { beijingDay } from '../dist/core.js';
import { PROJECT, readJson, saveJson, runPipeline } from './pipeline.mjs';
import { assertSchedulerState } from './scheduler-state.mjs';

export function dueSlot(now, clock = '07:17') {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('定时时间应为 HH:MM');
  const local = new Date(new Date(now).getTime() + 8 * 3600 * 1000);
  return local.getUTCHours() * 60 + local.getUTCMinutes() >= Number(match[1]) * 60 + Number(match[2]) ? beijingDay(now) : null;
}
export function startScheduler({ root = PROJECT, run = runPipeline, writeStatus = saveJson, intervalMs = 30000, clock = () => new Date(), log = console.log } = {}) {
  const statusPath = path.join(root, '.data/scheduler.json');
  let busy = false;
  let stopped = false;
  let pendingCompletion = null;
  async function flushCompletion() {
    const { running, terminal } = pendingCompletion;
    let current;
    try { current = assertSchedulerState(await readJson(statusPath, null)); }
    catch { throw new Error('无法核对待保存任务的磁盘调度记录；原记录保留，请检查本地运行记录'); }
    if (!isDeepStrictEqual(current, terminal)) {
      if (!isDeepStrictEqual(current, running)) throw new Error('待保存的任务结果与磁盘调度记录冲突；原记录保留，请检查本地运行记录');
      await writeStatus(statusPath, terminal);
    }
    pendingCompletion = null;
  }
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      if (pendingCompletion) {
        await flushCompletion();
        return;
      }
      const config = await readJson(path.join(root, 'config/monitor.json'), {});
      const slot = dueSlot(clock(), config.scheduleBeijing || '07:17');
      if (!slot) return;
      const status = assertSchedulerState(await readJson(statusPath, {}));
      if (status.lastSuccess === slot || (status.slot === slot && status.attempts >= 3) || (status.nextRetryAt && Date.parse(status.nextRetryAt) > clock().getTime())) return;
      const running = { ...status, slot, attempts: status.slot === slot ? (status.attempts || 0) + 1 : 1, lastAttemptAt: clock().toISOString(), completion: 'running', error: null };
      await writeStatus(statusPath, running);
      const terminal = { ...running };
      try {
        const result = await run({ root });
        if ((result?.automation?.failedTopics || 0) > 0) {
          terminal.completion = 'partial'; terminal.error = '部分方向尚未更新，将有限重试；已采集数据保留';
          terminal.nextRetryAt = new Date(clock().getTime() + 15 * 60000).toISOString();
        } else { terminal.lastSuccess = slot; terminal.completion = 'complete'; terminal.error = null; terminal.nextRetryAt = null; }
      }
      catch { terminal.completion = 'failed'; terminal.error = '后台采集未完成，将按重试计划处理'; terminal.nextRetryAt = new Date(clock().getTime() + 15 * 60000).toISOString(); }
      // Keep the original outcome and retry time until the status write succeeds.
      pendingCompletion = { running, terminal };
      await flushCompletion();
    } catch (error) { log(`定时任务：${error.message}`); }
    finally { busy = false; }
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { tick, get busy() { return busy; }, stop() { stopped = true; clearInterval(timer); } };
}

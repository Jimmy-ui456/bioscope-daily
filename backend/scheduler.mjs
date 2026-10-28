import path from 'node:path';
import { beijingDay } from '../dist/core.js';
import { PROJECT, readJson, saveJson, runPipeline } from './pipeline.mjs';

export function dueSlot(now, clock = '07:17') {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('定时时间应为 HH:MM');
  const local = new Date(new Date(now).getTime() + 8 * 3600 * 1000);
  return local.getUTCHours() * 60 + local.getUTCMinutes() >= Number(match[1]) * 60 + Number(match[2]) ? beijingDay(now) : null;
}
export function startScheduler({ root = PROJECT, run = runPipeline, intervalMs = 30000, clock = () => new Date(), log = console.log } = {}) {
  let busy = false;
  let stopped = false;
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const config = await readJson(path.join(root, 'config/monitor.json'), {});
      const slot = dueSlot(clock(), config.scheduleBeijing || '07:17');
      if (!slot) return;
      const statusPath = path.join(root, '.data/scheduler.json');
      const status = await readJson(statusPath, {});
      if (status.lastSuccess === slot || (status.slot === slot && status.attempts >= 3) || (status.nextRetryAt && Date.parse(status.nextRetryAt) > clock().getTime())) return;
      const next = { ...status, slot, attempts: status.slot === slot ? (status.attempts || 0) + 1 : 1, lastAttemptAt: clock().toISOString() };
      await saveJson(statusPath, next);
      try {
        const result = await run({ root });
        if ((result?.automation?.failedTopics || 0) > 0) {
          next.completion = 'partial'; next.error = '部分方向尚未更新，将有限重试；已采集数据保留';
          next.nextRetryAt = new Date(clock().getTime() + 15 * 60000).toISOString();
        } else { next.lastSuccess = slot; next.completion = 'complete'; next.error = null; next.nextRetryAt = null; }
      }
      catch { next.error = '后台采集未完成，将按重试计划处理'; next.nextRetryAt = new Date(clock().getTime() + 15 * 60000).toISOString(); }
      await saveJson(statusPath, next);
    } catch (error) { log(`定时任务：${error.message}`); }
    finally { busy = false; }
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { tick, stop() { stopped = true; clearInterval(timer); } };
}

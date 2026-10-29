// Do not silently replace unreadable scheduling history: it may record a retry
// limit or an interrupted task that needs an operator to inspect it first.
export function assertSchedulerState(state) {
  const invalid = () => { throw new Error('后台调度状态格式无效；原文件保留，未启动任务，请检查本地运行记录'); };
  if (!state || typeof state !== 'object' || Array.isArray(state)) invalid();
  const has = key => Object.hasOwn(state, key);
  const day = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const time = value => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && day(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
  if (has('attempts') && (!Number.isSafeInteger(state.attempts) || state.attempts < 0)) invalid();
  if (has('completion') && !['running', 'complete', 'partial', 'failed'].includes(state.completion)) invalid();
  for (const key of ['slot', 'lastSuccess']) if (has(key) && !day(state[key])) invalid();
  if (has('lastAttemptAt') && !time(state.lastAttemptAt)) invalid();
  if (has('nextRetryAt') && state.nextRetryAt !== null && !time(state.nextRetryAt)) invalid();
  if (has('error') && state.error !== null && typeof state.error !== 'string') invalid();
  return state;
}

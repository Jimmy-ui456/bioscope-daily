// Derive display-only health from saved metadata and the optional local API.
// A readable published snapshot is not evidence that a cloud task is healthy.
function recordedTime(value) {
  return typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? value : null;
}

function recordedMessage(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonnegativeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function collectionHealth({
  library = null, backend = null, now = new Date(), staleAfterHours = 36, sharedAvailable = true,
} = {}) {
  const automation = library?.automation;
  const local = backend?.available === true;
  const mode = local ? 'local' : 'snapshot';
  const snapshotAt = recordedTime(library?.fetchedAt);
  const completedAt = recordedTime(automation?.completedAt);
  const nowAt = new Date(now).getTime();
  const ageHours = snapshotAt && Number.isFinite(nowAt) ? (nowAt - Date.parse(snapshotAt)) / 3600000 : null;
  const threshold = typeof staleAfterHours === 'number' && Number.isFinite(staleAfterHours) && staleAfterHours > 0 ? staleAfterHours : 36;
  const stats = Array.isArray(library?.stats) ? library.stats : [];
  const failedStats = stats.filter(stat => recordedMessage(stat?.error)).length;
  const failedTopics = Math.max(nonnegativeCount(automation?.failedTopics), failedStats);
  const analysisFailures = nonnegativeCount(automation?.analysisFailures);
  const modelNotice = analysisFailures ? ` 另有 ${analysisFailures} 条历史模型请求失败或结果未知，需单独核查；不等同于本次采集失败。` : '';
  const result = (level, label, message) => ({ level, label, message: message + modelNotice, snapshotAt, completedAt, ageHours, mode });
  // A later successful pipeline supersedes older errors from either local entry point.
  // Missing error timestamps remain visible because their order cannot be verified.
  const currentError = value => {
    const errorAt = recordedTime(value);
    return !errorAt || !completedAt || Date.parse(errorAt) > Date.parse(completedAt);
  };

  if (local && backend.pipelineBusy === true) {
    return result('running', '本地后台任务运行中', '本地服务报告采集任务正在运行，页面仍可能显示上次保存的数据。');
  }
  const jobError = local && recordedMessage(backend.lastJobError);
  if (jobError && currentError(backend.lastJobErrorAt)) return result('error', '最近本地任务失败', `${jobError} 当前保存的数据不代表本次任务成功。`);
  const schedulerError = local && recordedMessage(backend.scheduler?.error);
  if (schedulerError && currentError(backend.scheduler?.lastAttemptAt)) {
    const partial = backend.scheduler?.completion === 'partial';
    return result(partial ? 'warning' : 'error', partial ? '本地采集部分完成' : '本地定时任务异常', schedulerError);
  }
  if (local && backend.scheduler?.completion === 'running' && currentError(backend.scheduler.lastAttemptAt)) {
    return result('warning', '最近定时任务结果未确认', '最近一次定时任务只有开始记录，尚未核实结束结果；请人工检查本地运行记录，不能据旧快照判定本次成功。');
  }
  const statusWarning = local && recordedMessage(backend.statusWarning);
  if (statusWarning) return result('warning', '本地状态未能读取', statusWarning);
  if (failedTopics) {
    const allFailed = stats.length > 0 && failedStats === stats.length;
    return result(allFailed ? 'error' : 'warning', allFailed ? '采集未完成' : '采集部分完成',
      `${failedTopics} 个研究方向未能更新，已有数据保留；快照完成时间不能证明所有方向都已成功采集。`);
  }
  if (sharedAvailable === false) {
    return result('warning', '共享文献库读取失败', '本次未能读取共享文献库，已保存数据继续保留；不能据缓存判断后台本次运行结果。');
  }
  const startedAt = recordedTime(automation?.lastRunAt);
  if (startedAt && (!completedAt || Date.parse(startedAt) > Date.parse(completedAt))) {
    return result('warning', '后台输出尚未确认完成', '文献数据已保存，但尚无本次日报及订阅输出完成记录。任务可能仍在处理或已中断，请核对运行记录。');
  }
  if (!snapshotAt) return result('unknown', '尚无有效采集快照', '未取得有效的文献库更新时间，暂时无法判断快照新旧或采集结果。');
  if (!Number.isFinite(nowAt)) return result('unknown', '无法核对快照时间', '当前时间不可用，暂时无法判断文献库快照是否过期。');
  if (ageHours < -5 / 60) return result('warning', '快照时间异常', '文献库更新时间晚于当前时间，请核对设备时钟或快照记录，暂时无法判断采集新旧。');
  if (ageHours > threshold) {
    return result('warning', '采集快照较旧', `文献库快照已超过 ${threshold} 小时未更新，请查看采集与发布记录；仅凭旧快照无法确定云端任务的实时状态。`);
  }
  if (local && backend.schedulerEnabled === false) {
    return result('warning', '本地定时采集未启用', '本地服务可访问，但定时采集未启用；当前显示已保存快照，可手动更新或检查本地调度配置。');
  }
  if (local) return result('ok', '本地服务可用', '本地状态接口可访问，当前显示最近保存的文献库；本地状态不能证明 GitHub 云端任务的实时运行情况。');
  return result('ok', '采集快照可读', '已读取已发布的文献库快照；此页面不能直接核验 GitHub 云端任务的实时运行状态。');
}

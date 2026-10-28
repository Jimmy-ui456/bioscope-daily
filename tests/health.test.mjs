import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionHealth } from '../dist/health.js';

const now = new Date('2026-10-29T20:05:00Z');
const library = {
  fetchedAt: '2026-10-29T00:00:00Z',
  automation: { completedAt: '2026-10-29T00:01:00Z', failedTopics: 0, analysisFailures: 0 },
  stats: [{ topic: '合成生物学', count: 10 }],
};
const backend = { available: true, pipelineBusy: false, schedulerEnabled: true, scheduler: {} };

test('静态页面只确认已发布快照可读，不宣称云端实时健康', () => {
  const health = collectionHealth({ library, now });
  assert.equal(health.level, 'ok'); assert.equal(health.mode, 'snapshot');
  assert.equal(health.label, '采集快照可读'); assert.match(health.message, /不能直接核验.*实时/);
  assert.equal(health.snapshotAt, library.fetchedAt); assert.equal(health.completedAt, library.automation.completedAt);
});

test('本地运行和任务错误优先于快照较旧、部分成功及缓存回退', () => {
  const old = { ...library, fetchedAt: '2026-10-20T00:00:00Z', automation: { failedTopics: 1 } };
  const running = collectionHealth({ library: old, backend: { ...backend, pipelineBusy: true, lastJobError: '旧错误' }, sharedAvailable: false, now });
  assert.equal(running.level, 'running'); assert.equal(running.mode, 'local');
  const error = collectionHealth({ library: old, backend: { ...backend, lastJobError: '本地请求失败' }, sharedAvailable: false, now });
  assert.equal(error.level, 'error'); assert.match(error.message, /本地请求失败/);
});

test('本地调度失败不被残留的complete状态掩盖，部分完成与状态损坏分别提示', () => {
  const failure = collectionHealth({ library, backend: { ...backend, scheduler: { completion: 'complete', error: '调度失败' } }, now });
  assert.equal(failure.level, 'error'); assert.match(failure.message, /调度失败/);
  const partial = collectionHealth({ library, backend: { ...backend, scheduler: { completion: 'partial', error: '部分方向失败，将有限重试' } }, now });
  assert.equal(partial.level, 'warning'); assert.match(partial.label, /部分完成/);
  const unreadable = collectionHealth({ library, backend: { ...backend, statusWarning: '状态文件不可读取' }, now });
  assert.equal(unreadable.level, 'warning'); assert.match(unreadable.message, /状态文件不可读取/);
});

test('手动任务旧错误在后续定时任务成功后被覆盖，较新或无时间错误仍提示', () => {
  const manualError = { ...backend, lastJobError: '前次手动任务失败', lastJobErrorAt: '2026-10-29T00:00:00Z' };
  const recovered = collectionHealth({ library, backend: manualError, now });
  assert.equal(recovered.level, 'ok'); assert.equal(recovered.label, '本地服务可用');
  const sameTime = collectionHealth({ library, backend: { ...manualError, lastJobErrorAt: library.automation.completedAt }, now });
  assert.equal(sameTime.level, 'ok');
  const newer = collectionHealth({ library, backend: { ...manualError, lastJobErrorAt: '2026-10-29T00:02:00Z' }, now });
  assert.equal(newer.level, 'error'); assert.match(newer.message, /手动任务失败/);
  assert.equal(collectionHealth({ library, backend: { ...manualError, lastJobErrorAt: undefined }, now }).level, 'error');
  assert.equal(collectionHealth({ library, backend: { ...manualError, lastJobErrorAt: 'invalid' }, now }).level, 'error');
});

test('定时任务旧错误在后续手动任务成功后被覆盖，部分采集仍由快照告警', () => {
  const scheduler = { completion: 'failed', error: '前次定时任务失败', lastAttemptAt: '2026-10-29T00:00:00Z' };
  const recovered = collectionHealth({ library, backend: { ...backend, scheduler }, now });
  assert.equal(recovered.level, 'ok');
  assert.equal(collectionHealth({ library, backend: { ...backend, scheduler: { ...scheduler, lastAttemptAt: library.automation.completedAt } }, now }).level, 'ok');
  const newer = collectionHealth({ library, backend: { ...backend, scheduler: { ...scheduler, lastAttemptAt: '2026-10-29T00:02:00Z' } }, now });
  assert.equal(newer.level, 'error'); assert.match(newer.message, /定时任务失败/);
  assert.equal(collectionHealth({ library, backend: { ...backend, scheduler: { ...scheduler, lastAttemptAt: undefined } }, now }).level, 'error');
  const partial = collectionHealth({
    library: { ...library, automation: { ...library.automation, failedTopics: 1 } },
    backend: { ...backend, scheduler: { ...scheduler, completion: 'partial' } }, now,
  });
  assert.equal(partial.level, 'warning'); assert.equal(partial.label, '采集部分完成');
});

test('服务空闲但定时任务只留开始记录时提示结果未知，后续成功可以覆盖', () => {
  const scheduler = { completion: 'running', lastAttemptAt: '2026-10-29T00:02:00Z' };
  const unknown = collectionHealth({ library, backend: { ...backend, scheduler }, now });
  assert.equal(unknown.level, 'warning'); assert.equal(unknown.label, '最近定时任务结果未确认');
  assert.match(unknown.message, /人工检查/); assert.doesNotMatch(unknown.message, /正在运行|自动重试/);
  const recovered = collectionHealth({ library, backend: { ...backend, scheduler: { ...scheduler, lastAttemptAt: '2026-10-29T00:00:00Z' } }, now });
  assert.equal(recovered.level, 'ok');
  const noTime = collectionHealth({ library, backend: { ...backend, scheduler: { completion: 'running' } }, now });
  assert.equal(noTime.label, '最近定时任务结果未确认');
});

test('快照failedTopics与各方向stats.error均能提示部分失败，全部失败不称部分成功', () => {
  const partial = collectionHealth({ library: { ...library, automation: { ...library.automation, failedTopics: 1 } }, now });
  assert.equal(partial.level, 'warning'); assert.equal(partial.label, '采集部分完成');
  const statsFailure = collectionHealth({ library: { ...library, stats: [{ count: 1 }, { error: '上游失败' }] }, now });
  assert.equal(statsFailure.label, '采集部分完成'); assert.match(statsFailure.message, /1 个研究方向/);
  const allFailure = collectionHealth({ library: { ...library, stats: [{ error: '全部失败' }] }, now });
  assert.equal(allFailure.level, 'error'); assert.equal(allFailure.label, '采集未完成');
});

test('共享库本次读取失败时，即使已有新鲜缓存也显示警告', () => {
  const health = collectionHealth({ library, sharedAvailable: false, now });
  assert.equal(health.level, 'warning'); assert.equal(health.label, '共享文献库读取失败');
  assert.match(health.message, /不能据缓存判断/);
});

test('已有文献但日报或订阅输出尚未完成时，不显示整个后台已完成', () => {
  const incomplete = { ...library, automation: { lastRunAt: library.fetchedAt } };
  const health = collectionHealth({ library: incomplete, now });
  assert.equal(health.level, 'warning'); assert.equal(health.label, '后台输出尚未确认完成');
  const mixed = { ...library, automation: { lastRunAt: '2026-10-29T00:02:00Z', completedAt: library.automation.completedAt } };
  assert.equal(collectionHealth({ library: mixed, now }).level, 'warning');
});

test('快照超过36小时才提醒较旧，阈值可配置，非法阈值回退默认值', () => {
  const at = offset => new Date(Date.parse(library.fetchedAt) + offset * 3600000);
  assert.equal(collectionHealth({ library, now: at(36) }).label, '采集快照可读');
  assert.equal(collectionHealth({ library, now: at(36.01) }).label, '采集快照较旧');
  assert.equal(collectionHealth({ library, now: at(13), staleAfterHours: 12 }).label, '采集快照较旧');
  assert.equal(collectionHealth({ library, now: at(13), staleAfterHours: -1 }).label, '采集快照可读');
});

test('缺失、无效或超前时间不会被当成新鲜快照', () => {
  assert.equal(collectionHealth({ now }).level, 'unknown');
  assert.equal(collectionHealth({ library: { fetchedAt: 'invalid' }, now }).level, 'unknown');
  assert.equal(collectionHealth({ library, now: 'invalid' }).level, 'unknown');
  assert.equal(collectionHealth({ library: { fetchedAt: '2026-10-30T00:00:00Z' }, now }).label, '快照时间异常');
});

test('本地空闲只代表接口可用，停用定时采集需提示且不推断云端状态', () => {
  const idle = collectionHealth({ library, backend, now });
  assert.equal(idle.label, '本地服务可用'); assert.match(idle.message, /不能证明 GitHub 云端/);
  const stopped = collectionHealth({ library, backend: { ...backend, schedulerEnabled: false }, now });
  assert.equal(stopped.level, 'warning'); assert.equal(stopped.label, '本地定时采集未启用');
});

test('历史模型失败仅作独立提醒，不把当前采集改判为失败或修改输入', () => {
  const input = { library: structuredClone(library), backend: structuredClone(backend), now };
  input.library.automation.analysisFailures = 3;
  const before = structuredClone(input);
  const health = collectionHealth(input);
  assert.equal(health.level, 'ok'); assert.match(health.message, /3 条历史模型请求失败或结果未知/);
  assert.match(health.message, /不等同于本次采集失败/); assert.deepEqual(input, before);
});

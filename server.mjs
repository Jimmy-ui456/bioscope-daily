import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readJson, runPipeline, modelConfig, configuredModel, PROJECT } from './backend/pipeline.mjs';
import { startScheduler } from './backend/scheduler.mjs';

const root = path.resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
let pipelineBusy = false;
let scheduler = null;
let lastJobError = null;
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(data)); }
export async function readRuntimeStatus({ root: projectRoot = PROJECT, environment = process.env, schedulerEnabled = Boolean(scheduler), jobBusy = pipelineBusy, jobError = lastJobError } = {}) {
  let status = {};
  let statusWarning = null;
  try { status = await readJson(path.join(projectRoot, '.data/scheduler.json'), {}); }
  catch { statusWarning = '后台状态文件暂不可读取，现有文献数据保留；请检查本地运行记录。'; }
  return { available: true, modelConfigured: configuredModel(modelConfig(environment)), schedulerEnabled, pipelineBusy: jobBusy, lastJobError: jobError, scheduler: status, statusWarning };
}
export function resolveAsset(directory, pathname) {
  const base = path.resolve(directory);
  const target = path.resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname));
  return target.startsWith(base + path.sep) ? target : null;
}
const server = createServer(async (req, res) => {
  let requestUrl;
  try { requestUrl = new URL(req.url, 'http://localhost'); } catch { json(res, 400, { error: '无效请求地址' }); return; }
  if (requestUrl.pathname === '/api/status' && req.method === 'GET') {
    json(res, 200, await readRuntimeStatus()); return;
  }
  if (requestUrl.pathname === '/api/collect' && req.method === 'POST') {
    if (!['127.0.0.1', '::1'].includes(req.socket.remoteAddress) || req.headers.origin !== `http://${req.headers.host}` || !req.headers['content-type']?.startsWith('application/json')) { json(res, 403, { error: '只允许同源本地浏览器启动任务' }); return; }
    if (pipelineBusy) { json(res, 409, { error: '采集任务已在运行' }); return; }
    pipelineBusy = true; lastJobError = null;
    void runPipeline().catch(() => { lastJobError = '后台任务未完成；原数据保留，请检查服务端日志和配置。'; }).finally(() => { pipelineBusy = false; });
    json(res, 202, { ok: true }); return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = resolveAsset(root, name);
    if (!target) { res.writeHead(403).end(); return; }
    if (!(await stat(target)).isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : await readFile(target));
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('页面不存在'); }
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(PROJECT, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.env.SCHEDULE_ENABLED !== 'false') scheduler = startScheduler();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 正在使用。如果已有 BioScope 窗口，请打开对应地址；否则先关闭旧服务，或设置 PORT 后重试。` : `本地服务启动失败：${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => { console.log(`BioScope Local: http://127.0.0.1:${port}`); void scheduler?.tick(); });
}

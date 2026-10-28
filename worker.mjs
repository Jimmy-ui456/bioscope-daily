import path from 'node:path';
import { PROJECT, runPipeline } from './backend/pipeline.mjs';
import { startScheduler } from './backend/scheduler.mjs';
try { process.loadEnvFile(path.join(PROJECT, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (process.argv.includes('--once')) await runPipeline();
else {
  const scheduler = startScheduler();
  console.log('BioScope 后台已启动：按 config/monitor.json 中的北京时间运行；程序需要保持运行。');
  await scheduler.tick();
  const keepAlive = setInterval(() => {}, 3600000);
  process.on('SIGINT', () => { scheduler.stop(); clearInterval(keepAlive); process.exit(0); });
}

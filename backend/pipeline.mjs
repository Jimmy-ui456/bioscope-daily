import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TOPICS, collectTopic, mergePapers, beijingDay } from '../dist/core.js';
import { attachEnrichment, translationOf, sourceFingerprint } from '../dist/enrichment.js';
import { interpretPaper, PROMPT_VERSION } from './interpret.mjs';
import { applyPublisherMetrics, fetchPublisherMetric } from './downloads.mjs';
import { acquirePipelineLock } from './lock.mjs';
import { createPublicReport, updatePublicReportHistory } from './reports.mjs';
import { createDailyRss } from './feeds.mjs';

export const PROJECT = fileURLToPath(new URL('../', import.meta.url));
export async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
export async function saveJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + '\n'); await rename(temp, file); }
export function modelConfig(env = process.env) { return { baseUrl: env.LLM_BASE_URL || '', apiKey: env.LLM_API_KEY || '', model: env.LLM_MODEL || '' }; }
export function configuredModel(config) { return Boolean(config.apiKey && config.baseUrl && config.model); }
export function requestKey(paper, config) { return createHash('sha256').update([paper.id, sourceFingerprint(paper), config.baseUrl, config.model, PROMPT_VERSION].join('|')).digest('hex'); }

export async function runPipeline({ root = PROJECT, collect = collectTopic, interpret = interpretPaper, fetchMetric = fetchPublisherMetric, env = process.env, now = new Date(), log = console.log } = {}) {
  await mkdir(path.join(root, '.data'), { recursive: true });
  const lockPath = path.join(root, '.data/pipeline.lock');
  const lock = await acquirePipelineLock(lockPath);
  try {
    const config = await readJson(path.join(root, 'config/monitor.json'), {});
    const sample = await readJson(path.join(root, 'dist/sample.json'), { papers: [] });
    const previous = await readJson(path.join(root, 'dist/library.json'), { papers: [], receipts: {}, modelUsage: { date: beijingDay(now), requests: 0 } });
    const catalog = (await readJson(path.join(root, 'dist/translations.json'), { items: {} })).items;
    const topics = TOPICS.filter(t => (config.topics || TOPICS.map(t => t.id)).includes(t.id));
    if (!topics.length) throw new Error('没有有效监控主题');
    const results = await Promise.allSettled(topics.map(t => collect(t, { days: config.days || 30, maxPages: config.maxPages || 2, pageSize: config.pageSize || 25, at: now })));
    const good = results.filter(r => r.status === 'fulfilled');
    if (!good.length) throw new Error('全部主题采集失败，保留上次文献库');
    const stats = results.map((r, i) => r.status === 'fulfilled' ? { topic: topics[i].name, hitCount: r.value.hitCount, count: r.value.papers.length, truncated: r.value.truncated } : { topic: topics[i].name, error: '上游请求失败，本方向结果未更新' });
    let papers = mergePapers(previous.papers, good.flatMap(r => r.value.papers)).slice(0, config.maxPapers || 500).map(p => attachEnrichment(p, catalog));
    const publisherRecords = (await readJson(path.join(root, 'config/download-metrics.json'), { records: [] })).records;
    papers = applyPublisherMetrics(papers, publisherRecords);
    for (const paper of papers.filter(p => /^(10\.5281\/zenodo\.|10\.1371\/journal\.)/i.test(p.doi || '')).slice(0, 20)) {
      try { const metric = await fetchMetric(paper); if (metric) paper.downloadMetric = metric; } catch { /* Unavailable metrics stay unknown, never zero. */ }
    }
    const configModel = modelConfig(env);
    const today = beijingDay(now);
    const usage = previous.modelUsage?.date === today ? { ...previous.modelUsage } : { date: today, requests: 0 };
    const receipts = { ...(previous.receipts || {}) };
    // Seed copies provide translations only; samples are not inserted as newly collected papers.
    const sampleCatalog = Object.fromEntries(sample.papers.filter(p => p.enrichment).map(p => [p.id, p.enrichment]));
    papers = papers.map(p => attachEnrichment(p, { ...sampleCatalog, ...catalog }));
    const library = { schemaVersion: 2, origin: 'live', fetchedAt: new Date().toISOString(), papers, stats, modelUsage: usage, receipts, automation: { scheduleBeijing: config.scheduleBeijing || '07:17', modelConfigured: configuredModel(configModel), modelStatus: configuredModel(configModel) ? 'ready' : 'not_configured', lastRunAt: new Date().toISOString(), failedTopics: stats.filter(s => s.error).length } };
    const output = path.join(root, 'dist/library.json');
    await saveJson(output, library);
    let attempted = 0;
    if (configuredModel(configModel)) for (const paper of papers) {
      if (!paper.abstract || translationOf(paper)?.origin === 'model' || paper.isRetraction) continue;
      if (attempted >= (config.maxAnalysesPerRun ?? 10) || usage.requests >= (config.maxModelRequestsPerDay ?? 20)) break;
      const key = requestKey(paper, configModel);
      // A pending / unknown request is never retried automatically: it may already have cost money.
      if (receipts[key]) continue;
      attempted++; usage.requests++;
      receipts[key] = { status: 'pending', at: new Date().toISOString() };
      await saveJson(output, library);
      try {
        paper.enrichment = await interpret(paper, configModel);
        receipts[key] = { status: 'completed', at: new Date().toISOString() };
      } catch { receipts[key] = { status: 'failed_or_unknown', at: new Date().toISOString() }; }
      await saveJson(output, library);
    }
    library.automation.completedAt = new Date().toISOString();
    library.automation.modelRequestsThisRun = attempted;
    library.automation.analysisFailures = Object.values(receipts).filter(r => r.status === 'failed_or_unknown' || r.status === 'pending').length;
    await saveJson(output, library);
    const reportFile = path.join(root, 'dist/public-reports.json');
    const reportHistory = await readJson(reportFile, { version: 1, reports: [] });
    const publicReport = createPublicReport(papers, { now, topics, translations: catalog, sourceUpdatedAt: library.fetchedAt });
    const reports = updatePublicReportHistory(reportHistory.reports, publicReport);
    await saveJson(reportFile, { version: 1, reports });
    const publication = await readJson(path.join(root, 'config/publication.json'), {});
    if (publication.siteUrl) await writeFile(path.join(root, 'dist/feed.xml'), createDailyRss(reports, { siteUrl: publication.siteUrl }));
    log(`采集完成：${papers.length} 篇，${papers.filter(p => translationOf(p)).length} 篇中英对照，模型请求 ${attempted} 次；${library.automation.modelStatus === 'not_configured' ? '模型未配置，已跳过自动解读' : '自动解读任务完成'}。`);
    return library;
  } finally { await lock.release(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(PROJECT, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  runPipeline().catch(error => { console.error(error.message); process.exitCode = 1; });
}

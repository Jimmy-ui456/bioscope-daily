import { mkdir, writeFile } from 'node:fs/promises';
import { TOPICS, collectTopic, mergePapers } from '../dist/core.js';

const output = new URL('../dist/sample.json', import.meta.url);
const results = await Promise.all(TOPICS.map(t => collectTopic(t, { days: 30, maxPages: 1, pageSize: 8 })));
const papers = mergePapers([], results.flatMap(r => r.papers));
if (!papers.length) throw new Error('官方接口没有返回文献，未覆盖现有样本。');
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(output, JSON.stringify({ fetchedAt: new Date().toISOString(), note: '真实学术文献样本，不代表完整的今日监控。元数据与摘要来自 Europe PMC 官方接口；尚未进行全文和版本核验。', papers }, null, 2));
console.log(`已保存 ${papers.length} 篇可追溯文献样本。`);

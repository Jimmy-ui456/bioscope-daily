import { readFile, readdir, writeFile } from 'node:fs/promises';
import { sourceFingerprint } from '../dist/enrichment.js';
const source = JSON.parse(await readFile(new URL('../dist/sample.json', import.meta.url), 'utf8'));
const rows = JSON.parse(await readFile(new URL('../config/sample-translations.zh.json', import.meta.url), 'utf8'));
const manualDirectory = new URL('../config/manual-translations/', import.meta.url);
let manualFiles = [];
try { manualFiles = (await readdir(manualDirectory)).filter(name => name.endsWith('.json')).sort(); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const name of manualFiles) {
  const additions = JSON.parse(await readFile(new URL(name, manualDirectory), 'utf8'));
  if (!Array.isArray(additions)) throw new Error(`辅助译文文件不是数组：${name}`);
  rows.push(...additions);
}
const items = {};
for (const row of rows) {
  const paper = typeof row.sourceTitle === 'string' && typeof row.sourceAbstract === 'string'
    ? { id: row.paperId || `doi:${row.doi}`, title: row.sourceTitle, abstract: row.sourceAbstract }
    : source.papers.find(p => p.doi === row.doi);
  if (!paper) throw new Error(`译文找不到对应原文：${row.doi}`);
  if (typeof row.titleZh !== 'string' || !row.titleZh.trim() || typeof row.abstractZh !== 'string' || !row.abstractZh.trim()) throw new Error(`辅助译文缺失：${paper.id}`);
  items[paper.id] = { titleZh: row.titleZh, abstractZh: row.abstractZh, sourceTitle: paper.title, sourceAbstract: paper.abstract, sourceFingerprint: sourceFingerprint(paper), origin: 'assistant_translation', createdAt: '2026-10-29T00:00:00+08:00', reviewed: false, scope: 'abstract_only' };
}
await writeFile(new URL('../dist/translations.json', import.meta.url), JSON.stringify({ version: 1, note: '原型附带的辅助译文，尚未由领域专家审核；原始题名或摘要变化后自动失效。', items }, null, 2) + '\n');
console.log(`已生成 ${Object.keys(items).length} 篇中英对照。`);

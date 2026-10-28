import { readFile, writeFile } from 'node:fs/promises';
import { sourceFingerprint } from '../dist/enrichment.js';
const source = JSON.parse(await readFile(new URL('../dist/sample.json', import.meta.url), 'utf8'));
const rows = JSON.parse(await readFile(new URL('../config/sample-translations.zh.json', import.meta.url), 'utf8'));
const items = {};
for (const row of rows) {
  const paper = source.papers.find(p => p.doi === row.doi);
  if (!paper) throw new Error(`译文找不到对应原文：${row.doi}`);
  items[paper.id] = { titleZh: row.titleZh, abstractZh: row.abstractZh, sourceFingerprint: sourceFingerprint(paper), origin: 'assistant_translation', createdAt: '2026-10-29T00:00:00+08:00', reviewed: false, scope: 'abstract_only' };
}
await writeFile(new URL('../dist/translations.json', import.meta.url), JSON.stringify({ version: 1, note: '原型附带的辅助译文，尚未由领域专家审核；原始题名或摘要变化后自动失效。', items }, null, 2) + '\n');
console.log(`已生成 ${Object.keys(items).length} 篇中英对照。`);

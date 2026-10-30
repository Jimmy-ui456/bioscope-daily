import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFingerprint, translationVersionKey } from '../dist/enrichment.js';

function sameSource(item, paper) { return item && item.sourceTitle === paper.title && item.sourceAbstract === paper.abstract; }

export function buildTranslationCatalog(rows, samplePapers) {
  if (!Array.isArray(rows) || !Array.isArray(samplePapers)) throw new Error('辅助译文或样本文献不是数组');
  const items = {}, baseIds = new Set();
  for (const row of rows) {
    const paper = typeof row.sourceTitle === 'string' && typeof row.sourceAbstract === 'string'
      ? { id: row.paperId || `doi:${row.doi}`, title: row.sourceTitle, abstract: row.sourceAbstract }
      : samplePapers.find(p => p.doi === row.doi);
    if (!paper) throw new Error(`译文找不到对应原文：${row.doi}`);
    if (typeof row.titleZh !== 'string' || !row.titleZh.trim() || typeof row.abstractZh !== 'string' || !row.abstractZh.trim()) throw new Error(`辅助译文缺失：${paper.id}`);
    if (row.sourceNote !== undefined && (typeof row.sourceNote !== 'string' || row.sourceNote.length > 1000)) throw new Error(`原文来源提示无效：${paper.id}`);
    const createdAt = row.createdAt === undefined ? '2026-10-29T00:00:00+08:00' : row.createdAt;
    if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(createdAt)
      || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt.slice(0, 10) + 'T12:00:00Z').toISOString().slice(0, 10) !== createdAt.slice(0, 10)) throw new Error(`辅助译文时间无效：${paper.id}`);
    const previous = Object.hasOwn(items, paper.id) ? items[paper.id] : null;
    const versionKey = translationVersionKey(paper, paper.id);
    const existingSource = sameSource(previous, paper) ? previous : sameSource(items[versionKey], paper) ? items[versionKey] : null;
    const sourceNote = row.sourceNote === undefined ? existingSource?.sourceNote : row.sourceNote.trim();
    // When an archived source becomes current again, move it to the base rather
    // than keeping duplicate entries for that same title and abstract.
    if (sameSource(items[versionKey], paper)) delete items[versionKey];
    if (previous && !sameSource(previous, paper)) {
      const oldPaper = { id: paper.id, title: previous.sourceTitle, abstract: previous.sourceAbstract };
      const oldKey = translationVersionKey(oldPaper, paper.id);
      if (Object.hasOwn(items, oldKey) && !sameSource(items[oldKey], oldPaper)) throw new Error(`原文版本键冲突：${paper.id}`);
      items[oldKey] = previous;
    }
    items[paper.id] = { titleZh: row.titleZh, abstractZh: row.abstractZh, sourceTitle: paper.title, sourceAbstract: paper.abstract, sourceFingerprint: sourceFingerprint(paper), origin: 'assistant_translation', createdAt, reviewed: false, scope: 'abstract_only', ...(sourceNote ? { sourceNote } : {}) };
    baseIds.add(paper.id);
  }
  return { version: 1, note: '原型附带的辅助译文，尚未由领域专家审核；仅匹配对应的完整英文版本，保留旧版供相同原文的历史快照核对。', paperCount: baseIds.size, sourceVersionCount: Object.keys(items).length, items };
}

async function main() {
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
  const catalog = buildTranslationCatalog(rows, source.papers);
  await writeFile(new URL('../dist/translations.json', import.meta.url), JSON.stringify(catalog, null, 2) + '\n');
  console.log(`已生成 ${catalog.paperCount} 篇文献、${catalog.sourceVersionCount} 个原文版本的中英对照。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

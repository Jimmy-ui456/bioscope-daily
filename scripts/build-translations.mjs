import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFingerprint, translationVersionKey, validEnrichment } from '../dist/enrichment.js';

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

// Rebuilding auxiliary translations must not discard paid model results that
// were added by an unattended run. A deliberate same-source auxiliary update
// takes precedence; all other model source versions remain available.
export function preserveModelTranslations(catalog, previous) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous) || !previous.items || typeof previous.items !== 'object' || Array.isArray(previous.items)) throw new Error('已有译文目录无效，未覆盖');
  const items = { ...catalog.items };
  const identity = key => key.startsWith('version:') ? key.slice(8, key.lastIndexOf(':')) : key;
  const ids = new Set(Object.keys(items).map(identity));
  for (const [key, item] of Object.entries(previous.items)) {
    if (item?.origin !== 'model') continue;
    const id = identity(key), paper = { id, title: item.sourceTitle, abstract: item.sourceAbstract };
    if (!id || typeof paper.title !== 'string' || typeof paper.abstract !== 'string' || !validEnrichment(paper, item)) throw new Error('已有模型译文的原文绑定无效，未覆盖');
    if (sameSource(items[id], paper)) continue;
    const versionKey = translationVersionKey(paper, id);
    if (Object.hasOwn(items, versionKey)) {
      if (!sameSource(items[versionKey], paper)) throw new Error('模型译文版本键冲突，未覆盖');
      continue;
    }
    items[versionKey] = item; ids.add(id);
  }
  return { ...catalog, note: '本目录包含辅助译文与模型译文，均需人工核对；只匹配对应的完整英文版本，保留历史原文版本。',
    items, paperCount: ids.size, sourceVersionCount: Object.keys(items).length };
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
  let previous;
  try { previous = JSON.parse(await readFile(new URL('../dist/translations.json', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; previous = { items: {} }; }
  const catalog = preserveModelTranslations(buildTranslationCatalog(rows, source.papers), previous);
  await writeFile(new URL('../dist/translations.json', import.meta.url), JSON.stringify(catalog, null, 2) + '\n');
  console.log(`已生成 ${catalog.paperCount} 篇文献、${catalog.sourceVersionCount} 个原文版本的中英对照。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

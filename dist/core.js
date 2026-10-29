import { translationOf, attachEnrichment, interpretationOf } from './enrichment.js?v=0.2.10';
import { collectionSourceLabel, validWorkflowRunUrl } from './collection-source.js?v=0.2.10';

export const TOPICS = [
  { id: 'synthetic', name: '合成生物学', en: 'Synthetic biology', query: 'TITLE_ABS:"synthetic biology"', words: ['synthetic biology', 'synthetic circuit', 'synthetic gene', 'genome engineering'], color: 'green' },
  { id: 'metabolic', name: '代谢工程', en: 'Metabolic engineering', query: 'TITLE_ABS:"metabolic engineering"', words: ['metabolic engineering', 'metabolic pathway', 'biosynthesis', 'fermentation'], color: 'orange' },
  { id: 'microbial', name: '微生物制造', en: 'Microbial biomanufacturing', query: '(TITLE_ABS:"microbial cell factories" OR TITLE_ABS:"microbial production" OR TITLE_ABS:"biomanufacturing")', words: ['microbial', 'biomanufacturing', 'cell factor', 'bioproduction', 'yeast'], color: 'blue' }
];
export const API_URL = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
export const APP_VERSION = '0.2.10';

export function plainText(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
export function cleanDoi(value) {
  const doi = String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : null;
}
export function beijingDay(at = new Date()) {
  return new Date(new Date(at).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function dayBefore(days, at = new Date()) {
  return beijingDay(new Date(new Date(at).getTime() - days * 86400000));
}
export function validPublicationDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function classify(record, fallback) {
  const text = `${record.title} ${record.abstractText || ''}`.toLowerCase();
  const tags = TOPICS.filter(t => t.words.some(w => text.includes(w))).map(t => t.id);
  return [...new Set([...tags, ...(fallback ? [fallback] : [])])];
}
export function isRetracted(paper) {
  if (!paper || typeof paper !== 'object') return false;
  if (paper.isRetraction === true) return true;
  // Only explicit metadata labels count. A title mentioning retraction, or a
  // status such as "未发现撤稿" / "No retraction found", is not a positive signal.
  const positiveLabel = /^(?:撤稿相关|已撤稿|撤稿(?:通知|论文)?|已撤回|撤回通知|retracted(?: publication| article)?|retraction(?: of publication| notice)?|withdrawn(?: publication| article)?|withdrawal notice)(?:$|\s*[(:：（])/i;
  return ['type', 'status'].some(field => typeof paper[field] === 'string'
    && paper[field].split(/[·|/;；,，\n]+/).some(label => positiveLabel.test(label.trim().replace(/\s+/g, ' '))));
}
export function normalizePaper(record, topic, fetchedAt = new Date().toISOString()) {
  const doi = cleanDoi(record.doi);
  const publicationTypes = record.pubTypeList?.pubType || [];
  const joinedTypes = publicationTypes.join(' ').toLowerCase();
  const isPreprint = /preprint/i.test(joinedTypes) || record.source === 'PPR';
  const isRetraction = isRetracted({ type: publicationTypes.join('; ') });
  const journal = plainText(record.journalInfo?.journal?.title || (isPreprint ? '预印本平台' : '期刊信息未提供'));
  const abstract = plainText(record.abstractText || '');
  const title = plainText(record.title || '未提供标题');
  const pmid = record.source === 'MED' ? String(record.id) : null;
  const id = doi ? `doi:${doi}` : pmid ? `pmid:${pmid}` : `epmc:${record.source}:${record.id}`;
  const url = doi ? `https://doi.org/${doi}` : `https://europepmc.org/article/${encodeURIComponent(record.source)}/${encodeURIComponent(record.id)}`;
  const date = validPublicationDate(record.firstPublicationDate) ? record.firstPublicationDate : null;
  const type = isRetraction ? '撤稿相关' : /review/.test(joinedTypes) ? '综述' : isPreprint ? '预印本' : /journal article|research-article/.test(joinedTypes) ? '期刊论文' : '文献记录';
  return { id, title, abstract, authors: plainText(record.authorString || '作者信息未提供'), journal, doi, pmid, pmcid: record.pmcid || null, source: record.source, sourceId: String(record.id), url, publishedAt: date, discoveredAt: fetchedAt, topics: classify(record, topic), type, status: isRetraction ? '撤稿相关' : isPreprint ? '预印本 · 未经同行评审' : '期刊记录 · 待核验', isPreprint, isRetraction, readingScope: abstract ? '仅摘要' : '仅题录', license: record.license || null, version: null, collection: 'Europe PMC' };
}
export function mergePapers(existing, incoming) {
  return mergePapersWithIdMap(existing, incoming).papers;
}
// Backup selections may reference a duplicate's old ID, so retain each input ID's destination.
export function mergePapersWithIdMap(existing, incoming) {
  let out = [];
  const inputIds = new Map();
  for (const paper of [...existing, ...incoming]) {
    const doi = cleanDoi(paper.doi);
    const matches = out.filter(p => p.id === paper.id || (doi && cleanDoi(p.doi) === doi) || (p.pmid && paper.pmid && p.pmid === paper.pmid));
    if (!matches.length) {
      const added = { ...paper };
      if (isRetracted(paper)) { added.isRetraction = true; added.type = '撤稿相关'; added.status = '撤稿相关'; }
      out.push(added); inputIds.set(added, new Set([paper.id])); continue;
    }
    const previous = matches.reduce((a, b) => ({ ...a, ...b, id: a.id, doi: b.doi || a.doi, pmid: b.pmid || a.pmid, abstract: b.abstract || a.abstract, discoveredAt: a.discoveredAt < b.discoveredAt ? a.discoveredAt : b.discoveredAt, topics: [...new Set([...a.topics, ...b.topics])] }));
    const abstract = paper.abstract || previous.abstract;
    const merged = { ...previous, ...paper, id: previous.id, doi: doi || previous.doi, pmid: paper.pmid || previous.pmid, discoveredAt: previous.discoveredAt < paper.discoveredAt ? previous.discoveredAt : paper.discoveredAt, abstract, readingScope: abstract ? '仅摘要' : '仅题录', topics: [...new Set([...previous.topics, ...paper.topics])] };
    // Missing metadata in a later discovery cannot undo an earlier retraction signal.
    if (isRetracted(paper) || matches.some(isRetracted)) {
      merged.isRetraction = true; merged.type = '撤稿相关'; merged.status = '撤稿相关';
    }
    inputIds.set(merged, new Set([paper.id, ...matches.flatMap(p => [...inputIds.get(p)])]));
    matches.forEach(p => inputIds.delete(p));
    out = out.filter(p => !matches.includes(p));
    out.push(merged);
  }
  const idMap = new Map();
  for (const paper of out) for (const id of inputIds.get(paper)) idMap.set(id, paper.id);
  return { papers: out.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.title.localeCompare(b.title)), idMap };
}
export function isValidPaper(paper) {
  if (!paper || typeof paper !== 'object') return false;
  if (['isRetraction', 'isPreprint'].some(key => Object.hasOwn(paper, key) && typeof paper[key] !== 'boolean')) return false;
  const strings = ['id', 'title', 'abstract', 'authors', 'journal', 'url', 'status', 'type', 'discoveredAt', 'readingScope'];
  if (!strings.every(k => typeof paper[k] === 'string' && paper[k].length < 100000)) return false;
  if (!Array.isArray(paper.topics) || !paper.topics.every(id => TOPICS.some(t => t.id === id))) return false;
  if (paper.publishedAt !== null && !validPublicationDate(paper.publishedAt)) return false;
  if (!Number.isFinite(Date.parse(paper.discoveredAt))) return false;
  if (paper.doi !== null && typeof paper.doi !== 'string') return false;
  if (paper.pmid !== null && typeof paper.pmid !== 'string') return false;
  return /^https:\/\/(?:doi\.org|europepmc\.org)\//.test(paper.url) && ['仅摘要', '仅题录'].includes(paper.readingScope);
}
export function buildQuery(topic, days = 30, at = new Date()) {
  return `(${topic.query}) AND FIRST_PDATE:[${dayBefore(Math.max(0, days - 1), at)} TO ${beijingDay(at)}] sort_date:y`;
}
export async function collectTopic(topic, { days = 30, maxPages = 2, pageSize = 25, at = new Date(), fetchImpl = fetch, onProgress = () => {} } = {}) {
  const records = [];
  let cursor = '*';
  let hitCount = 0;
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ query: buildQuery(topic, days, at), format: 'json', resultType: 'core', pageSize: String(pageSize), cursorMark: cursor, sort_date: 'y' });
    const response = await fetchImpl(`${API_URL}?${params}`, { signal: AbortSignal.timeout(25000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Europe PMC 返回 HTTP ${response.status}`);
    const data = await response.json();
    if (data.errCode || !Array.isArray(data.resultList?.result)) throw new Error(data.errMsg || '文献接口返回了无法识别的格式');
    hitCount = Number(data.hitCount || 0);
    const batch = data.resultList.result.map(r => normalizePaper(r, topic.id, new Date().toISOString()));
    records.push(...batch);
    onProgress({ topic: topic.name, page: page + 1, count: records.length });
    const next = data.nextCursorMark;
    if (!next || next === cursor || !batch.length || records.length >= hitCount) break;
    cursor = next;
    if (page === maxPages - 1) truncated = true;
  }
  return { papers: mergePapers([], records), hitCount, truncated, query: buildQuery(topic, days, at) };
}
export function chooseReportPapers(papers, selectedIds, { days = 7, at = new Date(), limit = 10 } = {}) {
  const start = dayBefore(Math.max(0, days - 1), at);
  const end = beijingDay(at);
  return papers.filter(p => selectedIds.includes(p.id) && !isRetracted(p) && p.publishedAt && p.publishedAt >= start && p.publishedAt <= end).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, limit);
}
function markdownText(value) { return String(value || '').replace(/[\[\]<>]/g, '').replace(/\r?\n/g, ' '); }
function markdownHtmlText(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function appendCollectionMarkdown(lines, source) {
  if (!source) { lines.push('本期首刊未记录采集运行来源，不能用当前文献库反推本期采集结果。', ''); return; }
  const failed = Array.isArray(source.failedTopics) ? source.failedTopics.filter(topic => typeof topic === 'string').slice(0, 20) : [];
  const status = source.status === 'partial' || failed.length ? `部分方向未更新${failed.length ? '：' + failed.map(markdownText).join('、') : ''}` : source.status === 'complete' ? '本次各方向请求已完成（按配置读取上限）' : '完整性未记录';
  lines.push(`本期采集：${status}`, `触发方式：${collectionSourceLabel(source)}`);
  if (validWorkflowRunUrl(source.runUrl)) lines.push(`本期采集运行：${source.runUrl}`);
  lines.push('首刊保留成刊时的数据，后续补采不重写本期。', '');
}
function appendInterpretationMarkdown(lines, item) {
  lines.push('### 基于摘要的中文解读（未审核）', '', '引文与原文逐字匹配，不等于中文结论已经核实；请结合上下文和全文判断。', '');
  if (item.rejectedFields.length) lines.push('部分解读未通过当前原文证据校验，已隐藏；辅助译文仍需核对。', '');
  const fields = [['question', '研究问题'], ['methods', '研究方法'], ['findings', '主要结果']];
  const claims = [...fields.filter(([key]) => item[key]).map(([key, label]) => [label, item[key]]), ...item.limitations.map((claim, i) => [`摘要明确报告的局限 ${i + 1}`, claim])];
  for (const [label, claim] of claims) {
    const source = claim.source === 'title' ? '原文题名' : '原文摘要';
    lines.push(`**${label}**：${markdownHtmlText(claim.text)}`, '', `原文依据（${source}）：`, ...markdownHtmlText(claim.evidence).split(/\r?\n/).map(line => `> ${line}`), '');
  }
  if (!item.limitations.length) lines.push('摘要未提供可核对的局限解读；不据此推断研究没有局限。', '');
  lines.push(`模型：${markdownText(item.model || '记录未注明')} · 生成时间：${markdownText(item.createdAt || '记录未注明')}`, '');
}
export function knownRetraction(paper, currentPapers = []) {
  if (isRetracted(paper)) return paper;
  const doi = cleanDoi(paper.doi);
  return currentPapers.find(current => isRetracted(current) && (current.id === paper.id
    || (doi && cleanDoi(current.doi) === doi)
    || (paper.pmid && current.pmid && paper.pmid === current.pmid))) || null;
}
export function reportMarkdown(report, catalog = {}, currentPapers = []) {
  const isPublic = report.kind === 'public_daily';
  const lines = [`# 生研观察 · ${report.date} ${isPublic ? '公共文献简报' : '日报'}`, '', `生成时间：${new Date(report.createdAt).toISOString()}（UTC）`, `数据：${report.origin === 'sample' ? '文献样本或个人导入记录，来源需核对，不代表今日完整监控' : 'Europe PMC 实时采集缓存'}`, `覆盖：${report.windowStart} 至 ${report.date} 发表、${isPublic ? '按主题覆盖与发表日期规则自动整理' : '由使用者手动精选'}的文献（最多 10 条）`, ...(isPublic ? [report.selectionPolicy?.description || '按规则自动整理，非人工科研价值精选。', report.selectionPolicy?.coverageNote || '只覆盖当前文献库，不代表完整领域监控。'] : []), '阅读范围：仅题录或摘要；未进行全文核验。', '中英对照为辅助译文；自动解读基于摘要，需核对原文。无译文的文献明确保留待翻译状态。', ''];
  if (isPublic) appendCollectionMarkdown(lines, report.sourceCollection);
  report.papers.forEach((p, i) => {
    const enriched = attachEnrichment(p, catalog);
    const t = translationOf(enriched);
    const interpretation = interpretationOf(enriched);
    const retraction = knownRetraction(p, currentPapers);
    lines.push(`## ${i + 1}. ${markdownText(t?.titleZh || p.title)}`, '', t ? `**English title**: ${markdownText(p.title)}` : '**中文对照：待翻译**', '', `- 出处：${markdownText(p.journal)} · ${p.publishedAt || '日期未知'}`, `- 作者：${markdownText(p.authors)}`, `- 类型／状态：${p.type}／${p.status}`, `- 阅读范围：${p.readingScope}`, `- DOI：${p.doi || '接口未提供'}`, `- PMID：${p.pmid || '不适用／未提供'}`, `- 原文：${p.url}`, '', ...(t?.sourceNote ? [`**原文来源提示：${markdownText(t.sourceNote)}**`, ''] : []), t ? `**中文摘要（辅助译文，未审核）**\n\n${t.abstractZh}` : '中文摘要：待翻译。', '', p.abstract ? `**原文摘要**\n\n${p.abstract}` : '接口未提供摘要，请阅读原文。', '');
    if (retraction) lines.push(`**已知撤稿相关信号**：本库已记录此文献的撤稿相关状态；原刊快照保持原样，请核对来源：${retraction.url}`, '');
    if (interpretation) appendInterpretationMarkdown(lines, interpretation);
  });
  if (!report.papers.length) lines.push(isPublic ? '本期没有符合规则的自动整理文献。' : '本期没有符合条件的人工精选文献。');
  return lines.join('\n');
}

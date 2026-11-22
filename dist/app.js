import { prepareBackupImport, sharedLibraryPapers } from './backup.js?v=0.2.39';
import { collectionHealth } from './health.js?v=0.2.39';
import { snapshotCoverage, snapshotDirections } from './snapshot-coverage.js?v=0.2.39';
import { indexSharedRecords, sharedReportChanges } from './report-comparison.js?v=0.2.39';
import { createReaderTransferBlob, readReaderTransferFile, prepareReaderTransfer, checkReaderTransferStorage, persistReaderTransfer } from './reader-transfer.js?v=0.2.39';
import { collectionSourceLabel, validWorkflowRunUrl } from './collection-source.js?v=0.2.39';
import { evidenceContext } from './evidence.js?v=0.2.39';
import { reportLocation, sharedReportLocation } from './report-navigation.js?v=0.2.39';
import { incomingPaperNavigation, resolveSharedPaper, pendingSharedPaper, sharedPaperLocation, consumePaperLocation } from './paper-navigation.js?v=0.2.39';
import { planSharedRefresh } from './shared-refresh.js?v=0.2.39';
import { manualCollectionOutcome } from './manual-collection.js?v=0.2.39';
import { indexPaperReferences, togglePaperReference } from './paper-references.js?v=0.2.39';
import { reportRis } from './report-ris.js?v=0.2.39';
import { preparePublicArchive, publicArchiveNotice } from './public-archive.js?v=0.2.39';
import { readLocalReaderState, persistLocalRecovery, persistReaderPresets, persistReadMarks, persistPaperReferences, readerPresetSnapshot, READER_PRESET_LIMITS, READER_DEFAULTS as readerDefaults } from './local-state.js?v=0.2.39';
import { READ_MARK_LIMIT, readMarkFor, indexReadMarks, matchingReadMarks, filterByReadProgress } from './read-progress.js?v=0.2.39';
import { paperKind, journalName, filterReadingPapers, readingBasePapers, createSearchInputController, papersForDownloadRanking, searchReadingPapers, discoveryDay } from './reader.js?v=0.2.39';
import { focusSnapshot, restoreFocus, applyNavigationState, trapFocus, focusNewResults } from './accessibility.js?v=0.2.39';
import { TOPICS, APP_VERSION, collectTopic, beijingDay, dayBefore, chooseReportPapers, reportMarkdown, knownRetraction, isRetracted } from './core.js?v=0.2.39';

import { attachEnrichment, readingAvailability, metricGroup, metricLabel, metricCoverageLabel, metricFetchedAtLabel, rankDownloads, validateDownloadMetric, rankableDownloadMetric, downloadRefreshLabel, downloadRefreshSummaryLabel } from './enrichment.js?v=0.2.39';

const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const storageKey = 'bioscope.v1.';
function read(key, fallback) { try { return JSON.parse(localStorage.getItem(storageKey + key)) ?? fallback; } catch { return fallback; } }
const localState = readLocalReaderState({ getItem: key => localStorage.getItem(key) }, storageKey);
const protectedStorageKeys = new Set(localState.protectedKeys);
const paperReferenceRaw = { bookmarks: localState.rawRecords.bookmarks ?? null, selected: localState.rawRecords.selected ?? null };
const browserStorage = { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };
let readerPresets = localState.readerPresets;
let readerPresetRaw = localState.rawRecords.readerPresets ?? null;
let readMarks = localState.readMarks;
let readMarksRaw = localState.rawRecords.readMarks ?? null;
let readMarksIndex = indexReadMarks(readMarks);
let readerPresetName = '';
let readerPresetId = readerPresets[0]?.id ?? '';
let composingPresetName = false;
let composingSearch = false;
let pendingReadingRender = false;
let readerTransferPreview = null, readerTransferMessage = '', readerTransferRequest = 0;
let localRecoveryMessage = '';
function write(key, value) {
  if (protectedStorageKeys.has(key)) { toast('该本机记录需要核对，原始内容尚未覆盖；请先处理页面上的本机数据恢复提示，本次改动仅保留在当前页面。'); return false; }
  try { localStorage.setItem(storageKey + key, JSON.stringify(value)); return true; }
  catch { toast('浏览器存储空间不足或未允许保存，本次内容仅保留在当前页面。'); return false; }
}
const settings = localState.settings;
const cache = localState.cache;
const readerFilters = localState.readerFilters;
const state = { view: 'overview', topic: 'all', filter: 'all', search: '', page: 1, readerFilters, filtersOpen: Object.keys(readerDefaults).some(key => readerFilters[key] !== readerDefaults[key]), papers: cache?.papers || [], origin: cache?.origin || 'sample', containsImported: cache?.containsImported === true, updatedAt: cache?.updatedAt || null, bookmarks: localState.bookmarks, selected: localState.selected, reports: localState.reports, reportId: null, busy: false, progress: '', error: '', settings, stats: cache?.stats || [] };
let sample = null;
let publicReports = [];
let publicArchive = { reports: [], status: 'unavailable', skipped: 0 };
let publicArchiveBusy = false;
function allReports() { return [...publicReports, ...state.reports]; }
let translations = {};
let libraryMeta = null;
let displayMode = localState.displayMode;
let downloadGroup = '';
let backendStatus = null;
let sharedAvailable = false;
let sharedSnapshotStatus = 'unavailable';
let sharedRefreshBusy = false;
let samplePinned = false;
let runtimeRefreshBusy = false;
// Cache source markup; DOM serialization normalizes SVG tags and would repeat live announcements.
const healthMarkupByNode = new WeakMap();
const coverageMarkupByNode = new WeakMap();
const sharedRecordIndexes = new WeakMap();
let toastTimer;
const navigationMedia = window.matchMedia('(max-width: 760px)');
let mobileMenuOpen = false;
let dialogPaper = null, dialogReadChangeIndex = null;
let dialogReturnFocus = null;
let dialogPaperId = null;
let dialogReadOnly = false;
let paperLinkStatus = null;
let pendingPaperRequest = null;
const INITIAL_LIBRARY_ERROR = '文献数据载入失败。可点击更新文献重试。';

const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
  flame: '<path d="M13 3c1 5-3 5-1 9 1-2 3-3 4-3 3 4 4 6 3 9-1 3-4 4-7 4S5 20 5 16c0-4 5-7 5-11 0-1 0-2 1-3z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/>',
  bookmark: '<path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4z"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>',
  settings: '<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow: '<path d="M4 12h16m-5-5 5 5-5 5"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  leaf: '<path d="M20 3C9 2 2 7 4 15c2 8 16 7 16-12zM5 19 15 8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  book: '<path d="M12 5v16M3 3c4-1 7 0 9 2 2-2 5-3 9-2v16c-4-1-7 0-9 2-2-2-5-3-9-2z"/>',
  filter: '<path d="M4 5h16l-6 7v7l-4 2v-9z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  inbox: '<path d="M5 4h14l3 11v5H2v-5zM2 15h6l1 3h6l1-3h6"/>',
  printer: '<path d="M6 8V3h12v5M6 17H3V9h18v8h-3M6 14h12v7H6zM17 11h1"/>'
};
function icon(name, size = 16, cls = '') { return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`; }
function topicOf(id) { return TOPICS.find(t => t.id === id) || TOPICS[0]; }
function shortDate(value) { return value ? value.replaceAll('-', '.') : '日期未提供'; }
function originLabel() { return state.containsImported ? '含个人导入的文献库' : state.origin === 'sample' ? '文献样本' : '实时采集缓存'; }
function activePapers() { return state.papers.filter(p => p.topics.some(t => state.settings.topics.includes(t))); }
function topicTag(id) { const t = topicOf(id); return `<span class="tag ${t.color}">${t.name}</span>`; }
function toast(message) {
  const dialog = $('#paper-dialog');
  const node = dialog?.open ? $('#dialog-status', dialog) : $('#toast');
  if (!node) return;
  if (dialog?.open) { $('#toast').textContent = ''; $('#toast').classList.remove('show'); }
  node.textContent = message; node.classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.classList.remove('show'); if (node.id === 'dialog-status') node.textContent = ''; }, 4500);
}
function cacheValue() { return { papers: state.papers, origin: state.origin, containsImported: state.containsImported === true, updatedAt: state.updatedAt, stats: state.stats }; }
function cacheActive() { return write('cache', cacheValue()); }
function localRecoveryMarkup() {
  if (!protectedStorageKeys.size) return '';
  const issues = localState.issues.filter(issue => protectedStorageKeys.has(issue.key));
  const labels = { settings: '监控设置', cache: '文献缓存', readerFilters: '阅读筛选', readerPresets: '搜索预设', readMarks: '已读标记', bookmarks: '收藏', selected: '精选', reports: '个人简报', displayMode: '中英显示' };
  return '<section class="report-warning" role="status" aria-live="polite" aria-label="本机数据恢复提示"><strong>部分本机数据需要核对</strong><p>已恢复可读内容，异常原始记录尚未覆盖。请先导出原始副本，再决定是否用当前恢复内容替换异常记录；确认前，相关改动仅保留在当前页面。收藏编号不会因论文暂未载入而删除。</p><details><summary>查看恢复情况</summary><ul>' + issues.map(issue => '<li><strong>' + esc(labels[issue.key] || '本机记录') + '：</strong>' + esc(issue.message) + '</li>').join('') + '</ul></details>' + (localRecoveryMessage ? '<p>' + esc(localRecoveryMessage) + '</p>' : '') + '<div class="settings-buttons"><button class="button small" data-action="export-local-recovery">导出原始副本</button><button class="button small" data-action="resume-local-storage">用恢复内容替换异常记录</button></div></section>';
}


function manualCollectionOnly() { return typeof backendStatus?.modelConfigured !== 'boolean' && libraryMeta?.automation?.collectionSource?.trigger === 'workflow_dispatch' && libraryMeta.automation.modelConfigured === false && libraryMeta.automation.modelRunLimit !== 1; }
function automaticModelPaused() { return typeof backendStatus?.modelConfigured !== 'boolean' && libraryMeta?.automation?.modelStatus === 'automatic_paused'; }
function paperHeading(p, reading = readingAvailability(p, translations)) {
  const titleZh = reading.translation?.titleZh.trim();
  return displayMode === 'bilingual' && titleZh ? '<span class="zh-title" lang="zh-CN">' + esc(titleZh) + '</span><span class="en-title" lang="en">' + esc(p.title) + '</span>' : esc(p.title);
}
function readMarkButton(paper, detail = false) {
  const mark = readMarkFor(paper);
  if (!mark) return '';
  const isRead = Boolean(matchingReadMarks(readMarksIndex, mark).size);
  const label = isRead ? '取消已读' : '标为已读';
  return `<button class="${detail ? 'button' : 'paper-action'}${isRead ? ' on' : ''}" data-action="toggle-read" data-read-mark="${esc(JSON.stringify(mark))}" aria-label="${label}：${esc(paper.title)}">${icon('book', 13)}${label}</button>`;
}
function paperAbstract(p, reading, compact = false) {
  const t = reading.translation;
  const sourceHint = t?.sourceNote ? '<p class="source-note" lang="zh-CN"><strong>原文来源提示：</strong>' + esc(t.sourceNote) + '</p>' : '';
  if (!reading.hasAbstract) return sourceHint;
  const original = esc(p.abstract);
  if (displayMode === 'en' || !reading.bilingual) return sourceHint + '<p class="' + (compact ? 'paper-abstract' : 'original-abstract') + '" lang="en">' + original + '</p>';
  return sourceHint + '<div class="bilingual-abstract ' + (compact ? 'compact' : '') + '"><section><span class="language-label">中文 · 辅助译文，未审核</span><p lang="zh-CN">' + esc(t.abstractZh) + '</p></section><section><span class="language-label">ENGLISH · 原文摘要</span><p lang="en">' + original + '</p></section></div>';
}
function evidenceBlock(paper, claim, expanded = false) {
  const context = evidenceContext(paper, claim);
  if (!context) return '';
  const label = '核对英文依据 · ' + (context.source === 'title' ? '原文题名' : '原文摘要');
  const quote = '<blockquote lang="en">' + (context.truncatedBefore ? '…' : '') + esc(context.before) + '<mark>' + esc(context.match) + '</mark>' + esc(context.after) + (context.truncatedAfter ? '…' : '') + '</blockquote>';
  return expanded ? '<div class="evidence-context"><span class="help">' + label + '</span>' + quote + '</div>' : '<details><summary>' + label + '</summary>' + quote + '</details>';
}
function interpretationBlock(p, reading, { report = false } = {}) {
  if (!reading.hasAbstract) return '';
  const t = reading.interpretation;
  if (!reading.cited) {
    return reading.translation?.analysisStatus === 'translation_only' || t
      ? '<p class="evidence-warning">本条没有通过原文证据校验的解读。</p>' : '';
  }
  const fields = [['question', '研究问题'], ['methods', '研究方法'], ['findings', '主要结果']];
  const warning = t.rejectedFields.length ? '<p class="evidence-warning">部分解读未通过当前原文证据校验，已隐藏；辅助译文仍需核对。</p>' : '';
  const rows = fields.filter(([key]) => t[key]).map(([key, label]) => '<div class="interpretation-row"><strong>' + label + '</strong><p>' + esc(t[key].text) + '</p>' + evidenceBlock(p, t[key], report) + '</div>').join('');
  const limitations = t.limitations.length ? '<div class="interpretation-row"><strong>摘要明确报告的局限</strong>' + t.limitations.map(item => '<p>' + esc(item.text) + '</p>' + evidenceBlock(p, item, report)).join('') + '</div>' : '';
  const generatedAt = t.createdAt ? esc(formatReaderTime(t.createdAt)) + '（北京）' : '记录未注明';
  return '<section class="interpretation"><h3>自动中文解读 <span class="tag warn">基于摘要 · 未审核</span></h3>' + warning + rows + limitations + '<div class="help">模型：' + esc(t.model || '记录未注明') + ' · 生成：' + generatedAt + '<br>引文与原文逐字匹配，不等于中文结论已经核实；请结合上下文和全文判断。</div></section>';
}

const views = {
  overview: { name: '研究雷达', en: 'YOUR RESEARCH, IN FOCUS', subtitle: '从海量文献里，发现与你的研究有关的新线索。' },
  hot: { name: '文献下载量', en: 'PUBLISHER DOWNLOADS', subtitle: '按原出版平台的真实下载量，观察文献的使用情况。' },
  daily: { name: '每日简报', en: 'THE DAILY EDITION', subtitle: '把亲手精选的研究，整理成一份可追溯的简报。' },
  bookmarks: { name: '我的收藏', en: 'YOUR READING SHELF', subtitle: '值得细读的研究，留在你的书架上。' },
  topics: { name: '研究主题', en: 'FOLLOW YOUR CURIOSITY', subtitle: '从研究方向出发，建立自己的文献视野。' },
  sources: { name: '信源管理', en: 'TRACE EVERY FINDING', subtitle: '每一条研究，都应该能回到它的出处。' },
  settings: { name: '监控设置', en: 'MAKE IT YOURS', subtitle: '调整研究方向与采集范围，让信息与你相关。' }
};
function navItem(view, name, symbol, count) { return `<button class="nav-link ${state.view === view ? 'active' : ''}" data-view="${view}" ${state.view === view ? 'aria-current="page"' : ''}>${icon(symbol, 17)}<span>${name}</span>${count != null ? `<span class="nav-count">${count}</span>` : ''}</button>`; }
function sidebar() {
  return `<div class="mobile-shade" data-action="close-menu" aria-hidden="true"></div><aside id="primary-navigation" class="sidebar" aria-label="主要导航"><button class="icon-button sidebar-close" data-action="close-menu" aria-label="关闭导航">${icon('close', 20)}</button><a href="./#overview" class="brand" data-view="overview" aria-label="生研观察首页"><img src="./icon.svg" alt=""><div><div class="brand-name">生研观察</div><div class="brand-sub">BIOSCOPE DAILY</div></div></a><div class="sidebar-label">DISCOVER / 发现</div><nav>${navItem('overview', '研究雷达', 'grid')}${navItem('hot', '文献下载量', 'download')}${navItem('daily', '每日简报', 'file', allReports().length || undefined)}${navItem('bookmarks', '我的收藏', 'bookmark', boundPaperIds('bookmarks').size || undefined)}</nav><div class="sidebar-label">RESEARCH / 研究方向</div><div class="sidebar-topics">${TOPICS.map(t => `<button class="topic-nav" data-topic="${t.id}"><span class="dot ${t.color}"></span>${t.name}</button>`).join('')}</div><div class="sidebar-label">WORKSPACE / 工作台</div><nav>${navItem('topics', '研究主题', 'layers')}${navItem('sources', '信源管理', 'globe')}${navItem('settings', '监控设置', 'settings')}</nav><div class="sidebar-bottom"><div class="local-note"><strong>${icon('leaf', 13)} 为好奇心留一点时间</strong><p>记录证据，保留疑问。<br>让每天的阅读，都更接近研究本身。</p></div><div class="user-row"><span class="user-avatar">研</span><div>个人科研工作台</div><span>V${APP_VERSION}</span></div></div></aside>`;
}
function masthead() {
  const v = views[state.view];
  const today = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
  const week = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(new Date());
  return `<header class="masthead"><div><div class="eyebrow"><span class="line"></span>${v.en}</div><h1>${v.name}${state.view === 'overview' ? '<span style="color:#a9b69b;font-weight:400">.</span>' : ''}</h1><p>${v.subtitle}</p></div><div class="masthead-date"><strong>${today}</strong><span>${week} <i>·</i> ${originLabel()}</span></div></header>`;
}
function hero() { return `<section class="hero"><div class="hero-text"><div class="hero-kicker"><span></span> CURATED BY YOU. GROUNDED IN SCIENCE.</div><h2>把值得读的研究，<br>留给今天。</h2><p>跟踪生物科研进展，沉淀有价值的发现。<br>从一篇论文开始，看见下一步研究的可能。</p><div class="hero-actions"><button class="button primary" data-action="collect" ${state.busy ? 'disabled' : ''}>${icon('refresh', 13, state.busy ? 'spin' : '')}${state.busy ? '正在采集' : '更新文献'} ${icon('arrow', 12)}</button><button class="button quiet" data-view="daily">阅读每日简报 ${icon('arrow', 13)}</button></div></div><div class="hero-art" aria-hidden="true"><div class="orbit"></div><div class="orbit two"></div><div class="orbit three"></div><div class="art-core">β</div><div class="art-dot"></div><div class="art-dot d2"></div><div class="art-dot d3"></div><div class="art-cross">+</div><div class="art-label">FOLLOW THE SCIENCE</div></div></section>`; }
function metrics() {
  const papers = activePapers();
  const values = [
    { label: '当前文献库', n: papers.length, unit: '篇', caption: state.containsImported ? '含个人导入，来源请核对' : state.origin === 'sample' ? '已验证的真实文献样本' : '已采集 · 按文献标识去重', icon: 'book' },
    { label: '人工精选', n: papers.filter(p => boundPaperIds('selected').has(p.id)).length, unit: '篇', caption: '由你判断研究的阅读价值', icon: 'check' },
    { label: '追踪主题', n: state.settings.topics.length, unit: '个', caption: '围绕你的研究兴趣', icon: 'layers' },
    { label: '可读摘要', n: papers.filter(p => p.abstract).length, unit: '篇', caption: '保留原文 · 方便追溯', icon: 'file' }
  ];
  return `<section class="metrics" aria-label="文献库概况">${values.map(v => `<div class="metric"><div><div class="metric-name">${v.label}</div><div class="metric-value">${v.n}<small>${v.unit}</small></div><div class="metric-caption">${v.caption}</div></div><span class="metric-symbol">${icon(v.icon, 15)}</span></div>`).join('')}</section>`;
}
function paperCard(p) {
  const discovered = state.readerFilters.dateBasis === 'discovered' ? discoveryDay(p) : null;
  const reading = readingAvailability(p, translations);
  return `<article class="paper-card"><div class="paper-top"><div class="tags">${p.topics.slice(0, 2).map(topicTag).join('')}<span class="tag ${p.isPreprint || isRetracted(p) ? 'warn' : 'outline'}">${esc(isRetracted(p) ? '撤稿相关' : p.type)}</span></div><span class="paper-journal" title="${esc(p.journal)}">${esc(p.journal)}</span></div><button class="paper-title" data-paper="${esc(p.id)}">${paperHeading(p, reading)}</button><p class="reading-availability">${reading.label}</p>${paperAbstract(p, reading, true)}<div class="paper-bottom"><div class="paper-meta"><span>发表 ${shortDate(p.publishedAt)}</span>${discovered ? `<span class="sep">/</span><span>发现 ${shortDate(discovered)}</span>` : ''}<span class="sep">/</span><span>Europe PMC</span></div><div class="paper-actions">${readMarkButton(p)}<button class="paper-action ${boundPaperIds('selected').has(p.id) ? 'on' : ''}" data-select="${esc(p.id)}" ${isRetracted(p) ? 'disabled' : ''} aria-pressed="${boundPaperIds('selected').has(p.id)}" aria-label="${boundPaperIds('selected').has(p.id) ? '取消精选' : '加入精选'}：${esc(p.title)}">${icon('check', 13)}${boundPaperIds('selected').has(p.id) ? '已精选' : '精选'}</button><button class="paper-action ${boundPaperIds('bookmarks').has(p.id) ? 'on' : ''}" data-bookmark="${esc(p.id)}" aria-pressed="${boundPaperIds('bookmarks').has(p.id)}" aria-label="${boundPaperIds('bookmarks').has(p.id) ? '取消收藏' : '收藏'}：${esc(p.title)}">${icon('bookmark', 13)}</button><button class="paper-action" data-paper="${esc(p.id)}" aria-label="查看论文详情">${icon('arrow', 14)}</button></div></div></article>`;
}
let indexedPapers = null, resolvePaperReference;
const boundReferenceLists = new Map();
function paperReferenceLookup() {
  if (indexedPapers !== state.papers) {
    indexedPapers = state.papers;
    resolvePaperReference = indexPaperReferences(indexedPapers);
    boundReferenceLists.clear();
  }
  return resolvePaperReference;
}
function boundPaperIds(field) {
  const resolve = paperReferenceLookup(), references = state[field];
  const previous = boundReferenceLists.get(field);
  if (previous?.references === references) return previous.ids;
  const ids = new Set(references.map(resolve).filter(id => id !== null));
  boundReferenceLists.set(field, { references, ids });
  return ids;
}
function readerBasePapers() {
  return readingBasePapers(state.papers, { view: state.view, topics: state.settings.topics, bookmarks: [...boundPaperIds('bookmarks')] });
}
function filteredPapers() {
  let papers = filterByReadProgress(filterReadingPapers(readerBasePapers(), state.readerFilters), state.readerFilters.progress, readMarksIndex);
  if (state.topic !== 'all') papers = papers.filter(p => p.topics.includes(state.topic));
  if (state.filter === 'translated') papers = papers.filter(p => readingAvailability(p, translations).bilingual);
  if (state.filter === 'cited') papers = papers.filter(p => readingAvailability(p, translations).cited);
  if (state.filter === 'selected') papers = papers.filter(p => boundPaperIds('selected').has(p.id));
  if (state.filter === 'preprint') papers = papers.filter(p => p.isPreprint);
  if (state.filter === 'research') papers = papers.filter(p => p.type === '期刊论文');
  return searchReadingPapers(papers, state.search, translations);
}
function empty(title, copy, button = '') { return `<div class="empty"><div class="empty-icon">${icon('inbox', 30)}</div><h3>${title}</h3><p>${copy}</p>${button}</div>`; }
function tabs() { return `<div class="tabs-row"><div class="tabs" role="group" aria-label="文献筛选">${[['all', '全部研究'], ['translated', '中英对照'], ['cited', '附原文引文'], ['selected', '人工精选'], ['research', '期刊论文'], ['preprint', '预印本']].map(([id, label]) => `<button class="tab ${state.filter === id ? 'active' : ''}" data-filter="${id}" aria-pressed="${state.filter === id}">${label}${id === 'translated' ? `<span class="reader-tab-count">${readerBasePapers().filter(p => readingAvailability(p, translations).bilingual).length}</span>` : ''}</button>`).join('')}</div><label class="topic-selector" for="topic-filter"><span>方向</span><select id="topic-filter"><option value="all">全部方向</option>${TOPICS.map(t => `<option value="${t.id}" ${state.topic === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}</select></label></div>`; }
function activeReaderLabels() {
  const filters = state.readerFilters;
  const labels = [];
  if (filters.journal !== 'all') labels.push(filters.journal);
  if (filters.days) labels.push(`${filters.dateBasis === 'discovered' ? '发现' : '发表'} · ${filters.days === 1 ? '今天' : `最近 ${filters.days} 个日历日`}`);
  else if (filters.dateBasis === 'discovered') labels.push('按本库首次发现排序');
  if (filters.kind !== 'all') labels.push(({ article: '期刊研究论文', review: '综述', preprint: '预印本', other: '其他记录' })[filters.kind]);
  if (filters.abstract !== 'all') labels.push(filters.abstract === 'available' ? '有摘要' : '仅题录');
  if (filters.progress !== 'all') labels.push(filters.progress === 'read' ? '已读' : '待读');
  return labels;
}
function hasReaderConditions() { return activeReaderLabels().length || state.topic !== 'all' || state.filter !== 'all' || state.search.trim(); }
function readerSummaryContent() {
  const conditions = [state.topic !== 'all' ? topicOf(state.topic).name : '', ({ translated: '中英对照', cited: '附原文引文', selected: '人工精选', research: '期刊论文', preprint: '预印本' })[state.filter] || '', ...activeReaderLabels(), state.search.trim() ? `搜索：${state.search.trim()}` : ''].filter(Boolean);
  return `<div><span class="reader-result-count" role="status" aria-live="polite">找到 <strong>${filteredPapers().length}</strong> 篇 / 当前${state.view === 'bookmarks' ? '收藏' : '关注方向'} ${readerBasePapers().length} 篇</span>${conditions.length ? `<p class="reader-condition-text">筛选：${conditions.map(esc).join(' · ')}</p>` : '<p class="reader-condition-text">可按发表或本库首次发现的日期筛选和排序。</p>'}</div>${hasReaderConditions() ? '<button class="reader-reset" data-action="reset-filters">清除筛选</button>' : ''}`;
}
function readerSortLabel() { return state.readerFilters.dateBasis === 'discovered' ? '按本库首次发现排序' : '按发表日期排序'; }
function readerPresetTools() {
  const disabled = readerPresets.length ? '' : 'disabled';
  return `<section class="reader-presets" aria-labelledby="reader-presets-title"><h3 id="reader-presets-title">搜索预设</h3>
    <form id="reader-preset-form" class="reader-preset-row">
      <label for="reader-preset-name">预设名称 <input id="reader-preset-name" maxlength="${READER_PRESET_LIMITS.name}" value="${esc(readerPresetName)}" required></label>
      <button type="submit" class="button small">保存当前筛选</button>
    </form>
    <div class="reader-preset-row">
      <label for="reader-preset-select">已保存预设 <select id="reader-preset-select" ${disabled}>${readerPresets.length ? readerPresets.map(({ id, name }) => `<option value="${esc(id)}" ${id === readerPresetId ? 'selected' : ''}>${esc(name)}</option>`).join('') : '<option>暂无预设</option>'}</select></label>
      <button id="apply-reader-preset" class="button small" data-action="apply-reader-preset" ${disabled}>应用</button>
      <button class="button small" data-action="delete-reader-preset" ${disabled}>删除</button>
    </div>
    <p>预设仅保存在此浏览器。</p>
  </section>`;
}
function readerTools() {
  const filters = state.readerFilters;
  const counts = new Map();
  for (const paper of readerBasePapers()) { const journal = journalName(paper); counts.set(journal, (counts.get(journal) || 0) + 1); }
  if (filters.journal !== 'all' && !counts.has(filters.journal)) counts.set(filters.journal, 0);
  const journals = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'));
  const activeCount = activeReaderLabels().length;
  return `<label class="reader-date-basis" for="reader-date-basis"><span>日期与排序</span><select id="reader-date-basis" aria-describedby="reader-date-help"><option value="published">发表日期</option><option value="discovered" ${filters.dateBasis === 'discovered' ? 'selected' : ''}>本库首次发现</option></select></label><p class="reader-date-help" id="reader-date-help">${filters.dateBasis === 'discovered' ? '按记录首次进入文献库的时间查找，也能看到较早发表的论文。' : '按文献来源提供的发表日期查找。'}</p><details id="reading-filters" class="reading-filters" ${state.filtersOpen ? 'open' : ''}><summary id="reading-filters-summary">${icon('filter', 13)}精细筛选 <span>${activeCount ? `已应用 ${activeCount} 项` : '期刊 · 日期 · 类型 · 摘要 · 阅读进度'}</span></summary><div class="reader-filter-grid"><label for="reader-journal"><span>期刊 / 来源</span><select id="reader-journal"><option value="all">全部期刊与来源（${journals.length}）</option>${journals.map(([journal, count]) => `<option value="${esc(journal)}" ${filters.journal === journal ? 'selected' : ''}>${esc(journal)} · ${count} 篇</option>`).join('')}</select></label><label for="reader-days"><span>日期范围（北京时间）</span><select id="reader-days">${[[0, '全部已载入文献'], [1, '今天'], [7, '最近 7 个日历日'], [30, '最近 30 个日历日'], [90, '最近 90 个日历日']].map(([value, label]) => `<option value="${value}" ${filters.days === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label for="reader-kind"><span>内容类型</span><select id="reader-kind">${[['all', '全部类型'], ['article', '期刊研究论文'], ['review', '综述'], ['preprint', '预印本'], ['other', '其他文献记录']].map(([value, label]) => `<option value="${value}" ${filters.kind === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label for="reader-abstract"><span>可阅读内容</span><select id="reader-abstract">${[['all', '摘要与题录均显示'], ['available', '只看有摘要的文献'], ['missing', '只看没有摘要的题录']].map(([value, label]) => `<option value="${value}" ${filters.abstract === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label for="reader-progress"><span>阅读进度</span><select id="reader-progress">${[['all', '全部'], ['unread', '待读'], ['read', '已读']].map(([value, label]) => `<option value="${value}" ${filters.progress === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><p class="reader-filter-help">筛选适用于当前载入的文献。日期范围按上方所选日期计算。</p></div></details><div id="reader-summary" class="reader-summary">${readerSummaryContent()}</div>`;
}
function formatReaderTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}
function collectionStatusMarkup() {
  const health = collectionHealth({ library: libraryMeta, backend: backendStatus, sharedAvailable, sharedSnapshotStatus });
  const time = health.snapshotAt ? '<time datetime="' + esc(health.snapshotAt) + '">快照保存：' + esc(formatReaderTime(health.snapshotAt)) + '（北京）</time>' : '';
  const source = libraryMeta?.automation?.collectionSource;
  const runUrl = validWorkflowRunUrl(source?.runUrl) ? source.runUrl : null;
  const link = runUrl || 'https://github.com/Jimmy-ui456/bioscope-daily/actions/workflows/pages.yml';
  return '<section class="collection-health ' + health.level + '" aria-label="后台采集状态"><div class="collection-health-title">' + icon(health.level === 'running' ? 'refresh' : health.level === 'ok' ? 'check' : 'info', 14, health.level === 'running' ? 'spin' : '') + '<strong>' + esc(health.label) + '</strong>' + time + '</div><p>' + esc(health.message) + '</p><p class="help">快照来源：' + esc(collectionSourceLabel(source)) + ' · <a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + (runUrl ? '查看该快照的运行记录' : '查看云端采集与发布记录') + ' ↗</a></p><p class="help download-refresh-summary">逐篇统计刷新：' + esc(downloadRefreshSummaryLabel(libraryMeta?.automation?.downloadRefresh)) + '</p></section>';
}
function updateHealthDisplay() {
  const node = $('#collection-health');
  if (node) {
    const markup = collectionStatusMarkup();
    if (healthMarkupByNode.get(node) !== markup) {
      const focus = focusSnapshot(node);
      node.innerHTML = markup;
      healthMarkupByNode.set(node, markup);
      restoreFocus(node, focus);
    }
  }
  if (state.view === 'daily') updateReportComparisons();
  const coverage = $('#shared-coverage');
  if (!coverage) return;
  const markup = state.view === 'sources' ? sourceCoverageContent() : sharedCoverageContent();
  if (coverageMarkupByNode.get(coverage) !== markup) {
    coverage.innerHTML = markup;
    coverageMarkupByNode.set(coverage, markup);
  }
}
function sharedSnapshotNote(asOf) {
  const availability = sharedAvailable ? '共享快照' : '最近一次可读的共享快照';
  return `${availability} · ${asOf ? `截至 <time datetime="${esc(asOf)}">${esc(formatReaderTime(asOf))}（北京）</time>` : '保存时间未能核实'}`;
}
function sharedCoverageContent() {
  const { asOf, total, days } = snapshotCoverage(libraryMeta);
  if (total === null) return '<h2>共享快照覆盖</h2><p>尚未读取共享快照，覆盖数量未知。</p>';
  return `<h2>共享快照覆盖</h2><p>${sharedSnapshotNote(asOf)}</p><dl class="reader-update-times">
    <div><dt>去重文献</dt><dd>${total} 篇</dd></div>
    ${days.map(({ date, count }, i) => `<div><dt>${i === 0 ? '今天' : '昨天'} ${date} 首次发现</dt><dd>${count === null ? '未知' : `${count} 篇`}</dd></div>`).join('')}
    </dl><p>首次发现指文献首次进入共享库的日期。统计范围为当前共享快照。</p>`;
}
function directionRows(rows) {
  const labels = { failed: '采集失败', partial: '部分完成', capped: '达到分页上限', complete: '本轮遍历完成', unknown: '采集状态未知' };
  return rows.map(({ topic, hits, received, status, error }) => `<div class="source-card"><div><h3>${esc(topic)}</h3>
    <p>接口命中 ${hits === null ? '未知' : `${hits} 条`}</p><p>本轮取得并去重 ${received === null ? '未知' : `${received} 篇`}</p>
    ${error ? `<p>${esc(error)}</p>` : ''}</div><span class="source-state ${status === 'complete' ? '' : 'off'}">${labels[status]}</span></div>`).join('');
}
function sharedDirectionsContent() {
  const rows = snapshotDirections(libraryMeta?.stats);
  return `<h2>共享快照各方向采集情况</h2>${libraryMeta ? `<p>${sharedSnapshotNote(snapshotCoverage(libraryMeta).asOf)}</p>` : ''}
    ${rows.length ? '<p>各方向可能收录同一篇文献。</p>' + directionRows(rows) : '<p>尚无可用的分方向采集记录。</p>'}`;
}
function localDirectionsContent() {
  if (JSON.stringify(state.stats) === JSON.stringify(libraryMeta?.stats)) return '';
  const rows = snapshotDirections(state.stats);
  return rows.length ? '<section class="settings-panel"><h2>当前会话或缓存的采集诊断</h2>' + directionRows(rows) + '</section>' : '';
}
function sourceCoverageContent() {
  return `<section class="settings-panel">${sharedDirectionsContent()}</section>${localDirectionsContent()}`;
}
function readingStatus() {
  const papers = activePapers();
  const translatedCount = papers.filter(p => readingAvailability(p, translations).bilingual).length;
  const automation = libraryMeta?.automation;
  const modelConfigured = backendStatus?.modelConfigured ?? automation?.modelConfigured;
  const modelMessage = automaticModelPaused() ? '最近一次定时采集已暂停自动模型；文献仍会更新，未译文献保留原文。' : manualCollectionOnly() ? '最近一次手动补采强制禁用模型，新文献暂保留原文；可在配置说明核对模型服务。' : modelConfigured === true ? '本次后台已取得模型配置；配置存在不代表翻译已验收通过，请核对运行记录中的实际请求及结果。' : modelConfigured === false ? '本次后台未启用模型或配置尚不完整，未译文献保留原文，不产生本次模型请求。' : '未取得模型配置状态，可前往监控设置核对。';
  return `<section class="reading-status" aria-label="当前文献库与译文状态"><div class="reading-status-title"><strong>${translatedCount} / ${papers.length} 篇可中英对照阅读</strong><button class="button small" data-filter="translated" ${translatedCount ? '' : 'disabled'}>只看中英对照 ${icon('arrow', 11)}</button></div><p>${modelMessage} 现有译文是辅助翻译，尚未由领域专家审核。</p><dl class="reader-update-times"><div><dt>${state.containsImported ? '个人合并库更新时间' : state.origin === 'sample' ? '样本采集时间' : '当前库更新时间'}</dt><dd>${formatReaderTime(state.updatedAt)}（北京）</dd></div><div><dt>最近后台完成</dt><dd>${automation?.completedAt ? `${formatReaderTime(automation.completedAt)}（北京）` : '尚无完成记录'}</dd></div></dl></section>`;
}
function feedList() {
  const papers = filteredPapers();
  if (!papers.length) {
    const noBookmarks = state.view === 'bookmarks' && !readerBasePapers().length;
    return empty(noBookmarks ? '书架，等着你的第一篇研究' : '没有符合这些条件的文献', noBookmarks ? '点击论文旁的书签，即可留待稍后阅读。' : '当前载入的文献中没有匹配结果。试试放宽日期或类型，或清除筛选条件。', noBookmarks ? '<button class="button small" data-view="overview">浏览全部研究</button>' : '<button class="button small" data-action="reset-filters">清除筛选</button>');
  }
  return `${papers.slice(0, state.page * 8).map(paperCard).join('')}${papers.length > state.page * 8 ? `<button class="load-more" data-action="more">再看 8 篇研究 ${icon('arrow', 12)} <span>(${Math.min(state.page * 8, papers.length)} / ${papers.length})</span></button>` : `<div class="help" style="text-align:center;padding:20px">已展示 ${papers.length} 篇 · 每个发现，都有出处</div>`}`;
}
function sampleNotice() { return state.containsImported ? '<div class="sample-notice">' + icon('info', 12) + ' <strong>含个人导入记录</strong> · 导入来源尚未核验；刷新时保留并与共享文献合并，不代表所有记录均由本次采集取得。</div>' : state.origin === 'sample' ? `<div class="sample-notice">${icon('info', 12)} <strong>原型文献样本</strong> · 采集于 ${shortDate(state.updatedAt?.slice(0, 10))}，不是今日完整监控。点击「更新文献」可检索近期真实记录。</div>` : `<div class="sample-notice">${icon('check', 12)} <strong>Europe PMC 采集缓存</strong> · 采集记录按 DOI / PMID 去重。分类为关键词匹配，研究价值请人工判断。</div>`; }
function topicPanel() {
  const papers = activePapers();
  return `<section class="side-panel"><div class="panel-kicker">RESEARCH LANDSCAPE</div><h2 class="panel-title">研究视野</h2><p class="panel-copy">当前文献库的主题覆盖</p>${TOPICS.map(t => { const n = papers.filter(p => p.topics.includes(t.id)).length; return `<div class="topic-row"><span><i class="dot ${t.color}"></i>${t.name}</span><em>${n} 篇</em></div><div class="track"><i class="${t.color}" style="width:${papers.length ? Math.round(n / papers.length * 100) : 0}%"></i></div>`; }).join('')}<div class="panel-foot">一篇研究可属于多个方向。<br>主题覆盖不代表传播热度或研究质量。</div></section>`;
}
function aside() { const n = activePapers().filter(p => boundPaperIds('selected').has(p.id)).length; return `<aside class="aside" aria-label="研究概览">${topicPanel()}<section class="side-panel daily-panel"><div class="edition">THE DAILY EDITION / 每日一读</div><h2 class="panel-title">将发现，<br>整理成今天的简报。</h2><p class="panel-copy">${n ? `已有 ${n} 篇人工精选。` : '挑选值得读的论文，'}<br>保留原文摘要与出处，随时导出。</p><button class="button small" data-action="generate-report">生成简报 ${icon('arrow', 12)}</button></section><section class="side-panel"><div class="panel-kicker">CONNECTED TO THE SOURCE</div><h2 class="panel-title">信源状态</h2><div class="source-line"><span><i class="status-dot"></i>Europe PMC</span><small>已接入</small></div><div class="source-line planned"><span><i class="status-dot"></i>bioRxiv 直接接口</span><small>待接入</small></div><div class="source-line planned"><span><i class="status-dot"></i>原平台下载量</span><small>按来源可用性</small></div><div class="panel-foot">更新文献后会显示采集结果。<br>已部署云端任务后，关闭网页仍可采集。</div></section></aside>`; }
function overview() { return `${hero()}${metrics()}<div id="paper-link-notice">${paperLinkNotice()}</div><div class="content-grid"><section><div class="section-head"><div class="section-title">最新研究 <span class="en">LATEST RESEARCH</span></div><span class="minor">${readerSortLabel()} · ${filteredPapers().length} 篇</span></div><section id="shared-coverage" class="reading-status shared-coverage">${sharedCoverageContent()}</section>${readingStatus()}${tabs()}${sampleNotice()}${readerTools()}${readerPresetTools()}<div id="feed-list">${feedList()}</div></section>${aside()}</div>`; }
function bookmarksPage() { return `<div class="content-grid"><section><div class="section-head"><div class="section-title">留给稍后的阅读 <span class="en">SAVED PAPERS</span></div><span class="minor">保存在当前浏览器</span></div>${tabs()}${readerTools()}<div id="feed-list">${feedList()}</div></section>${aside()}</div>`; }

function downloadRefreshNote(paper) {
  const label = downloadRefreshLabel(paper);
  return label ? '<p class="help download-refresh">' + esc(label) + '</p>' : '';
}
function downloadDetails(paper) {
  const heading = '<section class="detail-section download-statistics"><h3>' + icon('download', 15) + '原平台文献下载量</h3>' + downloadRefreshNote(paper);
  const metric = paper.downloadMetric;
  if (!validateDownloadMetric(metric)) return heading + '<p class="help">尚无可核对的原出版平台逐篇下载数据，保持未知，不记为0，也不以引用或浏览量替代。</p></section>';
  const partial = !rankableDownloadMetric(metric);
  const warning = partial ? '<p class="evidence-warning">这是部分已知计数，不参与完整累计排行；缺报月份和缺少PDF字段的月份均未视为0。</p>' : '';
  return heading + '<p class="download-detail-count"><strong>' + metric.count.toLocaleString('zh-CN') + '</strong> 次' + (partial ? '（部分计数）' : '') + '</p><p class="help">' + esc(metricLabel(metric)) + '</p><p class="help">' + esc(metricCoverageLabel(metric)) + '</p><p class="help">采集时间：' + esc(metricFetchedAtLabel(metric)) + '</p>' + warning + '<a class="button small" href="' + esc(metric.sourceUrl) + '" target="_blank" rel="noopener noreferrer">核对原平台统计 ↗</a>' + (typeof metric.coverageNote === 'string' && metric.coverageNote ? '<p class="help">' + esc(metric.coverageNote) + '</p>' : '') + '<p class="help">累计量受发表时长和可用记录范围影响，不代表统一近7日下载量或独立读者数。</p></section>';
}
function hotPage() {
  const papers = papersForDownloadRanking(activePapers());
  const available = papers.filter(p => rankableDownloadMetric(p.downloadMetric));
  const knownCount = papers.filter(p => validateDownloadMetric(p.downloadMetric)).length;
  const partialCount = knownCount - available.length, unknownCount = papers.length - knownCount;
  const emptyDownloadTitle = partialCount ? '当前统计不足以完整排行' : '下载量需要真实的逐篇数据';
  const emptyDownloadCopy = partialCount ? '有 ' + partialCount + ' 篇文献返回部分计数；缺报不视为0，未列入完整累计排行。<br>可在论文详情核对，其他缺失保持未知。' : '当前文献尚无可用的原平台下载统计。<br>缺失数据不记为 0，也不参与排名。';
  const groups = [...new Map(available.map(p => [metricGroup(p.downloadMetric), p.downloadMetric])).entries()];
  if (!groups.some(([key]) => key === downloadGroup)) downloadGroup = groups[0]?.[0] || '';
  const ranked = downloadGroup ? rankDownloads(papers, downloadGroup) : [];
  return '<p class="page-intro">统计口径：原出版平台逐篇下载量。已知撤稿记录不进入此排行。不同平台、PDF／文件下载及不同统计窗口分别排名；引用量、浏览量与本站点击不计入。</p>' + (groups.length ? '<div class="report-tools"><label>统计来源与窗口 <select id="download-group" aria-label="下载统计口径">' + groups.map(([key, metric]) => '<option value="' + esc(key) + '" ' + (key === downloadGroup ? 'selected' : '') + '>' + esc(metricLabel(metric)) + '</option>').join('') + '</select></label></div>' : '') + '<div class="content-grid"><section>' + (ranked.length ? ranked.map((p, i) => '<article class="download-row"><div class="download-rank">' + String(i + 1).padStart(2, '0') + '</div><div><button class="paper-title" data-paper="' + esc(p.id) + '">' + paperHeading(p) + '</button><div class="paper-meta">' + esc(p.downloadMetric.platform) + ' · ' + esc(metricLabel(p.downloadMetric)) + '</div><a class="help" href="' + esc(p.downloadMetric.sourceUrl) + '" target="_blank" rel="noopener">统计出处 ↗ · 采集于 ' + esc(metricFetchedAtLabel(p.downloadMetric)) + '</a>' + '<p class="help download-coverage">' + esc(metricCoverageLabel(p.downloadMetric)) + '</p>' + downloadRefreshNote(p) + (typeof p.downloadMetric.coverageNote === 'string' && p.downloadMetric.coverageNote ? '<p class="help">' + esc(p.downloadMetric.coverageNote) + '</p>' : '') + '</div><div class="download-number">' + p.downloadMetric.count.toLocaleString('zh-CN') + '<small>次下载</small></div></article>').join('') : empty(emptyDownloadTitle, emptyDownloadCopy, '<a class="button small" href="./setup.html#downloads" target="_blank" rel="noopener">查看支持的数据接入方式</a>')) + '<div class="sample-notice">当前文献 ' + papers.length + ' 篇，其中 ' + available.length + ' 篇有可排行下载数据，' + partialCount + ' 篇有部分计数，' + unknownCount + ' 篇暂无可核对数据。PLOS 官方 PDF 月计数与 Zenodo 原论文记录支持接口同步；出版社导出可按配置导入。月份缺失的部分统计不参与完整累计排行。数据集或补充材料下载量不会冒充论文下载量。</div></section>' + aside() + '</div>';
}

function topicsPage() { return `<p class="page-intro">暂以三个方向搭建研究视野。主题根据题名和摘要中的关键词匹配，一篇论文可能同时出现在多个方向；分类仍需人工核对。</p><div class="topic-cards">${TOPICS.map((t, i) => `<article class="topic-card"><div class="topic-icon">${icon(['leaf', 'layers', 'globe'][i], 30)}</div><div class="eyebrow">0${i + 1} / RESEARCH FIELD</div><h2>${t.name}</h2><p>${t.en}</p><div class="topic-total">${state.papers.filter(p => p.topics.includes(t.id)).length}<small>篇文献</small></div><button class="button small" data-topic="${t.id}">查看研究 ${icon('arrow', 13)}</button></article>`).join('')}</div><div class="sample-notice" style="margin-top:25px">关注方向可在「监控设置」里启停。更细的基因、菌株、机构等主题，将在后续版本扩展。</div>`; }
function sourcesPage() { return `<section class="settings-panel"><h2>可靠的起点，清晰的出处</h2><p>第一版使用官方学术接口读取题录和摘要。不采集或转载受限论文全文；每条记录都保留原文入口。</p><div class="source-card"><div><h3>Europe PMC</h3><p>已接入官方 REST 接口，按研究方向读取题录与摘要，并对取得的文献去重。</p><p>当前载入：${originLabel()} · ${state.papers.length} 篇；最近载入时间：${state.updatedAt ? esc(new Date(state.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })) : '尚未采集'}。</p><a href="https://europepmc.org/RestfulWebService" target="_blank" rel="noopener noreferrer">查看官方接口说明 ${icon('external', 11)}</a></div><span class="source-state">已接入</span></div><div class="source-card"><div><h3>bioRxiv / medRxiv</h3><p>后续可接入预印本版本、正式发表关联和更详细的状态。当前可能通过 Europe PMC 获取部分预印本记录，尚未直接同步平台的全部数据。</p><a href="https://api.biorxiv.org/" target="_blank" rel="noopener noreferrer">查看官方接口 ${icon('external', 11)}</a></div><span class="source-state off">计划接入</span></div><div class="source-card"><div><h3>原出版平台下载量</h3><p>已接入 PLOS 官方逐篇 PDF 月计数与 Zenodo 原论文记录下载统计；其他出版社可导入有授权的逐篇记录。仅匹配文献自身的原平台数据，缺失保持未知。</p></div><span class="source-state">接口已接入</span></div><div class="settings-buttons"><button class="button dark" data-action="collect" ${state.busy ? 'disabled' : ''}>${icon('refresh', 13)}更新文献</button><button class="button" data-view="settings">设置采集范围</button></div></section><div id="shared-coverage">${sourceCoverageContent()}</div>`; }

function automationPanel() {
  const a = libraryMeta?.automation;
  const configured = backendStatus?.modelConfigured ?? a?.modelConfigured ?? false;
  return '<section class="settings-panel"><h2>后台采集与自动中文解读</h2><p>GitHub 云端任务每天北京时间 07:17 计划执行，平台可能排队延迟。云端运行后，关闭浏览器也会继续采集；本地使用时需保持服务或 worker 运行。</p><div class="automation-grid"><div><span class="help">最近后台运行</span><p>' + (a?.completedAt ? esc(new Date(a.completedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })) : '尚无后台运行记录') + '</p></div><div><span class="help">模型服务</span><p>' + (automaticModelPaused() ? '自动模型已暂停 · 文献采集继续' : manualCollectionOnly() ? '本次手动补采 · 模型已禁用' : configured ? '已提供配置 · 尚需核对验收结果' : '本次未启用或尚待配置') + '</p></div><div><span class="help">中英对照</span><p>' + activePapers().filter(p => readingAvailability(p, translations).bilingual).length + ' / ' + activePapers().length + ' 篇</p></div></div><p class="help">每次最多解读 10 篇、每天最多 20 次模型请求。未变化的原文复用已有译文。请求结果不确定时停止自动重试，避免重复计费。</p><a class="button dark" href="./setup.html" target="_blank" rel="noopener">打开模型与部署配置说明</a></section>';
}

function settingsPage() { return `${automationPanel()}<form id="settings-form"><section class="settings-panel"><h2>你的研究坐标</h2><p>下列为当前浏览器的阅读和手动采集偏好。云端后台按仓库 config/monitor.json 运行；模型配置位于服务器环境或 GitHub Secrets。</p><div class="field"><label>关注研究方向</label>${TOPICS.map(t => `<label class="check-row"><input id="setting-topic-${t.id}" type="checkbox" name="topics" value="${t.id}" ${state.settings.topics.includes(t.id) ? 'checked' : ''}>${t.name}<span class="help">${t.en}</span></label>`).join('')}</div><div class="field"><label for="days">采集发表时间范围</label><select id="days" name="days">${[7, 14, 30, 90].map(d => `<option value="${d}" ${state.settings.days === d ? 'selected' : ''}>最近 ${d} 天</option>`).join('')}</select><p class="help">按论文发表日期检索，每主题最多读取 50 条。切换范围后点击更新文献生效。</p></div><div class="field"><label for="reportDays">简报覆盖范围</label><select id="reportDays" name="reportDays">${[[1, '今天（按北京日期）'], [7, '最近 7 天（适合初期试用）'], [30, '最近 30 天']].map(([d, name]) => `<option value="${d}" ${state.settings.reportDays === d ? 'selected' : ''}>${name}</option>`).join('')}</select><p class="help">仅收录范围内、由你手动精选的文献，按最新发表日期取前 10 篇。未提供精确时间的记录按日期筛选。</p></div><button id="settings-save" class="button dark" type="submit">${icon('check', 14)}保存设置</button></section></form><section class="settings-panel"><h2>数据与运行方式</h2><p>真实接口与本地文献样本可以切换。收藏、精选和简报保存在本机浏览器，不会上传到共享数据库，也不会跨设备同步。</p><div class="settings-buttons"><button class="button" data-action="load-sample">载入文献样本</button><button class="button" data-action="restore-live">恢复最近实时采集</button><button class="button" data-action="export-library">${icon('download', 13)}备份个人数据</button><button class="button" data-action="import-library">导入个人数据</button></div><input type="file" id="backup-file" accept=".json,application/json" hidden><p class="help" style="margin-top:20px">已支持后台定时采集与模型解读流程，需部署并配置密钥后启用。个人收藏仍保存在当前浏览器；完整版本、更正撤稿与自动发送待扩展。</p></section>`; }
const readerTransferGroups = [['readerPresets', '搜索预设'], ['readMarks', '已读标记']];
const readerTransferStale = '其他页面已更改阅读数据。请刷新后重新选择文件并预览。';
function readerTransferPreviewContent() {
  if (!readerTransferPreview) return '';
  const { plan, outcomes } = readerTransferPreview;
  const rows = readerTransferGroups.map(([key, label]) => {
    const { added, repeat, conflict, invalid, overflow } = plan[key].counts;
    const state = outcomes[key]?.status;
    const notice = state === 'protected' ? '本机记录受保护。' : state === 'failed' ? '暂无法读取该组本机存储。' : '';
    return `<p><strong>${label}</strong> · 可新增 ${added} 项，重复 ${repeat} 项，冲突 ${conflict} 项，无效 ${invalid} 项，超出上限 ${overflow} 项。${notice}</p>`;
  }).join('');
  const canSave = readerTransferGroups.some(([key]) => plan[key].counts.added && !outcomes[key]);
  return `<h3 id="reader-transfer-preview-title" tabindex="-1">合并预览</h3>${rows}
    <p>已有数据优先保留。两组分别保存。</p><div class="settings-buttons">
    <button type="button" class="button dark" data-action="confirm-reader-transfer" ${canSave ? '' : 'disabled'}>确认合并</button>
    <button type="button" class="button" data-action="cancel-reader-transfer">取消</button></div>`;
}
function readerTransferPanel() {
  return `<section class="settings-panel" aria-labelledby="reader-transfer-title">
    <h2 id="reader-transfer-title">阅读数据转移</h2><p>此文件含搜索预设及其关键词和已读标记。文件由你保存在本地，可手动转移到其他浏览器。</p>
    <div class="settings-buttons"><button type="button" class="button" data-action="export-reader-transfer">${icon('download', 13)}导出阅读数据</button>
    <button type="button" id="reader-transfer-choose" class="button" data-action="import-reader-transfer">选择阅读数据文件</button></div>
    <input type="file" id="reader-transfer-file" accept=".json,application/json" hidden>
    <div id="reader-transfer-preview">${readerTransferPreviewContent()}</div>
    <p id="reader-transfer-status" role="status" aria-live="polite">${esc(readerTransferMessage)}</p></section>`;
}
function updateReaderTransfer({ focus = null } = {}) {
  const preview = $('#reader-transfer-preview');
  if (!preview) return;
  preview.innerHTML = readerTransferPreviewContent();
  $('#reader-transfer-status').textContent = readerTransferMessage;
  if (focus) document.getElementById(focus)?.focus();
}
async function previewReaderTransfer(file) {
  const request = ++readerTransferRequest;
  readerTransferPreview = null;
  readerTransferMessage = '';
  updateReaderTransfer();
  try {
    const data = await readReaderTransferFile(file);
    if (request !== readerTransferRequest) return;
    const expectedRaw = { readerPresets: readerPresetRaw, readMarks: readMarksRaw };
    const plan = prepareReaderTransfer(data, { readerPresets, readMarks, expectedRaw });
    const checked = checkReaderTransferStorage(browserStorage, expectedRaw, protectedStorageKeys, storageKey);
    if (checked.stale) throw new Error(readerTransferStale);
    readerTransferPreview = { plan, outcomes: checked.outcomes };
    updateReaderTransfer({ focus: 'reader-transfer-preview-title' });
  } catch (error) {
    if (request !== readerTransferRequest) return;
    readerTransferMessage = error.message;
    updateReaderTransfer({ focus: 'reader-transfer-choose' });
  }
}
function finishReaderTransfer(confirm) {
  const { plan } = readerTransferPreview || {};
  if (!plan) return;
  readerTransferPreview = null;
  if (!confirm) readerTransferMessage = '已取消合并。';
  else {
    const { stale, outcomes } = persistReaderTransfer(browserStorage, plan, protectedStorageKeys, storageKey);
    if (outcomes.readerPresets?.status === 'saved') {
      readerPresets = plan.readerPresets.values;
      readerPresetRaw = outcomes.readerPresets.raw;
      readerPresetId ||= readerPresets[0]?.id ?? '';
    }
    if (outcomes.readMarks?.status === 'saved') {
      readMarks = plan.readMarks.values;
      readMarksRaw = outcomes.readMarks.raw;
      readMarksIndex = indexReadMarks(readMarks);
    }
    const statuses = { unchanged: '无新增', protected: '本机记录受保护，未保存', changed: '其他页面已更改，未保存，请刷新后重新预览', failed: '存储不可用，未保存' };
    readerTransferMessage = stale ? readerTransferStale : readerTransferGroups.map(([key, label]) => {
      const status = outcomes[key].status;
      return `${label}${status === 'saved' ? `已保存 ${plan[key].counts.added} 项` : statuses[status]}。`;
    }).join(' ');
  }
  updateReaderTransfer({ focus: 'reader-transfer-choose' });
}
function exportReaderTransfer() {
  let file;
  try { file = createReaderTransferBlob({ readerPresets, readMarks }); }
  catch (error) { toast(error.message); return; }
  download(file, `bioscope-reader-${beijingDay()}.json`);
  toast(readerTransferGroups.some(([key]) => protectedStorageKeys.has(key))
    ? '已请求下载可用的阅读数据。异常原始记录请使用本机数据恢复中的原始副本。'
    : '已请求下载阅读数据文件，请妥善保存。');
}
function reportRequestWarning() {
  if (!state.reportId?.startsWith('public-daily-') || publicReports.some(r => r.id === state.reportId)) return '';
  const message = publicArchive.status === 'ok'
    ? '所请求的公共期次不在当前档案中；当前档案最多保留14天。请从现有简报中选择。'
    : '暂时无法核对所请求的公共期次，不能据此判断该期已过期。请重试读取档案，或先阅读已载入的简报。';
  return '<div class="sample-notice">' + esc(message) + '</div>';
}
function publicArchiveStatusMarkup() {
  const message = publicArchiveNotice(publicArchive);
  return message ? '<div class="report-warning" role="status" aria-live="polite">' + esc(message) + ' <button class="button small" data-action="retry-public-reports">重试读取公共日报</button></div>' : '';
}
function reportRetractionWarning(paper) {
  const signal = knownRetraction(paper, state.papers);
  return signal ? '<div class="report-warning"><strong>已知撤稿相关信号</strong> · 本库已记录此文献的撤稿相关状态。原刊快照保持原样；<a href="' + esc(signal.url) + '" target="_blank" rel="noopener noreferrer">请核对来源 ↗</a>。</div>' : '';
}
function reportCollectionNotice(report) {
  if (report.kind !== 'public_daily') return '';
  const source = report.sourceCollection;
  if (!source) return '<div class="report-warning">本期首刊未记录采集运行来源，不能用当前文献库反推本期采集结果。首刊保留原样。</div>';
  const failed = Array.isArray(source.failedTopics) ? source.failedTopics.filter(topic => typeof topic === 'string').slice(0, 20) : [];
  const status = source.status === 'partial' || failed.length ? '部分方向未更新' + (failed.length ? '：' + failed.join('、') : '') : source.status === 'complete' ? '本次各方向请求已完成（按配置读取上限）' : '本期采集完整性未记录';
  const link = validWorkflowRunUrl(source.runUrl) ? ' · <a href="' + esc(source.runUrl) + '" target="_blank" rel="noopener noreferrer">本期采集运行 ↗</a>' : '';
  return '<div class="report-warning"><strong>本期采集追溯</strong> · ' + esc(status) + '<br>来源：' + esc(collectionSourceLabel(source)) + link + '。首刊保留成刊时的数据，后续补采不重写本期。</div>';
}
function displayedReport() {
  const reports = allReports();
  return reports.find(report => report.id === state.reportId) || reports[0];
}
function sharedRecordIndex() {
  if (!libraryMeta) return null;
  let index = sharedRecordIndexes.get(libraryMeta);
  if (!index) {
    index = indexSharedRecords(libraryMeta.papers);
    sharedRecordIndexes.set(libraryMeta, index);
  }
  return index;
}
function reportComparisons(report) {
  const index = sharedRecordIndex();
  return index ? sharedReportChanges(report, index) : [];
}
function paperLinkNotice() {
  if (!paperLinkStatus) return '';
  const messages = {
    invalid: '这条文献链接的标识格式无效。',
    unavailable: '本次未能读取共享文献库，暂时无法核对这条链接。',
    stale: '本次读取的快照较旧，暂时无法用它核对这条链接。',
    missing: '当前共享快照中没有这条链接对应的记录。共享文献库会滚动更新。',
    ambiguous: '当前共享快照中有多条记录使用此标识，无法确认链接指向。',
    ready: '共享快照已找到这条链接对应的文献。',
  };
  return `<section class="sample-notice" aria-label="共享文献链接"><p>${messages[paperLinkStatus]}</p>${paperLinkStatus === 'ready' ? '<button class="button small" data-action="open-pending-paper">打开共享文献</button>' : ''}<button class="button small" data-action="dismiss-paper-link">关闭提示</button></section>`;
}
function clearPaperLink() {
  pendingPaperRequest = null;
  paperLinkStatus = null;
  history.replaceState(history.state, '', consumePaperLocation(location.href));
}
function refreshPaperLinkNotice() {
  if (!pendingPaperRequest || state.view !== 'overview') return;
  const result = pendingSharedPaper(pendingPaperRequest, sharedRecordIndex(), sharedSnapshotStatus);
  const status = result.status === 'found' ? 'ready' : result.status;
  if (paperLinkStatus === status) return;
  paperLinkStatus = status;
  updatePaperLinkNotice();
}
function updatePaperLinkNotice() {
  const notice = $('#paper-link-notice');
  if (!notice) return;
  const previousFocus = focusSnapshot(notice);
  notice.innerHTML = paperLinkNotice();
  if (previousFocus && !restoreFocus(notice, previousFocus)) $('[data-action="dismiss-paper-link"]', notice)?.focus();
}
function openPendingPaper() {
  if (!pendingPaperRequest || state.view !== 'overview' || $('#paper-dialog').open) return;
  const result = pendingSharedPaper(pendingPaperRequest, sharedRecordIndex(), sharedSnapshotStatus);
  if (result.status !== 'found') { refreshPaperLinkNotice(); return; }
  pendingPaperRequest = null;
  paperLinkStatus = null;
  updatePaperLinkNotice();
  showPaperRecord(result.paper, { readOnly: true });
}
function linkForDialogPaper(paper) {
  if (!sharedAvailable || (state.origin === 'sample' && !state.containsImported)) return null;
  return sharedPaperLocation(paper, sharedRecordIndex(), location.href);
}
function reportComparisonMarkup(fields) {
  if (!fields?.length) return '';
  const labels = { title: '原文题名', abstract: '原文摘要', authors: '作者', publishedAt: '发表日期', version: '来源版本' };
  const { asOf } = snapshotCoverage(libraryMeta);
  return `<p class="report-comparison"><strong>共享记录字段有变化</strong> · ${fields.map(field => labels[field]).join('、')}<br>${sharedSnapshotNote(asOf)}。下方正文使用本期保存的记录。</p>`;
}
function updateReportComparisons() {
  const entries = document.querySelectorAll('[data-shared-comparison]');
  const report = displayedReport();
  if (!report || !entries.length) return;
  const comparisons = reportComparisons(report);
  entries.forEach(entry => {
    const markup = reportComparisonMarkup(comparisons[entry.dataset.sharedComparison]);
    if (entry.innerHTML !== markup) entry.innerHTML = markup;
  });
}
function reportPage() {
  const report = displayedReport();
  const isPublic = report?.kind === 'public_daily';
  if (!report) return `${publicArchiveStatusMarkup()}${reportRequestWarning()}${empty('第一份简报，由你的判断开始', '先在研究雷达中，把值得读的论文加入「精选」。<br>再将符合日期范围的研究，生成一份带原文出处的简报。', '<button class="button dark" data-action="generate-report">'+icon('file', 13)+'生成我的第一份简报</button>')}<div class="report-warning">简报使用你设定的发表日期范围（当前 ${state.settings.reportDays} 天）。它会同时导出已有中英对照及基于摘要的模型解读。缺少译文的记录会明确标注。</div>`;
  const comparisons = reportComparisons(report);
  return `${publicArchiveStatusMarkup()}${reportRequestWarning()}<div class="report-tools"><button class="button dark" data-action="generate-report">${icon('refresh', 13)}生成我的简报</button><button class="button" data-action="export-report" data-report="${report.id}">${icon('download', 13)}导出 Markdown</button><button class="button" data-action="export-report-ris" data-report="${esc(report.id)}" ${report.papers.length ? '' : 'disabled'}>${icon('download', 13)}导出 RIS</button><button class="button" data-action="print-report">${icon('printer', 13)}打印 / PDF</button><a class="button" href="./feed.xml" target="_blank" rel="noopener noreferrer">RSS 订阅</a>${isPublic ? `<button class="button" data-action="copy-report-link" data-report="${report.id}">复制本期链接</button>` : ''}<select id="report-selector" aria-label="切换简报">${allReports().map(r => `<option value="${r.id}" ${r.id === report.id ? 'selected' : ''}>${r.date} · ${r.papers.length} 篇 · ${r.kind === 'public_daily' ? '公共自动日报' : '我的人工精选'}</option>`).join('')}</select></div><article class="report"><div class="report-top"><div class="report-name">${isPublic ? '公共生研日报' : '我的生研日报'}</div><div class="report-number">BIOSCOPE / DAILY BRIEF<br>${shortDate(report.date)} · ${report.papers.length} 篇${isPublic ? '文献' : '精选'}</div></div><div class="eyebrow">RESEARCH WORTH YOUR ATTENTION</div><h2 class="report-lead">今天的阅读，从这些研究开始。</h2><p class="report-desc">覆盖 ${shortDate(report.windowStart)} — ${shortDate(report.date)} 发表的${isPublic ? '自动整理文献' : '人工精选文献'}。<br>数据：${report.origin === 'sample' ? '文献样本或个人导入记录，来源需核对，不代表今日完整监控' : 'Europe PMC 采集缓存'} · 保留原文摘要与链接</p>${isPublic ? `<div class="report-warning"><strong>公共自动日报</strong> · ${esc(report.selectionPolicy?.description || '按规则自动整理，非人工科研价值精选。')}<br>${esc(report.selectionPolicy?.coverageNote || '只覆盖当前文献库。')}</div>` : ''}${report.papers.length ? '' : '<p class="report-desc">本期没有符合日期及主题规则的文献。</p>'}${reportCollectionNotice(report)}${report.papers.map((p, i) => { const reading = readingAvailability(p, translations); return `${isPublic && report.sections?.find(section => section.paperIds[0] === p.id) ? `<h3 class="public-report-section">${esc(report.sections.find(section => section.paperIds[0] === p.id).label)}</h3>` : ''}<section class="report-entry"><div class="eyebrow">${String(i + 1).padStart(2, '0')} / ${p.topics.map(t => topicOf(t).name).join(' · ')}</div><a class="paper-title" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${paperHeading(p, reading)} ${icon('external', 13)}</a>${reportRetractionWarning(p)}<div data-shared-comparison="${i}">${reportComparisonMarkup(comparisons[i])}</div><p class="reading-availability">${reading.label}</p>${paperAbstract(p, reading, true)}${interpretationBlock(p, reading, { report: true })}<div class="paper-meta">${esc(p.journal)} <span class="sep">/</span>${shortDate(p.publishedAt)} <span class="sep">/</span>${esc(p.status)}</div></section>`; }).join('')}<div class="report-warning">阅读范围：仅题录或摘要，未进行全文核验。辅助译文和模型解读需核对原文；期刊记录不等于质量认证。生成时间：${esc(new Date(report.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}。</div></article>`;
}
function footer() { return `<footer class="footer"><div><strong>生研观察 BioScope</strong> &nbsp; · &nbsp; 追踪进展，也保留判断。<br>原型 V${APP_VERSION} · 仅题录与摘要 · 每条研究均链接原始出处</div><div class="footer-right"><a href="./feed.xml" target="_blank" rel="noopener noreferrer">RSS 订阅</a><a href="https://github.com/Jimmy-ui456/bioscope-daily" target="_blank" rel="noopener noreferrer">项目源码 ↗</a><button data-view="sources">信源与边界 ${icon('external', 10)}</button><a href="https://github.com/KKKKhazix/AIHOT" target="_blank" rel="noopener noreferrer">架构参考 AIHOT ${icon('external', 10)}</a></div></footer>`; }
function syncNavigation() {
  applyNavigationState({ narrow: navigationMedia.matches, open: mobileMenuOpen,
    sidebar: $('.sidebar'), shade: $('.mobile-shade'), workspace: $('.workspace'),
    trigger: $('#navigation-toggle'), body: document.body, skipLink: $('.skip-link') });
}
function setMenuOpen(open, { returnFocus = true } = {}) {
  const wasOpen = mobileMenuOpen;
  mobileMenuOpen = navigationMedia.matches && open;
  syncNavigation();
  if (mobileMenuOpen) $('.sidebar-close')?.focus();
  else if (wasOpen && returnFocus) $('#navigation-toggle')?.focus({ preventScroll: true });
}
function render({ keepScroll = true, preserveFocus = true } = {}) {
  pendingReadingRender = false;
  const scroll = window.scrollY;
  const previousFocus = preserveFocus ? focusSnapshot($('#app')) : null;
  const healthMarkup = collectionStatusMarkup();
  $('#app').innerHTML = `${sidebar()}<div class="workspace"><div class="topbar"><div class="breadcrumb"><button id="navigation-toggle" class="icon-button mobile-toggle" data-action="menu" aria-label="打开导航" aria-controls="primary-navigation" aria-expanded="${navigationMedia.matches && mobileMenuOpen}">${icon('menu', 19)}</button><span class="breadcrumb-workspace">我的科研工作台</span><span>/</span><b>${views[state.view].name}</b></div><div class="topbar-actions"><span class="version">PROTOTYPE ${APP_VERSION}</span><button class="button small language-toggle" data-action="toggle-language" aria-pressed="${displayMode === 'bilingual'}">${displayMode === 'bilingual' ? '中英对照' : 'English'}</button><label class="global-search">${icon('search', 14)}<input id="search" type="search" placeholder="论文、关键词、DOI / PMID" aria-label="搜索已载入文献的题名、关键词、DOI或PMID" value="${esc(state.search)}"><span class="keycap">/</span></label><button class="icon-button" data-view="settings" aria-label="监控设置">${icon('settings', 17)}</button></div></div><main class="main" id="main" tabindex="-1">${masthead()}<div id="collection-health" role="status" aria-live="polite" aria-atomic="true">${healthMarkup}</div>${localRecoveryMarkup()}${state.busy ? `<div class="progress-banner" role="status">${icon('refresh', 13, 'spin')} <span id="progress">${esc(state.progress)}</span></div>` : ''}${state.error ? `<div class="error-notice" role="alert">${icon('info', 13)} ${esc(state.error)}</div>` : ''}${({ overview, bookmarks: bookmarksPage, hot: hotPage, topics: topicsPage, sources: sourcesPage, settings: () => settingsPage() + readerTransferPanel(), daily: reportPage }[state.view])()}${footer()}</main></div>`;
  syncNavigation();
  healthMarkupByNode.set($('#collection-health'), healthMarkup);
  const coverage = $('#shared-coverage');
  if (coverage) coverageMarkupByNode.set(coverage, state.view === 'sources' ? sourceCoverageContent() : sharedCoverageContent());
  if (!$('#paper-dialog').open) restoreFocus($('#app'), previousFocus);
  if (keepScroll) window.scrollTo(0, scroll);
  else window.scrollTo(0, 0);
}
function flushReadingRender() {
  if (!pendingReadingRender || state.view === 'settings' || document.hidden || $('#paper-dialog').open) return;
  const active = document.activeElement?.id;
  if ((composingPresetName && active === 'reader-preset-name') || (composingSearch && active === 'search')) return;
  render();
}
function navigate(view, { reset = true } = {}) {
  if (!views[view]) return;
  if (pendingPaperRequest) clearPaperLink();
  if (state.view === 'settings' && view !== 'settings') {
    readerTransferRequest++;
    readerTransferPreview = null;
    readerTransferMessage = '';
  }
  state.view = view; state.page = 1;
  setMenuOpen(false, { returnFocus: false });
  if (reset) { state.topic = 'all'; state.filter = 'all'; state.search = ''; }
  history.replaceState(null, '', `#${view}`);
  render({ keepScroll: false, preserveFocus: false });
  $('#main')?.focus({ preventScroll: true });
}
function updateFeed() {
  if (!['overview', 'bookmarks'].includes(state.view)) {
    navigate('overview', { reset: false });
    const search = $('#search'); search?.focus(); search?.setSelectionRange(search.value.length, search.value.length);
  } else {
    $('#feed-list').innerHTML = feedList();
    const summary = $('#reader-summary'); if (summary) summary.innerHTML = readerSummaryContent();
    const minor = $('.section-head .minor'); if (minor && state.view === 'overview') minor.textContent = `${readerSortLabel()} · ${filteredPapers().length} 篇`;
  }
}
function resetReadingFilters() {
  state.readerFilters = { ...readerDefaults }; state.filtersOpen = false;
  state.filter = 'all'; state.topic = 'all'; state.search = ''; state.page = 1;
  write('readerFilters', state.readerFilters);
}
function saveReaderPresets(presets) {
  if (protectedStorageKeys.has('readerPresets')) {
    toast('请先处理本机数据恢复提示，再保存或删除搜索预设。');
    return false;
  }
  const result = persistReaderPresets(browserStorage, presets, readerPresetRaw, storageKey);
  if (result.status !== 'saved') {
    toast(result.status === 'changed' ? '搜索预设已在其他页面更改，请刷新后再试。' : '浏览器未能保存搜索预设，预设列表未更改。');
    return false;
  }
  readerPresetRaw = result.raw;
  readerPresets = presets;
  return true;
}
function applyReaderPreset() {
  const preset = readerPresets.find(item => item.id === readerPresetId);
  if (!preset) return;
  const { search, topic, filter, readerFilters } = preset;
  Object.assign(state, {
    search, topic, filter, readerFilters: { ...readerFilters }, page: 1,
    filtersOpen: Object.keys(readerDefaults).some(key => readerFilters[key] !== readerDefaults[key]),
  });
  const saved = write('readerFilters', state.readerFilters);
  renderReaderControl('apply-reader-preset');
  if (saved) toast(`已应用预设「${preset.name}」。`);
}
function deleteReaderPreset() {
  const index = readerPresets.findIndex(item => item.id === readerPresetId);
  if (index < 0) return;
  const { name } = readerPresets[index];
  const remaining = readerPresets.filter(item => item.id !== readerPresetId);
  if (!saveReaderPresets(remaining)) return;
  readerPresetId = remaining[index]?.id ?? remaining.at(-1)?.id ?? '';
  renderReaderControl(readerPresetId ? 'reader-preset-select' : 'reader-preset-name');
  toast(`已删除预设「${name}」。`);
}
function renderReaderControl(id) {
  render();
  const control = document.getElementById(id);
  control?.focus({ preventScroll: true });
}
async function collect() {
  if (backendStatus?.pipelineBusy) { toast('后台采集任务正在运行，请等待当前任务结束。'); return; }
  if (state.busy) return;
  state.busy = true; state.error = ''; state.progress = '正在连接 Europe PMC，读取关注方向的近期文献…'; render();
  if (backendStatus?.available) {
    try {
      const response = await fetch('./api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('后台任务未能启动');
      backendStatus = { ...backendStatus, pipelineBusy: true, lastJobError: null, lastJobErrorAt: null };
      state.busy = false; state.progress = ''; toast('后台任务已启动；页面将定期读取更新结果。'); render(); void refreshBackendStatus(); return;
    } catch (error) { state.busy = false; state.error = error.message; render(); return; }
  }
  const topics = TOPICS.filter(t => state.settings.topics.includes(t.id));
  const results = await Promise.allSettled(topics.map(t => collectTopic(t, { days: state.settings.days, onProgress: p => { state.progress = `正在读取 ${p.topic} · 第 ${p.page} 页，已取得 ${p.count} 条`; const progress = $('#progress'); if (progress) progress.textContent = state.progress; } })));
  const { stats, patch, received, retained, incomplete } = manualCollectionOutcome(topics, results, state, new Date().toISOString());
  if (patch) {
    samplePinned = false;
    Object.assign(state, patch);
    cacheActive(); write('liveCache', cacheValue());
    const summary = `本轮取得 ${received} 篇，当前文献库保留其中 ${retained} 篇。`;
    state.error = incomplete.length ? `${incomplete.join('、')}采集不完整。${summary} 可在信源管理查看原因。` : '';
    state.topic = 'all'; state.filter = 'all'; state.page = 1;
    toast(incomplete.length ? `采集部分完成。${summary}` : `${summary}文献库共 ${patch.papers.length} 篇。`);
  } else {
    state.error = '本轮采集失败，已保留当前文献库和更新时间。可在信源管理查看原因。';
    state.stats = stats;
  }
  state.busy = false; state.progress = ''; render();
}
function savePaperReferences(field, references) {
  const result = persistPaperReferences(browserStorage, field, references, paperReferenceRaw[field], {
    protectedKeys: protectedStorageKeys, prefix: storageKey,
  });
  if (result.status === 'saved') {
    paperReferenceRaw[field] = result.raw;
    state[field] = references;
  }
  return result.status;
}
function referenceSaveMessage(field, status) {
  const label = field === 'bookmarks' ? '收藏' : '精选';
  if (status === 'changed') return `${label}已在其他页面更改，本次未保存。请刷新后重试。`;
  if (status === 'protected') return `${label}记录受保护，本次未保存。请先处理本机数据恢复提示。`;
  return `浏览器未能保存${label}，当前页面的${label}未更改。`;
}
function toggleId(field, id) {
  const previousIndex = [...($('#feed-list')?.querySelectorAll('.paper-card .paper-title') || [])].findIndex(button => button.dataset.paper === id);
  const references = togglePaperReference(state[field], id, paperReferenceLookup());
  if (references === state[field]) return;
  const status = savePaperReferences(field, references);
  if (status !== 'saved') { toast(referenceSaveMessage(field, status)); return; }
  render();
  if ($('#paper-dialog').open) showPaper(id, true);
  else if (document.activeElement === document.body && !focusNewResults($('#feed-list'), Math.max(0, previousIndex))) $('#main')?.focus({ preventScroll: true });
}
function toggleRead(mark) {
  if (protectedStorageKeys.has('readMarks')) { toast('请先处理本机数据恢复提示，再更改已读标记。'); return; }
  const matches = matchingReadMarks(readMarksIndex, mark);
  if (!matches.size && readMarks.length >= READ_MARK_LIMIT) {
    toast(`已达 ${READ_MARK_LIMIT} 条已读标记上限，请先取消一条已有标记。`);
    return;
  }
  const updated = matches.size ? readMarks.filter(item => !matches.has(item)) : [...readMarks, mark];
  const result = persistReadMarks(browserStorage, updated, readMarksRaw, storageKey);
  if (result.status !== 'saved') {
    toast(result.status === 'changed' ? '已读标记已在其他页面更改，请刷新后再试。' : '浏览器未能保存，已读标记未更改。');
    return;
  }
  readMarks = updated;
  readMarksRaw = result.raw;
  readMarksIndex = indexReadMarks(readMarks);
  const previousIndex = [...($('#feed-list')?.querySelectorAll('.paper-card .paper-title') || [])].findIndex(button => button.dataset.paper === mark.id);
  render();
  if ($('#paper-dialog').open) { dialogReadChangeIndex ??= previousIndex; showPaper(dialogPaperId, true); }
  else if (document.activeElement === document.body) focusAfterReadChange(previousIndex);
  toast(matches.size ? '已取消已读标记。' : '已标为已读。');
}
function focusAfterReadChange(previousIndex) {
  if (!focusNewResults($('#feed-list'), Math.max(0, previousIndex))) {
    const progress = $('#reading-filters[open] #reader-progress');
    (progress || $('#reading-filters-summary') || $('#main'))?.focus({ preventScroll: true });
  }
}
function showPaper(id, alreadyOpen = false) {
  const p = alreadyOpen && dialogPaper?.id === id ? dialogPaper : state.papers.find(p => p.id === id);
  if (!p) return;
  showPaperRecord(p, { alreadyOpen });
}
function paperDialogActions(paper, readOnly) {
  const original = `<a class="button dark" href="${esc(paper.url)}" target="_blank" rel="noopener noreferrer">阅读原文 ${icon('external', 13)}</a>`;
  if (readOnly) return original;
  const selected = boundPaperIds('selected').has(paper.id);
  const bookmarked = boundPaperIds('bookmarks').has(paper.id);
  return `${readMarkButton(paper, true)}${original}
    <button class="button" data-select="${esc(paper.id)}" ${isRetracted(paper) ? 'disabled' : ''} aria-pressed="${selected}">${icon('check', 13)}${selected ? '取消精选' : '加入人工精选'}</button>
    <button class="button" data-bookmark="${esc(paper.id)}" aria-pressed="${bookmarked}">${icon('bookmark', 13)}${bookmarked ? '已收藏 · 点击取消' : '收藏研究'}</button>
    <button class="button" data-action="copy-citation" data-paper-id="${esc(paper.id)}">复制引用信息</button>
    ${linkForDialogPaper(paper) ? '<button class="button" data-action="copy-shared-paper">复制站内链接</button>' : ''}`;
}
function showPaperRecord(p, { alreadyOpen = false, readOnly = false } = {}) {
  const dialog = $('#paper-dialog');
  const previousFocus = alreadyOpen ? focusSnapshot(dialog) : null;
  const previousScroll = dialog.scrollTop;
  if (!alreadyOpen) {
    dialogReturnFocus = focusSnapshot($('#app')); dialogPaperId = p.id; dialogPaper = p; dialogReadChangeIndex = null;
    dialogReadOnly = readOnly;
  }
  const reading = readingAvailability(p, translations);
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-header"><div class="tags">${p.topics.map(topicTag).join('')}<span class="tag ${p.isPreprint || isRetracted(p) ? 'warn' : 'outline'}">${esc(isRetracted(p) ? '撤稿相关' : p.type)}</span></div><button class="icon-button" data-action="close-dialog" aria-label="关闭论文详情">${icon('close', 20)}</button></div><h2 class="dialog-title" id="dialog-title">${paperHeading(p, reading)}</h2>${dialogReadOnly ? '<p class="help">共享文献 · 只读</p>' : ''}<div class="dialog-authors">${esc(p.authors)}</div><dl class="detail-meta"><div><dt>期刊 / 平台</dt><dd>${esc(p.journal)}</dd></div><div><dt>发表日期</dt><dd>${shortDate(p.publishedAt)}</dd></div><div><dt>DOI / 论文标识</dt><dd>${esc(p.doi || '接口未提供 DOI')}${p.pmid ? `<br>PMID ${esc(p.pmid)}` : ''}</dd></div><div><dt>文献状态 / 阅读范围</dt><dd>${esc(p.status)}<br>${reading.label} · 未读取全文</dd></div></dl>${downloadDetails(p)}${reading.hasAbstract ? `<section class="detail-section"><h3>${icon('book', 15)}摘要</h3>${paperAbstract(p, reading)}${interpretationBlock(p, reading)}</section>` : paperAbstract(p, reading)}<div class="detail-tip">${isRetracted(p) ? '此记录带有撤稿相关类型，不会进入简报。请核对原文及撤稿通知。' : p.isPreprint ? '预印本未经同行评审，结论可能随版本更新。当前尚未自动核验版本及正式发表关系。' : '期刊记录标签来自接口元数据，不代表已核实评审或研究质量。当前未自动核验更正、撤稿、数据与代码。'} 中文解读仅基于摘要，不替代全文核验。</div><div class="dialog-actions">${paperDialogActions(p, dialogReadOnly)}</div><div id="dialog-status" class="dialog-status" role="status" aria-live="polite" aria-atomic="true"></div><div class="detail-source">${icon('globe', 12)}来源：Europe PMC · 本库首次发现 ${shortDate(discoveryDay(p))}（北京）<br>原型未将原文发表日、数据库收录日与平台版本更新日全部关联。</div></div>`;
  if (!alreadyOpen) dialog.showModal();
  else { restoreFocus(dialog, previousFocus); dialog.scrollTop = previousScroll; }
}
function generateReport() {
  const papers = chooseReportPapers(activePapers(), [...boundPaperIds('selected')], { days: state.settings.reportDays });
  if (!papers.length) { toast(`请先精选最近 ${state.settings.reportDays} 天发表的研究；也可在监控设置中调整范围。`); return; }
  const now = new Date().toISOString();
  const report = { id: `brief-${Date.now()}`, date: beijingDay(), windowStart: dayBefore(state.settings.reportDays - 1), createdAt: now, origin: state.origin, papers: structuredClone(papers.map(p => attachEnrichment(p, translations))) };
  state.reports = [report, ...state.reports].slice(0, 14); state.reportId = report.id;
  const saved = write('reports', state.reports);
  navigate('daily'); toast(saved ? `已生成并保存 ${papers.length} 篇人工精选简报，保留原文摘要与出处。` : '简报已在当前页面生成，但尚未保存；请导出简报或个人备份，并处理本机保存提示。');
}
function download(content, name, type) { const link = document.createElement('a'); const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type })); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function loadSample() {
  if (!sample) { toast('文献样本尚未载入，请刷新页面。'); return; }
  if (state.busy) return;
  if ((state.origin === 'live' || state.containsImported) && !write('liveCache', cacheValue())) {
    toast('切换前未能保存当前文献库；请先导出备份，当前内容已保留。'); return;
  }
  samplePinned = true;
  Object.assign(state, { papers: structuredClone(sample.papers), origin: 'sample', containsImported: false, updatedAt: sample.fetchedAt, stats: [], error: '' });
  cacheActive(); navigate('overview'); toast('已切换到真实文献样本；收藏和简报已保留。');
}
function restoreLive() {
  const live = read('liveCache', null);
  const recovered = readLocalReaderState({ getItem: key => key === storageKey + 'cache' ? JSON.stringify(live) : null }, storageKey);
  const safe = recovered.cache;
  if (!safe || recovered.protectedKeys.includes('cache') || !(safe.origin === 'live' || safe.containsImported === true)) {
    toast('未找到可恢复的文献库；当前内容已保留，请核对原备份。'); return;
  }
  samplePinned = false;
  Object.assign(state, { papers: sharedLibraryPapers(safe, []), origin: safe.containsImported === true ? 'sample' : 'live', containsImported: safe.containsImported === true, updatedAt: safe.updatedAt, stats: safe.stats, error: '' });
  cacheActive(); navigate('overview'); toast('已恢复最近一次本地保存的文献库。');
}

document.addEventListener('click', async event => {
  const target = event.target.closest('button,a');
  if (!target) { if (event.target.classList.contains('mobile-shade')) setMenuOpen(false); return; }
  if (target.dataset.view) {
    if (target.tagName === 'A' && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0)) return;
    event.preventDefault(); navigate(target.dataset.view); return;
  }
  if (target.dataset.topic) { state.topic = target.dataset.topic; state.filter = 'all'; state.search = ''; navigate('overview', { reset: false }); return; }
  if (target.dataset.filter) {
    state.filter = target.dataset.filter; state.page = 1;
    if (['research', 'preprint'].includes(state.filter)) { state.readerFilters.kind = 'all'; write('readerFilters', state.readerFilters); }
    render(); $('.tabs .tab.active')?.focus({ preventScroll: true }); return;
  }
  if (target.dataset.paper) { showPaper(target.dataset.paper); return; }
  if (target.dataset.select) { const paper = state.papers.find(p => p.id === target.dataset.select); if (isRetracted(paper)) { toast('撤稿相关记录不进入人工精选。'); return; } toggleId('selected', target.dataset.select); return; }
  if (target.dataset.bookmark) { toggleId('bookmarks', target.dataset.bookmark); return; }
  switch (target.dataset.action) {
    case 'collect': await collect(); break;
    case 'toggle-language': displayMode = displayMode === 'bilingual' ? 'en' : 'bilingual'; write('displayMode', displayMode); render(); break;
    case 'generate-report': generateReport(); break;
    case 'export-local-recovery': {
      download(JSON.stringify({ app: 'bioscope-raw-recovery', version: 1, exportedAt: new Date().toISOString(), note: '原始本机恢复副本，保留原始字符串供核对；不是常规可直接导入的个人备份。', records: localState.rawRecords }, null, 2), `bioscope-原始恢复副本-${beijingDay()}.json`, 'application/json');
      toast('已请求导出原始副本，请确认下载完成后妥善保存。'); break;
    }
    case 'resume-local-storage': {
      const values = { settings: state.settings, cache: cacheValue(), readerFilters: state.readerFilters, readerPresets, readMarks, bookmarks: state.bookmarks, selected: state.selected, reports: state.reports, displayMode };
      const result = persistLocalRecovery(browserStorage, values, { protectedKeys: [...protectedStorageKeys], rawRecords: localState.rawRecords, prefix: storageKey });
      result.saved.forEach(key => {
        protectedStorageKeys.delete(key);
        if (Object.hasOwn(paperReferenceRaw, key)) paperReferenceRaw[key] = JSON.stringify(values[key]);
      });
      if (result.saved.includes('readerPresets')) readerPresetRaw = JSON.stringify(readerPresets);
      if (result.saved.includes('readMarks')) readMarksRaw = JSON.stringify(readMarks);
      localRecoveryMessage = [result.changed.length ? '部分本机记录已在其他页面变化，为避免覆盖，请刷新后重新核对。' : '', result.failed.length ? '部分恢复内容未能保存，原记录继续保护；请保留原始副本并检查浏览器存储权限或空间。' : ''].filter(Boolean).join(' ');
      render(); toast(localRecoveryMessage || '已按你的选择保存恢复内容，相关本机记录可继续正常保存。'); break;
    }
    case 'retry-public-reports': {
      if (publicArchiveBusy) break;
      await refreshPublicArchive();
      if (state.view === 'daily' && !$('#paper-dialog').open) render();
      toast(publicArchive.status === 'ok' ? '公共日报档案已重新读取。' : publicArchiveNotice(publicArchive));
      break;
    }
    case 'more': { const previousCount = $('#feed-list').querySelectorAll('.paper-card').length; state.page++; updateFeed(); focusNewResults($('#feed-list'), previousCount); break; }
    case 'toggle-read': toggleRead(JSON.parse(target.dataset.readMark)); break;
    case 'reset-filters': resetReadingFilters(); render(); $('#search')?.focus({ preventScroll: true }); break;
    case 'apply-reader-preset': applyReaderPreset(); break;
    case 'delete-reader-preset': deleteReaderPreset(); break;
    case 'menu': setMenuOpen(true); break;
    case 'close-menu': setMenuOpen(false); break;
    case 'close-dialog': $('#paper-dialog').close(); break;
    case 'export-report': { const report = allReports().find(r => r.id === target.dataset.report); if (report) { download(reportMarkdown(report, translations, state.papers), `生研日报-${report.date}.md`, 'text/markdown;charset=utf-8'); toast('已导出 Markdown 简报。'); } break; }
    case 'export-report-ris': {
      const report = allReports().find(r => r.id === target.dataset.report);
      if (!report?.papers.length) break;
      download(reportRis(report), `BioScope-${report.kind === 'public_daily' ? 'public' : 'personal'}-${report.date}.ris`, 'application/x-research-info-systems;charset=utf-8');
      toast('已导出本期 RIS 引文。');
      break;
    }
    case 'print-report': window.print(); break;
    case 'copy-report-link': {
      const href = sharedReportLocation(target.dataset.report, location.href);
      if (!href) { toast('无法生成本期公共日报链接。'); break; }
      try { await navigator.clipboard.writeText(href); toast('本期公共日报链接已复制。'); }
      catch { toast('浏览器未允许使用剪贴板，链接未复制。'); }
      break;
    }
    case 'load-sample': await loadSample(); break;
    case 'restore-live': restoreLive(); break;
    case 'export-library': download(JSON.stringify({ app: 'bioscope', version: 1, exportedAt: new Date().toISOString(), papers: state.papers, origin: state.origin, updatedAt: state.updatedAt, selected: state.selected, bookmarks: state.bookmarks, reports: state.reports, settings: state.settings }, null, 2), `bioscope-backup-${beijingDay()}.json`, 'application/json'); toast('已导出文献库、收藏、精选和简报。'); break;
    case 'import-library': $('#backup-file').click(); break;
    case 'export-reader-transfer': exportReaderTransfer(); break;
    case 'import-reader-transfer': $('#reader-transfer-file').click(); break;
    case 'confirm-reader-transfer': finishReaderTransfer(true); break;
    case 'cancel-reader-transfer': finishReaderTransfer(false); break;
    case 'copy-citation': { const p = state.papers.find(p => p.id === target.dataset.paperId); if (!p) break; const citation = `${p.authors}. ${p.title}. ${p.journal}. ${p.publishedAt || ''}. ${p.url}`; try { await navigator.clipboard.writeText(citation); toast('引用信息已复制，请按投稿规范核对格式。'); } catch { toast('浏览器未允许剪贴板，请使用原文页面的引用功能。'); } break; }
    case 'copy-shared-paper': {
      const link = !dialogReadOnly && linkForDialogPaper(dialogPaper);
      if (!link) { toast('当前详情无法与共享快照唯一匹配，链接未复制。'); break; }
      try { await navigator.clipboard.writeText(link); toast('站内文献链接已复制。'); }
      catch { toast('浏览器未允许剪贴板，链接未复制。'); }
      break;
    }
    case 'dismiss-paper-link': clearPaperLink(); render(); $('#main')?.focus({ preventScroll: true }); break;
    case 'open-pending-paper': openPendingPaper(); break;
  }
});
const searchInput = createSearchInputController(value => { state.search = value; state.page = 1; updateFeed(); });
document.addEventListener('submit', event => {
  if (event.target.id !== 'reader-preset-form') return;
  event.preventDefault();
  const name = $('#reader-preset-name').value.trim();
  if (!name) { toast('请输入预设名称。'); return; }
  if (readerPresets.some(item => item.name === name)) { toast('已有同名预设，请使用其他名称。'); return; }
  if (readerPresets.length >= READER_PRESET_LIMITS.count) { toast(`最多可保存 ${READER_PRESET_LIMITS.count} 个搜索预设，请先删除一个再试。`); return; }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const preset = readerPresetSnapshot({ ...state, id, name });
  if (!preset) { toast('当前搜索或期刊名称超出可保存范围，请调整筛选后再试。'); return; }
  if (!saveReaderPresets([...readerPresets, preset])) return;
  readerPresetName = '';
  readerPresetId = preset.id;
  renderReaderControl('reader-preset-select');
  toast(`已保存预设「${name}」。`);
});
document.addEventListener('input', event => {
  if (event.target.id === 'reader-preset-name') readerPresetName = event.target.value;
});
document.addEventListener('compositionstart', event => {
  if (event.target.id === 'reader-preset-name') composingPresetName = true;
});
document.addEventListener('compositionend', event => {
  if (event.target.id !== 'reader-preset-name') return;
  composingPresetName = false;
  readerPresetName = event.target.value;
  if (pendingReadingRender) setTimeout(flushReadingRender, 0);
});
for (const type of ['input', 'compositionstart', 'compositionend']) {
  document.addEventListener(type, event => {
    if (event.target.id !== 'search') return;
    if (type === 'compositionstart' || event.isComposing) composingSearch = true;
    if (type === 'compositionend') composingSearch = false;
    searchInput(event);
    if (type === 'compositionend' && pendingReadingRender) setTimeout(flushReadingRender, 0);
  });
}
document.addEventListener('change', async event => {
  if (event.target.id === 'reader-transfer-file') {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) await previewReaderTransfer(file);
    return;
  }
  if (event.target.id === 'reader-preset-select') { readerPresetId = event.target.value; return; }
  const readerField = { 'reader-journal': 'journal', 'reader-days': 'days', 'reader-kind': 'kind', 'reader-abstract': 'abstract', 'reader-date-basis': 'dateBasis', 'reader-progress': 'progress' }[event.target.id];
  if (readerField) {
    state.readerFilters[readerField] = readerField === 'days' ? Number(event.target.value) : event.target.value;
    if (readerField === 'kind' && ['research', 'preprint'].includes(state.filter)) state.filter = 'all';
    state.page = 1;
    if (readerField !== 'dateBasis') state.filtersOpen = true;
    write('readerFilters', state.readerFilters); renderReaderControl(event.target.id); return;
  }
  if (event.target.id === 'download-group') { downloadGroup = event.target.value; render(); }
  if (event.target.id === 'topic-filter') { state.topic = event.target.value; state.page = 1; renderReaderControl('topic-filter'); }
  if (event.target.id === 'report-selector') { state.reportId = event.target.value; history.replaceState(null, '', reportLocation(state.reportId, location.href)); render(); }
  if (event.target.id === 'backup-file' && event.target.files[0]) {
    try {
      const file = event.target.files[0];
      if (file.size > 5 * 1024 * 1024) throw new Error('文件超过 5 MB 上限');
      const data = JSON.parse(await file.text());
      const prepared = prepareBackupImport(state, data);
      const { selected, bookmarks, ...patch } = prepared.patch;
      samplePinned = false;
      Object.assign(state, patch);
      const saved = [cacheActive(), write('reports', state.reports), write('settings', state.settings)].every(Boolean);
      const referenceFailures = [['selected', selected], ['bookmarks', bookmarks]].flatMap(([field, references]) => {
        const status = savePaperReferences(field, references);
        return status === 'saved' ? [] : [referenceSaveMessage(field, status)];
      });
      navigate('overview');
      const result = saved && !referenceFailures.length ? '个人数据已合并，按文献样本标记，请核对出处。' : '个人数据未能完整保存，请保留原备份。';
      toast([result, ...referenceFailures, prepared.skippedReports ? `跳过 ${prepared.skippedReports} 条日期或字段无效的日报。` : ''].filter(Boolean).join(' '));
    } catch (error) { toast(`导入失败：${error.message}`); }
  }
});
document.addEventListener('toggle', event => { if (event.target.id === 'reading-filters') state.filtersOpen = event.target.open; }, true);
document.addEventListener('submit', event => {
  if (event.target.id !== 'settings-form') return;
  event.preventDefault();
  const form = new FormData(event.target); const topics = form.getAll('topics');
  if (!topics.length) { toast('请至少选择一个关注方向。'); return; }
  state.settings = { topics, days: Number(form.get('days')), reportDays: Number(form.get('reportDays')) };
  const saved = write('settings', state.settings);
  toast(saved ? '监控设置已保存，下次采集使用新的范围。' : '设置已更新到当前页面，但尚未保存；请处理本机数据恢复提示或检查浏览器存储。'); render();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && readerTransferPreview && event.target.closest('#reader-transfer-preview')) {
    event.preventDefault(); finishReaderTransfer(false); return;
  }
  if (mobileMenuOpen && navigationMedia.matches && !$('#paper-dialog').open) {
    if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); return; }
    if (trapFocus(event, $('.sidebar'))) return;
  }
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('#paper-dialog').open) {
    event.preventDefault(); setMenuOpen(false, { returnFocus: false }); $('#search')?.focus();
  }
});
navigationMedia.addEventListener('change', () => {
  const focusWasInSidebar = $('.sidebar')?.contains(document.activeElement);
  const focusWasClose = document.activeElement?.classList.contains('sidebar-close');
  mobileMenuOpen = false; syncNavigation();
  if (navigationMedia.matches && focusWasInSidebar) $('#navigation-toggle')?.focus({ preventScroll: true });
  else if (!navigationMedia.matches && focusWasClose) $('.sidebar .nav-link.active')?.focus({ preventScroll: true });
});
$('#paper-dialog').addEventListener('close', () => {
  if ($('#paper-dialog').open) return;
  const status = $('#dialog-status'); if (status) status.textContent = '';
  flushReadingRender();
  if (dialogReadOnly) {
    clearPaperLink();
    $('#main')?.focus({ preventScroll: true });
  } else if (!restoreFocus($('#app'), dialogReturnFocus)) {
    const opener = [...document.querySelectorAll('.paper-title[data-paper]')].find(button => button.dataset.paper === dialogPaperId);
    if (!opener && dialogReadChangeIndex !== null) focusAfterReadChange(dialogReadChangeIndex);
    else (opener || $('#main'))?.focus({ preventScroll: true });
  }
  dialogReturnFocus = null; dialogPaperId = null; dialogPaper = null; dialogReadChangeIndex = null; dialogReadOnly = false;
});
$('#paper-dialog').addEventListener('click', event => { if (event.target === $('#paper-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
window.addEventListener('hashchange', () => { const view = location.hash.slice(1); if (views[view]) navigate(view); });


async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try { const response = await fetch(url, { cache: 'no-store', signal: controller.signal }); return response.ok ? await response.json() : null; }
  catch { return null; }
  finally { clearTimeout(timer); }
}
function acceptPublicArchive(data) {
  const prepared = preparePublicArchive(data, publicArchive);
  const changed = JSON.stringify(prepared) !== JSON.stringify(publicArchive);
  publicArchive = prepared; publicReports = prepared.reports;
  return changed;
}
async function refreshPublicArchive() {
  if (publicArchiveBusy) return false;
  publicArchiveBusy = true;
  try { return acceptPublicArchive(await fetchJson('./public-reports.json')); }
  finally { publicArchiveBusy = false; }
}
const [sampleData, translationData, sharedData, statusData, publicData] = await Promise.all([fetchJson('./sample.json'), fetchJson('./translations.json'), fetchJson('./library.json'), fetchJson('./api/status'), fetchJson('./public-reports.json')]);
acceptPublicArchive(publicData);
sample = sampleData;
translations = translationData?.items || {};
const initialRefresh = planSharedRefresh(null, sharedData, cacheValue(), false);
sharedSnapshotStatus = initialRefresh.status;
libraryMeta = initialRefresh.library;
sharedAvailable = initialRefresh.status === 'updated';
backendStatus = statusData?.available === true ? statusData : null;
if (initialRefresh.patch) Object.assign(state, initialRefresh.patch);
else if (!cache && sample) { state.papers = sample.papers; state.updatedAt = sample.fetchedAt; }
else if (!cache && !sample) state.error = INITIAL_LIBRARY_ERROR;
const initialNavigation = incomingPaperNavigation(location.href);
state.reportId = initialNavigation.reportId;
const linkedPaper = initialNavigation.paper ? resolveSharedPaper(initialNavigation.paper, sharedRecordIndex()) : null;
if (linkedPaper && linkedPaper.status !== 'found') {
  pendingPaperRequest = initialNavigation.paper;
  paperLinkStatus = linkedPaper.status;
}
state.view = state.reportId ? 'daily' : linkedPaper ? 'overview' : (views[location.hash.slice(1)] ? location.hash.slice(1) : 'overview');
render({ keepScroll: false });
if (linkedPaper?.status === 'found') showPaperRecord(linkedPaper.paper, { readOnly: true });
async function refreshBackendStatus() {
  if (!backendStatus?.available || runtimeRefreshBusy || document.hidden) return;
  runtimeRefreshBusy = true;
  try {
    const status = await fetchJson('./api/status');
    backendStatus = status?.available === true ? status : { ...backendStatus, pipelineBusy: null, statusWarning: '本次未能读取本地状态接口，当前任务结果暂未核实；已保存数据保留。' };
    updateHealthDisplay();
  } finally { runtimeRefreshBusy = false; }
}
setInterval(refreshBackendStatus, 15000);
async function refreshSharedData() {
  if (sharedRefreshBusy || document.hidden || $('#paper-dialog').open) return;
  sharedRefreshBusy = true;
  try {
    const latest = await fetchJson('./library.json');
    if (document.hidden || $('#paper-dialog').open) return;
    const next = planSharedRefresh(libraryMeta, latest, cacheValue(), samplePinned);
    libraryMeta = next.library;
    sharedSnapshotStatus = next.status;
    sharedAvailable = next.status === 'same' || next.status === 'updated';
    refreshPaperLinkNotice();
    if (next.patch) {
      Object.assign(state, next.patch);
      if (state.error === INITIAL_LIBRARY_ERROR) state.error = '';
      cacheActive();
      pendingReadingRender = true;
      flushReadingRender();
      toast('后台文献库已更新。');
    }
    // Retry archive reads independently of the shared library.
    if ((next.status === 'updated' || publicArchive.status !== 'ok') && await refreshPublicArchive()) pendingReadingRender = true;
    flushReadingRender();
    updateHealthDisplay();
  } finally { sharedRefreshBusy = false; }
}
setInterval(refreshSharedData, 60000);

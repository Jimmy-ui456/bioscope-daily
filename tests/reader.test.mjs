import test from 'node:test';
import assert from 'node:assert/strict';
import { filterReadingPapers, readingBasePapers, createSearchInputController } from '../dist/reader.js';
const now = new Date('2026-10-28T17:00:00Z');
const filters = { journal: 'all', kind: 'all', days: 0, abstract: 'all' };
const papers = [
  { id: 'today', publishedAt: '2026-10-29', journal: 'A', abstract: 'text', type: '综述' },
  { id: 'boundary', publishedAt: '2026-10-23', journal: 'A', abstract: '', type: '期刊论文' },
  { id: 'old', publishedAt: '2026-10-22', journal: 'B', abstract: 'text', type: '期刊论文' },
  { id: 'future', publishedAt: '2026-10-30', journal: 'A', abstract: 'text', isPreprint: true },
  { id: 'unknown', publishedAt: null, journal: 'B', abstract: '  ', type: '文献记录' },
];
test('阅读日期过滤遵循北京日历边界，排除未知和未来日期', () => {
  assert.deepEqual(filterReadingPapers(papers, { ...filters, days: 1 }, now).map(p => p.id), ['today']);
  assert.deepEqual(filterReadingPapers(papers, { ...filters, days: 7 }, now).map(p => p.id), ['today', 'boundary']);
});
test('期刊、类型与摘要可用性可同时筛选，空白摘要视为缺失', () => {
  assert.deepEqual(filterReadingPapers(papers, { ...filters, journal: 'A', kind: 'review', abstract: 'available' }, now).map(p => p.id), ['today']);
  assert.deepEqual(filterReadingPapers(papers, { ...filters, abstract: 'missing' }, now).map(p => p.id), ['boundary', 'unknown']);
});

test('收藏从完整库读取，取消关注方向不隐藏已收藏论文，研究雷达仍遵循关注方向', () => {
  const records = [
    { ...papers[0], id: 'unfollowed-saved', topics: ['synthetic'] },
    { ...papers[1], id: 'followed-saved', topics: ['metabolic'] },
    { ...papers[2], id: 'followed-unsaved', topics: ['microbial'] },
  ];
  const options = { topics: ['metabolic', 'microbial'], bookmarks: ['unfollowed-saved', 'followed-saved'] };
  const before = structuredClone({ records, options });
  const saved = readingBasePapers(records, { ...options, view: 'bookmarks' });
  assert.deepEqual(saved.map(p => p.id), ['unfollowed-saved', 'followed-saved']);
  assert.deepEqual(readingBasePapers(records, { ...options, view: 'overview' }).map(p => p.id), ['followed-saved', 'followed-unsaved']);
  assert.deepEqual(filterReadingPapers(saved, { ...filters, journal: 'A', kind: 'review', abstract: 'available' }, now).map(p => p.id), ['unfollowed-saved']);
  assert.deepEqual({ records, options }, before);
});

function searchEvents(apply) {
  const target = { id: 'search', value: '' };
  const handle = createSearchInputController(apply);
  return (type, value, isComposing = false) => { target.value = value; return handle({ type, target, isComposing }); };
}

test('组合输入的多个input不刷新或导航，compositionend提交后尾随input不重复提交', () => {
  const applied = [], event = searchEvents(value => applied.push(value));
  event('compositionstart', '');
  event('input', 'h', true); event('input', 'han', true);
  assert.deepEqual(applied, []);
  event('compositionend', '汉');
  event('input', '汉');
  assert.deepEqual(applied, ['汉']);
  event('input', '汉a');
  assert.deepEqual(applied, ['汉', '汉a']);
});

test('浏览器在compositionend之前派发isComposing=false的最终input也不会提前删除输入框', () => {
  const applied = [], event = searchEvents(value => applied.push(value));
  event('compositionstart', '');
  event('input', 'yeast');
  assert.deepEqual(applied, []);
  event('compositionend', '酵母');
  event('input', '酵母');
  assert.deepEqual(applied, ['酵母']);
  event('compositionstart', '酵母'); event('input', '酵母dai', true); event('compositionend', '酵母代谢');
  assert.deepEqual(applied, ['酵母', '酵母代谢']);
});

test('取消组合输入后文本未变不触发导航，之后普通输入仍正常提交', () => {
  const applied = [], event = searchEvents(value => applied.push(value));
  event('compositionstart', '旧词'); event('input', '旧词han', true);
  event('compositionend', '旧词'); event('input', '旧词');
  assert.deepEqual(applied, []);
  event('input', '旧词a');
  assert.deepEqual(applied, ['旧词a']);
});

test('收到isComposing输入但缺少compositionstart时仍等到确认才应用搜索', () => {
  const applied = [], event = searchEvents(value => applied.push(value));
  event('input', 'han', true);
  assert.deepEqual(applied, []);
  event('compositionend', '汉'); event('input', '汉');
  assert.deepEqual(applied, ['汉']);
});

test('清除筛选后可以再次输入同一个词，不会被历史搜索值误判为重复', () => {
  let current = '', navigations = 0;
  const event = searchEvents(value => { current = value; navigations++; });
  event('input', 'yeast');
  current = ''; // A separate clear-filters action changes state without an input event.
  event('input', 'yeast');
  assert.equal(current, 'yeast');
  assert.equal(navigations, 2);
});

test('组合结束未收到尾随input时，清除筛选重建输入框后可重新搜索相同中文词', () => {
  let current = '', updates = 0;
  const handle = createSearchInputController(value => { current = value; updates++; });
  const original = { value: '' };
  handle({ type: 'compositionstart', target: original });
  original.value = '汉'; handle({ type: 'compositionend', target: original });
  current = ''; // Clear filters replaces the input DOM node.
  const replacement = { value: '汉' };
  handle({ type: 'input', target: replacement, isComposing: false });
  assert.equal(current, '汉');
  assert.equal(updates, 2);
});

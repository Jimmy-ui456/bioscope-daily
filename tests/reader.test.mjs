import test from 'node:test';
import assert from 'node:assert/strict';
import { filterReadingPapers } from '../dist/reader.js';
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

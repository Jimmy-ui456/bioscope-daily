import test from 'node:test';
import assert from 'node:assert/strict';
import { readMarkFor, indexReadMarks, matchingReadMarks, filterByReadProgress, restoreReadMarks, READ_MARK_LIMIT } from '../dist/read-progress.js';
import { filterReadingPapers } from '../dist/reader.js';

const paper = { id: 'paper-A', doi: '10.12345/Example/v1', pmid: '123', title: 'Original record',
  abstract: 'Original abstract', journal: 'Journal A', publishedAt: '2026-11-19', version: 1 };

test('已读标记匹配相同原文和版本，支持 DOI、PMID、相同 ID，并忽略译文变化', () => {
  const mark = readMarkFor(paper);
  const index = indexReadMarks([mark]);
  for (const same of [
    { ...paper, id: 'new', pmid: null, doi: 'https://doi.org/10.12345/example/v1' },
    { ...paper, id: 'new', doi: null },
    { ...paper, doi: null, pmid: null, enrichment: { titleZh: '新版译文' } },
  ]) assert.deepEqual([...matchingReadMarks(index, readMarkFor(same))], [mark]);
  for (const changed of [
    { ...paper, doi: '10.12345/example/v2' },
    { ...paper, doi: '10.12345/conflict' },
    { ...paper, version: 2 },
    { ...paper, version: null },
    { ...paper, abstract: 'Updated abstract' },
    { ...paper, title: 'Corrected title' },
  ]) assert.equal(matchingReadMarks(index, readMarkFor(changed)).size, 0);
});

test('取消只匹配当前版本，缺 DOI 时不能合并冲突 DOI 的相同 PMID', () => {
  const mark = readMarkFor(paper);
  const same = readMarkFor({ ...paper, id: 'alias' });
  const changed = readMarkFor({ ...paper, doi: '10.12345/example/v2' });
  const index = indexReadMarks([mark, same, changed]);
  const removed = matchingReadMarks(index, mark);
  assert.deepEqual([mark, same, changed].filter(item => !removed.has(item)), [changed]);
  assert.equal(matchingReadMarks(index, readMarkFor({ ...paper, doi: null })).size, 0);
});

test('阅读进度可与期刊及日期窗口一起筛选，保留已有顺序', () => {
  const unread = { ...paper, id: 'unread', doi: null, pmid: null };
  const older = { ...paper, id: 'older', doi: null, pmid: null, publishedAt: '2026-11-06' };
  const other = { ...paper, id: 'other', doi: null, pmid: null, journal: 'Journal B' };
  const index = indexReadMarks([readMarkFor(paper), readMarkFor(other)]);
  const papers = filterReadingPapers([unread, paper, older, other], {
    journal: 'Journal A', days: 7, dateBasis: 'published', kind: 'all', abstract: 'all',
  }, new Date('2026-11-20T00:00:00Z'));
  assert.deepEqual(filterByReadProgress(papers, 'all', index), [unread, paper]);
  assert.deepEqual(filterByReadProgress(papers, 'unread', index), [unread]);
  assert.deepEqual(filterByReadProgress(papers, 'read', index), [paper]);
});

test('恢复限制已读标记数量并报告超出部分，拦截错误形状和重复项', () => {
  const mark = readMarkFor(paper);
  assert.deepEqual(restoreReadMarks([mark, mark, { ...mark, doi: 'not-a-doi' }]), { marks: [mark], skipped: 2 });
  const many = Array.from({ length: READ_MARK_LIMIT + 1 }, (_, index) => ({ ...mark, id: `p-${index}` }));
  assert.deepEqual(restoreReadMarks(many), { marks: many.slice(0, READ_MARK_LIMIT), skipped: 1 });
});

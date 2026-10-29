import test from 'node:test';
import assert from 'node:assert/strict';
import { papersForDownloadRanking } from '../dist/reader.js';
import { normalizePaper, mergePapers } from '../dist/core.js';
import { rankDownloads, metricGroup } from '../dist/enrichment.js';

const metric = { count: 0, kind: 'pdf_downloads', platform: 'Publisher', window: 'cumulative', sourceUrl: 'https://example.org/stats', fetchedAt: '2026-10-30T00:00:00Z' };
const paper = {
  ...normalizePaper({ id: '123', source: 'MED', doi: '10.1234/ranking-test', title: 'A study', abstractText: 'We measured growth.', firstPublicationDate: '2026-10-30', pubTypeList: { pubType: ['Journal Article'] } }, 'synthetic', '2026-10-30T00:00:00Z'),
  downloadMetric: metric,
};
const ordinary = { ...paper, id: 'ordinary', doi: '10.1234/ordinary' };

test('下载排行输入排除布尔和文字撤稿信号，不改变原文献或有效0次统计', () => {
  const missingFlag = { ...paper, status: 'Retraction of Publication' }; delete missingFlag.isRetraction;
  const retracted = [
    { ...paper, isRetraction: true },
    { ...paper, isRetraction: false, status: '撤稿相关' },
    { ...paper, isRetraction: false, type: 'Retracted Publication' },
    missingFlag,
  ];
  for (const candidate of retracted) {
    const records = [candidate, ordinary];
    const before = structuredClone(records);
    const eligible = papersForDownloadRanking(records);
    assert.deepEqual(eligible.map(p => p.id), ['ordinary']);
    assert.equal(eligible[0], ordinary);
    assert.equal(rankDownloads(eligible, metricGroup(metric))[0].downloadMetric.count, 0);
    assert.deepEqual(records, before);
  }
});

test('合并中保留的撤稿信号在不同输入顺序下都不能进入下载排行', () => {
  const retracted = { ...paper, isRetraction: false, type: '撤稿通知' };
  const innocentCopy = { ...paper, id: 'alternate-source', isRetraction: false, status: '期刊记录 · 待核验' };
  const before = structuredClone([retracted, innocentCopy]);
  for (const merged of [mergePapers([retracted], [innocentCopy]), mergePapers([innocentCopy], [retracted])]) {
    assert.equal(merged.length, 1);
    assert.equal(merged[0].isRetraction, true);
    assert.deepEqual(papersForDownloadRanking(merged), []);
    assert.deepEqual(rankDownloads(papersForDownloadRanking(merged), metricGroup(metric)), []);
  }
  assert.deepEqual([retracted, innocentCopy], before);
});

test('否定撤稿状态和题名摘要提及retraction不误排，正常论文及0次可按原口径排行', () => {
  const negativeStatuses = ['未发现撤稿', '未核验更正、撤稿', 'No retraction found', 'Not a Retracted Publication'];
  const records = negativeStatuses.map((status, index) => ({
    ...paper, id: `ordinary-${index}`, doi: `10.1234/ordinary-${index}`, status,
    title: 'Retraction of Publication: a bibliometric analysis', abstract: 'We studied retraction notices.',
    downloadMetric: { ...metric, count: index },
  }));
  const before = structuredClone(records);
  const eligible = papersForDownloadRanking(records);
  assert.deepEqual(eligible.map(p => p.id), records.map(p => p.id));
  const ranked = rankDownloads(eligible, metricGroup(metric));
  assert.deepEqual(ranked.map(p => p.downloadMetric.count), [3, 2, 1, 0]);
  assert.deepEqual(records, before);
});

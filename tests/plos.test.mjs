import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlosMetric } from '../backend/plos.mjs';
import { validateDownloadMetric } from '../dist/enrichment.js';

const paper = { doi: '10.1371/journal.pone.0170929' };
const response = data => async () => ({ ok: true, json: async () => data });

test('PLOS仅累加明确的get-pdf月计数，不使用混合total、HTML或XML', async () => {
  let requested;
  const metric = await fetchPlosMetric(paper, async url => {
    requested = url;
    return { ok: true, json: async () => ({ total: 99999, '(2026, 9)': [['get-document', 800], ['get-pdf', 7], ['get-xml', 100]], '(2026, 10)': [['get-pdf', 3]] }) };
  });
  assert.equal(metric.count, 10);
  assert.equal(metric.kind, 'pdf_downloads');
  assert.equal(metric.platform, 'PLOS');
  assert.equal(metric.coverageStart, '2026-09');
  assert.equal(metric.coverageEnd, '2026-10');
  assert.equal(metric.coverageMonths, 2);
  assert.match(metric.sourceUrl, /^https:\/\/journals\.plos\.org\/plosone\/article\/metrics\?/);
  assert.equal(requested, 'https://counter.plos.org/api/v1.0/stats/doi/10.1371/journal.pone.0170929/format/json');
  assert.equal(validateDownloadMetric(metric), true);
});

test('明确的PDF下载0是有效统计，缺少PDF字段不是0', async () => {
  const zero = await fetchPlosMetric(paper, response({ total: 800, '(2026, 10)': [['get-pdf', 0]] }));
  assert.equal(zero.count, 0);
  assert.equal(await fetchPlosMetric(paper, response({ total: 0 })), null);
  assert.equal(await fetchPlosMetric(paper, response({ total: 10, '(2026, 10)': [['get-document', 10]] })), null);
});

test('部分月份缺少PDF时保留覆盖信息，不把缺失月份当成0', async () => {
  const metric = await fetchPlosMetric(paper, response({ '(2026, 8)': [['get-document', 10]], '(2026, 9)': [['get-pdf', 3]] }));
  assert.equal(metric.count, 3);
  assert.equal(metric.coverageMonths, 1);
  assert.equal(metric.reportedMonths, 2);
  assert.deepEqual(metric.missingPdfMonths, ['2026-08']);
  assert.match(metric.coverageNote, /缺失推定为0/);
});

test('月份、重复计数、非法数值或格式损坏时拒绝统计', async () => {
  const invalid = [
    { '(2026, 13)': [['get-pdf', 1]] },
    { '(2026, 0)': [['get-pdf', 1]] },
    { '(2026, bad)': [['get-pdf', 1]] },
    { '(2026, 10)': 'not rows' },
    { '(2026, 10)': [['get-pdf', -1]] },
    { '(2026, 10)': [['get-pdf', '5']] },
    { '(2026, 10)': [['get-pdf', 1.5]] },
    { '(2026, 10)': [['get-pdf', 1], ['get-pdf', 2]] },
    { '(2026, 9)': [['get-pdf', 1]], '(2026, 09)': [['get-pdf', 2]] },
    { '(2026, 10)': [['get-pdf', Number.MAX_SAFE_INTEGER]], '(2026, 9)': [['get-pdf', 1]] },
    [], null,
  ];
  for (const data of invalid) await assert.rejects(fetchPlosMetric(paper, response(data)));
});

test('HTTP失败或无法解析JSON不会变成下载0', async () => {
  await assert.rejects(fetchPlosMetric(paper, async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(fetchPlosMetric(paper, async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } })), /bad JSON/);
});

test('非PLOS论文和非期刊DOI不访问PLOS接口', async () => {
  let requests = 0;
  for (const doi of ['10.1002/test', '10.5281/zenodo.123', '10.1371/not-a-journal', null]) {
    assert.equal(await fetchPlosMetric({ doi }, async () => { requests++; throw new Error('Must not fetch'); }), null);
  }
  assert.equal(requests, 0);
});

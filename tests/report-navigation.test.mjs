import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedPublicReport, reportLocation, sharedReportLocation } from '../dist/report-navigation.js';
test('RSS刊期参数能在GitHub子目录中稳定定位，拒绝无效日期', () => {
  const href = reportLocation('public-daily-2026-10-29', 'https://example.org/bioscope/?from=rss#overview');
  assert.equal(new URL(href).searchParams.get('from'), 'rss');
  assert.equal(new URL(href).pathname, '/bioscope/');
  assert.equal(new URL(href).hash, '#daily');
  assert.equal(requestedPublicReport(href), 'public-daily-2026-10-29');
  assert.equal(requestedPublicReport('https://example.org/?report=public-daily-2026-02-30'), null);
});
test('分享链接仅包含指定公共期次，移除来源地址中无关参数和用户信息', () => {
  const id = 'public-daily-2026-11-20';
  const original = 'https://username:password@example.org/bioscope/?report=public-daily-2026-11-19&paper=pmid%3A123&query=personal&query=other#private';
  const share = sharedReportLocation(id, original);
  assert.equal(share, 'https://example.org/bioscope/?report=public-daily-2026-11-20#daily');
  assert.equal(requestedPublicReport(share), id);
  assert.equal(new URL(reportLocation(id, original)).searchParams.get('paper'), 'pmid:123');
});
test('无法将私有期次、无效公参或非站点 URL 转成可分享的日报链接', () => {
  for (const id of ['brief-123456', 'public-daily-2026-02-30', 'public-daily-2026-11-20&paper=pmid:123', null]) {
    assert.equal(sharedReportLocation(id, 'https://example.org/bioscope/'), null);
  }
  for (const href of ['not a URL', 'file:///bioscope/index.html']) {
    assert.equal(sharedReportLocation('public-daily-2026-11-20', href), null);
  }
});
test('个人简报标识不会写进共享网址', () => {
  const href = reportLocation('brief-123456', 'https://example.org/bioscope/?report=public-daily-2026-10-29#daily');
  assert.equal(new URL(href).searchParams.has('report'), false);
  assert.equal(href.includes('123456'), false);
});

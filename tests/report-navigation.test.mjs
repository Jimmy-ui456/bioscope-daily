import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedPublicReport, reportLocation } from '../dist/report-navigation.js';
test('RSS刊期参数能在GitHub子目录中稳定定位，拒绝无效日期', () => {
  const href = reportLocation('public-daily-2026-10-29', 'https://example.org/bioscope/?from=rss#overview');
  assert.equal(new URL(href).pathname, '/bioscope/');
  assert.equal(new URL(href).hash, '#daily');
  assert.equal(requestedPublicReport(href), 'public-daily-2026-10-29');
  assert.equal(requestedPublicReport('https://example.org/?report=public-daily-2026-02-30'), null);
});
test('个人简报标识不会写进共享网址', () => {
  const href = reportLocation('brief-123456', 'https://example.org/bioscope/?report=public-daily-2026-10-29#daily');
  assert.equal(new URL(href).searchParams.has('report'), false);
  assert.equal(href.includes('123456'), false);
});

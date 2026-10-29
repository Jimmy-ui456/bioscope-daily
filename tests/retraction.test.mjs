import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { isRetracted, isValidPaper, normalizePaper, mergePapers, chooseReportPapers, knownRetraction, reportMarkdown } from '../dist/core.js';
import { createPublicReport } from '../backend/reports.mjs';
import { runPipeline, saveJson, readJson } from '../backend/pipeline.mjs';

const now = new Date('2026-10-30T03:00:00Z');
const record = { id: '123', source: 'MED', doi: '10.1234/retraction-test', title: 'A study', abstractText: 'We measured growth in shake flasks.', firstPublicationDate: '2026-10-30', pubTypeList: { pubType: ['Journal Article'] } };
const paper = normalizePaper(record, 'synthetic', now.toISOString());
const missingFlag = { ...paper, status: 'Retraction of Publication' };
delete missingFlag.isRetraction;
const retracted = [
  { ...paper, isRetraction: false, status: '撤稿相关' },
  { ...paper, isRetraction: false, type: 'Retracted Publication' },
  missingFlag,
  { ...paper, status: '期刊记录 · 撤稿相关（请核对通知）' },
  { ...paper, type: 'Journal Article; Retraction Notice' },
];

test('合法备份的文字撤稿标记在个人与公共日报均被排除，历史快照与导出均提示', () => {
  const report = { date: '2026-10-30', windowStart: '2026-10-24', createdAt: now.toISOString(), origin: 'sample', papers: [paper] };
  const before = structuredClone(report);
  for (const candidate of retracted) {
    assert.equal(isValidPaper(candidate), true);
    assert.equal(isRetracted(candidate), true);
    assert.deepEqual(chooseReportPapers([candidate], [candidate.id], { at: now }), []);
    assert.equal(createPublicReport([candidate], { now }).papers.length, 0);
    assert.equal(knownRetraction(candidate), candidate);
    assert.equal(knownRetraction(paper, [candidate]), candidate);
    assert.match(reportMarkdown(report, {}, [candidate]), /已知撤稿相关信号/);
  }
  assert.deepEqual(report, before);
});

test('单条插入与不同顺序合并均保留文字撤稿信号，正常副本不能覆盖，输入不变', () => {
  for (const candidate of retracted) {
    const incoming = { ...paper, id: 'another-source' };
    const before = structuredClone([candidate, incoming]);
    for (const result of [mergePapers([], [candidate]), mergePapers([candidate], [incoming]), mergePapers([incoming], [candidate])]) {
      assert.equal(result.length, 1);
      assert.equal(result[0].isRetraction, true);
      assert.equal(result[0].status, '撤稿相关');
      assert.equal(result[0].type, '撤稿相关');
    }
    assert.deepEqual([candidate, incoming], before);
  }
});

test('题名与摘要提及retraction及否定状态均不算已知撤稿，公共和个人筛选保持一致', () => {
  for (const status of ['未发现撤稿', '未发现撤稿相关信息', '未核验更正、撤稿', 'No retraction found', 'Not a Retracted Publication', 'Retraction not found']) {
    const candidate = { ...paper, title: 'Retraction of Publication: a bibliometric analysis', abstract: 'This paper studies retraction notices.', status };
    assert.equal(isRetracted(candidate), false, status);
    assert.equal(knownRetraction(candidate), null);
    assert.equal(chooseReportPapers([candidate], [candidate.id], { at: now }).length, 1);
    assert.equal(createPublicReport([candidate], { now }).papers.length, 1);
    assert.equal(mergePapers([], [candidate])[0].status, status);
  }
  assert.equal(isRetracted({ ...paper, isRetraction: true, status: '未发现撤稿' }), true);
});

test('两个可选标志只接受缺失或真正布尔值，不把字符串false当成true', () => {
  for (const key of ['isRetraction', 'isPreprint']) {
    const missing = { ...paper }; delete missing[key];
    assert.equal(isValidPaper(missing), true);
    for (const flag of [false, true]) assert.equal(isValidPaper({ ...paper, [key]: flag }), true);
    for (const flag of [undefined, null, 'false', 'true', 0, 1, {}, []]) assert.equal(isValidPaper({ ...paper, [key]: flag }), false);
  }
  for (const isRetraction of ['false', 'true', 0, 1, null, {}, []]) assert.equal(isRetracted({ ...paper, isRetraction }), false);
});

test('API类型列表复用正向标签判定，英文撤稿类型规范为布尔true', () => {
  const normalized = normalizePaper({ ...record, pubTypeList: { pubType: ['Journal Article', 'Retraction of Publication'] } }, 'synthetic');
  assert.equal(normalized.isRetraction, true);
  assert.equal(normalized.type, '撤稿相关');
  const ordinary = normalizePaper({ ...record, title: 'A study of Retracted Publication notices' }, 'synthetic');
  assert.equal(ordinary.isRetraction, false);
});

test('后台保留文字标记的记录，但不为其请求模型或收进公共日报', async t => {
  const base = path.resolve('.cache/test-runs');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'retraction-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); });
  await saveJson(path.join(root, 'config/monitor.json'), { topics: ['synthetic'], days: 7, maxAnalysesPerRun: 10, maxModelRequestsPerDay: 20 });
  await saveJson(path.join(root, 'dist/sample.json'), { papers: [] });
  let calls = 0;
  const result = await runPipeline({
    root, now, env: { LLM_BASE_URL: 'https://example.invalid', LLM_MODEL: 'never-call', LLM_API_KEY: 'test-only-invalid' },
    collect: async () => ({ papers: [retracted[0]], hitCount: 1, truncated: false }),
    interpret: async () => { calls++; throw new Error('No interpretation allowed'); },
    fetchMetric: async () => null, log: () => {},
  });
  assert.equal(calls, 0);
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].isRetraction, true);
  assert.equal(result.automation.modelRequestsThisRun, 0);
  assert.equal(result.modelUsage.requests, 0);
  assert.equal((await readJson(path.join(root, 'dist/public-reports.json'))).reports[0].papers.length, 0);
});

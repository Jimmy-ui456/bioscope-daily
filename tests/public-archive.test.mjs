import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaper } from '../dist/core.js';
import { preparePublicArchive, publicArchiveNotice } from '../dist/public-archive.js';

function paper(id = 'fixture') {
  return normalizePaper({ id, source: 'MED', doi: `10.1234/${id}`, title: `Archive fixture ${id}`,
    abstractText: 'The archive retains the supplied abstract without rewriting its conclusions.',
    firstPublicationDate: '2026-11-11', pubTypeList: { pubType: ['Journal Article'] } }, 'synthetic', '2026-11-12T03:00:00Z');
}
function issue(date = '2026-11-12', overrides = {}) {
  const p = paper(date);
  return { id: `public-daily-${date}`, kind: 'public_daily', date, windowStart: '2026-11-06',
    createdAt: '2026-11-12T03:00:00Z', origin: 'live', papers: [p],
    sections: [{ topicId: 'synthetic', label: '合成生物学', paperIds: [p.id] }],
    sourceCollection: { status: 'partial', failedTopics: ['代谢工程'], trigger: 'schedule', runUrl: null },
    selectionPolicy: { description: '规则整理，不是人工科研价值精选。', coverageNote: '当前文献库。' }, ...overrides };
}

test('公共档案严格接受完整期次并保留原文、来源和未审核证据，不改变输入', () => {
  const first = issue('2026-11-11', { createdAt: '2026-11-11T12:00:00Z' });
  const latest = issue();
  latest.papers[0].enrichment = { origin: 'model', findings: { text: '保留的原始解读', evidence: latest.papers[0].abstract } };
  const data = { version: 1, reports: [first, latest] };
  const previous = { reports: [issue('2026-11-10')], status: 'ok', skipped: 0 };
  const before = structuredClone({ data, previous });
  const result = preparePublicArchive(data, previous);
  assert.equal(result.status, 'ok');
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.reports, [latest, first]);
  assert.equal(result.reports[0].sourceCollection.status, 'partial');
  assert.deepEqual(result.reports[0].papers[0].enrichment, latest.papers[0].enrichment);
  assert.equal(publicArchiveNotice(result), '');
  assert.deepEqual({ data, previous }, before);
});

test('顶层读取失败或结构错误保留上次有效期次，不伪装成合法空档案', () => {
  const previous = { reports: [issue(), null, issue('2026-11-11')], status: 'partial', skipped: 2 };
  const before = structuredClone(previous);
  for (const data of [null, undefined, [], false, 'unreadable', {}, { reports: null }, { reports: {} }]) {
    const result = preparePublicArchive(data, previous);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.skipped, 0);
    assert.deepEqual(result.reports.map(r => r.date), ['2026-11-12', '2026-11-11']);
    assert.match(publicArchiveNotice(result), /未能读取.*上次已校验/);
  }
  assert.deepEqual(previous, before);
  const empty = preparePublicArchive(null);
  assert.deepEqual(empty, { reports: [], status: 'unavailable', skipped: 0 });
  assert.match(publicArchiveNotice(empty), /暂时无法确认有无可用期次/);
});

test('null、坏paper及日期/身份/时间/来源异常整期跳过，不删单篇冒充完整首刊', () => {
  const p = paper();
  const invalid = [null, [], false, 'issue', {},
    issue(undefined, { kind: 'private' }), issue(undefined, { id: 'public-daily-2026-11-11' }),
    issue(undefined, { date: '2026-02-30' }), issue(undefined, { windowStart: '2026-02-30' }),
    issue(undefined, { windowStart: '2026-11-13' }), issue(undefined, { origin: 'unknown' }),
    issue(undefined, { createdAt: 0 }), issue(undefined, { createdAt: ['2026-11-12T03:00:00Z'] }),
    issue(undefined, { createdAt: '2026-02-30T03:00:00Z' }), issue(undefined, { createdAt: '2026-11-12T24:00:00Z' }),
    issue(undefined, { createdAt: '2026-11-12T03:00:00' }),
    issue(undefined, { papers: [null] }), issue(undefined, { papers: [p, { ...p, id: '' }] }),
    issue(undefined, { papers: [{ ...p, title: ' ' }] }), issue(undefined, { papers: [{ ...p, topics: null }] }),
    issue(undefined, { papers: [{ ...p, url: 'javascript:alert(1)' }] }), issue(undefined, { papers: Array(11).fill(p) }),
    issue(undefined, { papers: [{ ...p, publishedAt: '2026-02-30' }] })];
  const data = { reports: [...invalid, issue()] };
  const before = structuredClone(data);
  const result = preparePublicArchive(data);
  assert.equal(result.status, 'partial');
  assert.equal(result.skipped, invalid.length);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].papers.length, 1);
  assert.match(publicArchiveNotice(result), new RegExp(`跳过 ${invalid.length} 条`));
  assert.deepEqual(data, before);
});

test('有害sections与文本元数据不能漏过，空数组或缺省旧字段仍兼容', () => {
  const badSections = [null, {}, 'sections', [null], [[]], [{}], [{ label: 3, paperIds: [] }],
    [{ label: '主题', paperIds: null }], [{ label: '主题', paperIds: ['absent'] }], [{ label: '主题', paperIds: [1] }]];
  for (const sections of badSections) {
    const result = preparePublicArchive({ reports: [issue(undefined, { sections })] });
    assert.equal(result.status, 'partial');
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.reports, []);
  }
  for (const selectionPolicy of [{ description: {} }, { coverageNote: { toString: 'bad' } }]) {
    const result = preparePublicArchive({ reports: [issue(undefined, { selectionPolicy })] });
    assert.equal(result.status, 'partial');
    assert.equal(result.skipped, 1);
  }
  const legacy = issue();
  delete legacy.sections; delete legacy.sourceCollection; delete legacy.selectionPolicy;
  const result = preparePublicArchive({ reports: [legacy] });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.reports[0], legacy);
  assert.equal(Object.hasOwn(result.reports[0], 'sourceCollection'), false);
  const empty = issue(undefined, { papers: [], sections: [] });
  assert.equal(preparePublicArchive({ reports: [empty] }).status, 'ok');
});

test('部分坏档案只更新合法期次并保留上次缺失期次，失败后合法读取可恢复', () => {
  const old = issue('2026-11-11');
  const oldSameDate = issue('2026-11-12', { papers: [paper('old-source')], sections: [] });
  const previous = { reports: [oldSameDate, old], status: 'ok', skipped: 0 };
  const latest = issue();
  const result = preparePublicArchive({ reports: [null, latest] }, previous);
  assert.equal(result.status, 'partial');
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.reports, [latest, old]);
  assert.match(publicArchiveNotice(result), /上次有效期次不会因此清空/);
  const failed = preparePublicArchive(null, result);
  assert.deepEqual(failed.reports, result.reports);
  const recovered = preparePublicArchive({ reports: [latest] }, failed);
  assert.deepEqual(recovered, { reports: [latest], status: 'ok', skipped: 0 });
  assert.equal(publicArchiveNotice(recovered), '');
  const cleared = preparePublicArchive({ reports: [] }, result);
  assert.deepEqual(cleared, { reports: [], status: 'ok', skipped: 0 });
  assert.equal(publicArchiveNotice(cleared), '');
});

test('全部坏期次也保留上次有效档案，并且不把已知0篇空刊判成无效', () => {
  const previous = { reports: [issue()], status: 'ok', skipped: 0 };
  const result = preparePublicArchive({ reports: [null, false] }, previous);
  assert.deepEqual(result.reports, previous.reports);
  assert.equal(result.status, 'partial');
  assert.equal(result.skipped, 2);
  const emptyIssue = issue(undefined, { papers: [], sections: [] });
  const valid = preparePublicArchive({ reports: [emptyIssue] }, previous);
  assert.equal(valid.status, 'ok');
  assert.equal(valid.reports[0].papers.length, 0);
});

test('同日重复保留最早真实成刊时间，时区不能按字符串比较，最多显示14期', () => {
  const late = issue(undefined, { createdAt: '2026-11-12T09:30:00+08:00' });
  const first = issue(undefined, { createdAt: '2026-11-12T01:00:00Z' });
  const result = preparePublicArchive({ reports: [late, first] });
  assert.equal(result.status, 'partial');
  assert.equal(result.skipped, 1);
  assert.equal(result.reports[0], first);
  const history = Array.from({ length: 20 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 10, 12 - index)).toISOString().slice(0, 10);
    return issue(date, { windowStart: date });
  });
  const capped = preparePublicArchive({ reports: history.reverse() });
  assert.equal(capped.status, 'ok');
  assert.equal(capped.reports.length, 14);
  assert.equal(capped.reports[0].date, '2026-11-12');
  assert.equal(capped.reports[13].date, '2026-10-30');
});

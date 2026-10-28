import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TOPICS, normalizePaper, cleanDoi, mergePapers, isValidPaper, collectTopic, chooseReportPapers, beijingDay, buildQuery, plainText, reportMarkdown } from '../dist/core.js';

const at = new Date('2026-10-27T02:00:00Z');
const record = { id: '123', source: 'MED', title: '<i>A study</i>', abstractText: '<p>Evidence &amp; conditions.</p>', firstPublicationDate: '2026-10-26', doi: 'https://doi.org/10.1234/ABC', authorString: 'A, B', journalInfo: { journal: { title: 'Example Journal' } }, pubTypeList: { pubType: ['Journal Article'] } };

test('规范化论文标识，并且不将期刊记录断言为已完成评审', () => {
  const p = normalizePaper(record, 'metabolic', at.toISOString());
  assert.equal(p.doi, '10.1234/abc');
  assert.equal(p.pmid, '123');
  assert.equal(p.title, 'A study');
  assert.equal(p.abstract, 'Evidence & conditions.');
  assert.equal(p.readingScope, '仅摘要');
  assert.equal(p.status, '期刊记录 · 待核验');
  assert.equal(cleanDoi('not-a-doi'), null);
});
test('区分预印本、缺失摘要和撤稿类型', () => {
  const preprint = normalizePaper({ ...record, source: 'PPR', abstractText: '', pubTypeList: { pubType: ['Preprint'] } }, 'synthetic');
  assert.equal(preprint.isPreprint, true);
  assert.equal(preprint.pmid, null);
  assert.equal(preprint.readingScope, '仅题录');
  const retracted = normalizePaper({ ...record, pubTypeList: { pubType: ['Retracted Publication'] } });
  assert.equal(retracted.isRetraction, true);
});
test('重复来源中缺少撤稿字段不会抹去已知撤稿信号', () => {
  const first = normalizePaper({ ...record, pubTypeList: { pubType: ['Retracted Publication'] } }, 'metabolic');
  const later = normalizePaper(record, 'synthetic');
  const merged = mergePapers([first], [later]);
  assert.equal(merged.length, 1); assert.equal(merged[0].isRetraction, true); assert.equal(merged[0].status, '撤稿相关');
});
test('实际不存在的日历日期不会当作论文发表时间', () => {
  const invalid = normalizePaper({ ...record, firstPublicationDate: '2026-02-30' }, 'synthetic');
  assert.equal(invalid.publishedAt, null);
  const p = normalizePaper(record, 'synthetic');
  assert.equal(isValidPaper({ ...p, publishedAt: '2026-02-30' }), false);
});
test('同一 DOI 大小写和网址形式的记录合并，保留主题、摘要及首次发现时间', () => {
  const first = normalizePaper(record, 'metabolic', '2026-10-20T00:00:00Z');
  const second = { ...normalizePaper({ ...record, doi: '10.1234/abc', abstractText: '' }, 'synthetic'), id: 'other-source' };
  const merged = mergePapers([first], [second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, first.id);
  assert.equal(merged[0].discoveredAt, first.discoveredAt);
  assert.equal(merged[0].abstract, first.abstract);
  assert.deepEqual(new Set(merged[0].topics), new Set(['metabolic', 'synthetic']));
});
test('采集遍历分页、编码查询，并明确报告读取上限', async () => {
  const urls = [];
  let n = 0;
  const result = await collectTopic(TOPICS[0], { maxPages: 2, at, fetchImpl: async url => {
    urls.push(new URL(url)); n++;
    return { ok: true, json: async () => ({ hitCount: 60, nextCursorMark: `cursor-${n}`, resultList: { result: [{ ...record, id: String(n), doi: `10.1234/item-${n}` }] } }) };
  } });
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get('cursorMark'), '*');
  assert.equal(urls[1].searchParams.get('cursorMark'), 'cursor-1');
  assert.equal(result.truncated, true);
  assert.equal(result.papers.length, 2);
  assert.match(urls[0].searchParams.get('query'), /FIRST_PDATE:\[2026-09-28 TO 2026-10-27\]/);
});
test('补齐 DOI 的记录通过 PMID 合并，保留既有收藏所用的记录 ID', () => {
  const old = normalizePaper({ ...record, doi: undefined }, 'metabolic');
  const updated = normalizePaper(record, 'synthetic');
  const merged = mergePapers([old], [updated]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, old.id);
  assert.equal(merged[0].doi, updated.doi);
});
test('备份文献字段与链接必须符合约定', () => {
  const p = normalizePaper(record, 'synthetic');
  assert.equal(isValidPaper(p), true);
  assert.equal(isValidPaper({ ...p, url: 'javascript:alert(1)' }), false);
  assert.equal(isValidPaper({ ...p, url: 'https://europepmc.org.attacker.example/x' }), false);
  assert.equal(isValidPaper({ ...p, publishedAt: { bad: true } }), false);
  assert.equal(isValidPaper({ ...p, topics: ['unknown-topic'] }), false);
});
test('接口异常拒绝采集，不制造成功数据', async () => {
  await assert.rejects(collectTopic(TOPICS[0], { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
  await assert.rejects(collectTopic(TOPICS[0], { fetchImpl: async () => ({ ok: true, json: async () => ({ errCode: 1, errMsg: 'bad query' }) }) }), /bad query/);
});
test('简报只包括范围内的人工精选，排除未来、历史和撤稿记录', () => {
  const paper = normalizePaper(record, 'metabolic');
  const all = [paper, { ...paper, id: 'old', publishedAt: '2026-01-01' }, { ...paper, id: 'future', publishedAt: '2026-11-01' }, { ...paper, id: 'retracted', isRetraction: true }, { ...paper, id: 'not-selected' }];
  assert.deepEqual(chooseReportPapers(all, [paper.id, 'old', 'future', 'retracted'], { at, days: 7 }).map(p => p.id), [paper.id]);
});
test('北京时间日期边界和日期检索明确', () => {
  assert.equal(beijingDay(new Date('2026-10-26T17:00:00Z')), '2026-10-27');
  assert.match(buildQuery(TOPICS[0], 7, at), /2026-10-21 TO 2026-10-27/);
  assert.match(buildQuery(TOPICS[0], 1, at), /2026-10-27 TO 2026-10-27/);
});
test('导出保留出处、证据状态和样本标记', () => {
  const p = normalizePaper(record, 'synthetic');
  const md = reportMarkdown({ date: '2026-10-27', createdAt: at.toISOString(), windowStart: '2026-10-20', origin: 'sample', papers: [p] });
  assert.match(md, /不代表今日完整监控/);
  assert.match(md, /https:\/\/doi.org\/10.1234\/abc/);
  assert.match(md, /未进行全文核验/);
  assert.match(md, /Evidence & conditions/);
});
test('清理普通标签和转义后的标签', () => {
  assert.equal(plainText('from &lt;i&gt;Panax&lt;/i&gt; &amp; yeast'), 'from Panax & yeast');
});
test('初始样本来自真实接口，具备出处和阅读范围，身份不重复', async () => {
  const sample = JSON.parse(await readFile(new URL('../dist/sample.json', import.meta.url), 'utf8'));
  assert.ok(sample.papers.length > 0);
  assert.equal(new Set(sample.papers.map(p => p.id)).size, sample.papers.length);
  for (const p of sample.papers) {
    assert.ok(p.sourceId && p.source && p.title);
    assert.match(p.url, /^https:\/\/(?:doi\.org|europepmc\.org)\//);
    assert.ok(['仅摘要', '仅题录'].includes(p.readingScope));
  }
});

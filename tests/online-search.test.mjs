import test from 'node:test';
import assert from 'node:assert/strict';
import { onlineQuery, onlineRequest, fetchOnlineCitations, onlineCitation, restoreOnlineCitations } from '../dist/online-search.js';
import { persistOnlineCitations } from '../dist/local-state.js';

const row = { source: 'PPR', id: 'PPR123', title: '<i>Fixture</i>', authorString: 'A B', journalTitle: 'Journal',
  doi: '10.1234/fixture/v1', pubYear: '2026' };

test('Europe PMC 任一和排除词组使用有界的字面布尔分组', () => {
  const { url } = onlineRequest({ terms: 'common', anyPhrases: 'alpha，beta', excludePhrases: 'literal" OR x, bracket (y)' });
  assert.equal(url.searchParams.get('query'), '"common" AND ("alpha" OR "beta") AND NOT ("literal\\" OR x" OR "bracket (y)")');
  assert.equal(onlineQuery({ anyPhrases: 'alpha,beta' }).query, '("alpha" OR "beta")');
  assert.throws(() => onlineQuery({ excludePhrases: 'only' }), /正向/);
  assert.throws(() => onlineQuery({ anyPhrases: 'a,b,c,d,e,f' }), /最多 5/);
  assert.throws(() => onlineQuery({ terms: 'valid', excludePhrases: 'x'.repeat(161) }), /最多 160/);
  for (const provider of ['crossref', 'datacite']) {
    assert.throws(() => onlineRequest({ provider, title: 'valid', anyPhrases: 'other' }), /仅适用于 Europe PMC/);
    assert.throws(() => onlineRequest({ provider, title: 'valid', excludePhrases: 'other' }), /仅适用于 Europe PMC/);
  }
  assert.equal(onlineQuery({ doi: row.doi }).query, 'DOI:"' + row.doi + '"');
});

test('Crossref 题录参数、日期和期刊范围可组合，完整 DOI 不携带其他条件', () => {
  const { url } = onlineRequest({ provider: 'crossref', terms: 'keyword', title: 'title', author: 'R.', journal: 'J', from: '2026-05-01' });
  assert.equal(url.origin, 'https://api.crossref.org');
  assert.equal(url.searchParams.get('filter'), 'type:journal-article,from-pub-date:2026-05-01');
  assert.equal(url.searchParams.get('query.bibliographic'), 'title keyword');
  assert.equal(url.searchParams.get('query.author'), 'R.');
  assert.equal(url.searchParams.get('query.container-title'), 'J');
  assert.throws(() => onlineRequest({ provider: 'crossref', doi: row.doi, terms: 'other' }), /仅使用 DOI/);
  const single = onlineRequest({ provider: 'crossref', doi: row.doi });
  assert.equal(decodeURIComponent(single.url.pathname), '/works/' + row.doi);
  assert.equal(single.url.search, '');
});
test('DataCite 仅接收可支持字段并过滤非论文条目，Crossref 只有年份时不造具体日期', async () => {
  const request = onlineRequest({ provider: 'datacite', title: 'a" OR b' });
  assert.equal(request.url.origin, 'https://api.datacite.org');
  assert.match(request.url.searchParams.get('query'), /^types\.resourceTypeGeneral:\(JournalArticle OR Preprint\) AND titles\.title:/);
  assert.throws(() => onlineRequest({ provider: 'datacite', author: 'other' }));
  const fixture = { type: 'dois', attributes: { doi: row.doi, titles: [{ title: 'DataCite' }], types: { resourceTypeGeneral: 'Preprint' }, publicationYear: 2026 } };
  const data = await fetchOnlineCitations({ provider: 'datacite', title: 'some title' }, { fetchImpl: async () => ({ ok: true,
    json: async () => ({ data: [fixture, { ...fixture, attributes: { ...fixture.attributes, types: { resourceTypeGeneral: 'Dataset' } } }], meta: { total: 2 } }) }) });
  assert.deepEqual(data.items.map(item => [item.provider, item.year, item.publishedAt]), [['datacite', '2026', null]]);
  const crossref = await fetchOnlineCitations({ provider: 'crossref', doi: row.doi }, { fetchImpl: async () => ({ ok: true,
    json: async () => ({ status: 'ok', message: { DOI: row.doi, title: ['Crossref'], type: 'journal-article', issued: { 'date-parts': [[2026]] } } }) }) });
  assert.deepEqual(crossref.items.map(item => [item.provider, item.year, item.publishedAt]), [['crossref', '2026', null]]);
  assert.equal(data.items[0].publicationType, 'preprint');
  assert.equal(crossref.items[0].publicationType, 'journal');
  assert.equal(new URL(data.items[0].recordUrl).origin, 'https://api.datacite.org');
  assert.equal(new URL(crossref.items[0].recordUrl).origin, 'https://api.crossref.org');
  assert.equal(onlineCitation({ ...crossref.items[0], publicationType: undefined }).publicationType, undefined);
  assert.equal(restoreOnlineCitations([onlineCitation(row), ...data.items, ...crossref.items]).items.length, 3);
});
test('在线来源 404 单篇返回无结果，429 只请求一次，不接受另一个版本', async () => {
  let calls = 0;
  const input = { provider: 'crossref', doi: row.doi };
  assert.deepEqual(await fetchOnlineCitations(input, { fetchImpl: async () => ({ status: 404, ok: false }) }), { hitCount: 0, items: [] });
  await assert.rejects(fetchOnlineCitations(input, { fetchImpl: async () => { calls++; return { status: 429, ok: false }; } }), /限制检索频率/);
  assert.equal(calls, 1);
  const mismatched = await fetchOnlineCitations(input, { fetchImpl: async () => ({ ok: true, json: async () =>
    ({ status: 'ok', message: { DOI: row.doi.replace('/v1', '/v2'), title: ['Different version'], type: 'journal-article' } }) }) });
  assert.deepEqual(mismatched, { hitCount: 0, items: [] });
});

test('在线字段作字面短语组合，日期和 DOI 按结构校验', () => {
  const q = onlineQuery({ terms: 'a OR b', title: 'x" y', author: 'A B', journal: 'Journal', from: '2026-02-01', doi: row.doi });
  assert.ok(q.query.includes('"a OR b" AND TITLE:' + JSON.stringify('x" y')));
  assert.match(q.query, /AUTH:"A B" AND JOURNAL:"Journal" AND DOI:/);
  assert.ok(q.query.endsWith('FIRST_PDATE:[2026-02-01 TO *]'));
  for (const fields of [{}, { terms: 'a'.repeat(161) }, { doi: 'malformed' }, { from: '2026-02-30' }, { from: '2026-11-01', to: '2026-10-01' }]) {
    assert.throws(() => onlineQuery(fields));
  }
});
test('固定 Europe PMC lite 端点，返回首批至多 20 项且精确 DOI 保留版本', async () => {
  let requests = 0;
  const signal = new AbortController().signal;
  const result = await fetchOnlineCitations({ doi: row.doi }, { signal, fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url.origin, 'https://www.ebi.ac.uk');
    assert.equal(url.searchParams.get('resultType'), 'lite');
    assert.equal(url.searchParams.get('pageSize'), '20');
    assert.equal(options.signal, signal);
    assert.equal(options.credentials, 'omit');
    return { ok: true, json: async () => ({ hitCount: 24, resultList: { result: [row, { ...row, doi: '10.1234/fixture/v2' }, ...Array(25).fill(row)] } }) };
  } });
  assert.equal(requests, 1);
  assert.equal(result.hitCount, 24);
  assert.deepEqual(result.items.map(x => x.id), ['doi:10.1234/fixture/v1']);
  assert.equal(result.items[0].title, 'Fixture');
  assert.equal(result.items[0].publishedAt, null);
  assert.equal(result.items[0].year, '2026');
});
test('在线收藏保存净化题录并保护更新的原始记录', () => {
  const item = onlineCitation(row);
  assert.equal(onlineCitation({ ...row, id: '..' }), null);
  assert.deepEqual(restoreOnlineCitations([row, row, null]), { items: [item], skipped: 2 });
  let raw = null;
  const storage = { getItem: () => raw, setItem: (key, value) => { assert.equal(key, 'bioscope.v1.onlineCitations'); raw = value; } };
  const saved = persistOnlineCitations(storage, [item], null);
  assert.equal(saved.status, 'saved');
  assert.equal(persistOnlineCitations(storage, [], null).status, 'changed');
  assert.equal(persistOnlineCitations(storage, [], saved.raw).status, 'saved');
});

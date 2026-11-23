import test from 'node:test';
import assert from 'node:assert/strict';
import { onlineQuery, fetchOnlineCitations, onlineCitation, restoreOnlineCitations } from '../dist/online-search.js';
import { persistOnlineCitations } from '../dist/local-state.js';

const row = { source: 'PPR', id: 'PPR123', title: '<i>Fixture</i>', authorString: 'A B', journalTitle: 'Journal',
  doi: '10.1234/fixture/v1', pubYear: '2026' };

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

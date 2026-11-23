import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCrossrefSupplement } from '../backend/crossref-supplement.mjs';
import { crossrefSupplementView } from '../dist/crossref-supplement.js';

const topics = ['synthetic', 'metabolic', 'microbial'].map(id => ({ id }));
const now = new Date('2026-11-22T16:30:00Z');
const issued = (...parts) => ({ 'date-parts': [parts] });
const row = (suffix, title, extra = {}) => ({
  DOI: '10.1234/' + suffix, title: [title], type: 'journal-article', issued: issued(2026, 11, 22), ...extra,
});
const page = items => ({ ok: true, json: async () => ({ status: 'ok', message: { 'total-results': 30, items } }) });

test('补充题录仅接受完整日期、题名字面和新 DOI，方向间按完整 DOI 去重', async () => {
  const calls = [];
  const both = row('both/v1', 'Synthetic biology and metabolic engineering');
  const result = await collectCrossrefSupplement({ topics, days: 30, now, primary: [{ doi: '10.1234/core' }, { doi: '10.1234/seen' }],
    wait: async () => { calls.push('wait'); }, fetchImpl: async url => {
      const phrase = url.searchParams.get('query.bibliographic');
      calls.push(phrase); assert.equal(url.origin, 'https://api.crossref.org');
      assert.equal(url.searchParams.get('rows'), '20'); assert.equal(url.searchParams.get('query.title'), null);
      assert.equal(url.searchParams.get('filter'), 'type:journal-article,from-pub-date:2026-10-25,until-pub-date:2026-11-23');
      if (phrase === 'synthetic biology') return page([both, row('core', 'Synthetic biology'), row('seen', 'Synthetic biology'),
        row('invalid', 'Synthetic biology', { issued: issued(2026, 11) }), row('conflict', 'Synthetic biology', { published: issued(2026, 11, 21) }),
        row('older', 'Synthetic biology', { issued: issued(2026, 10, 24) }), row('irrelevant', 'Different title'),
        row('nonpaper', 'Synthetic biology', { type: 'book' })]);
      if (phrase === 'metabolic engineering') return page([both, row('both/v2', 'Metabolic engineering')]);
      return { ok: false, status: 503 };
    } });
  assert.deepEqual(calls, ['synthetic biology', 'wait', 'metabolic engineering', 'wait', 'biomanufacturing']);
  const [first, second, third] = result.directions;
  assert.equal(first.eligible, 3); assert.equal(first.fresh, 1);
  assert.deepEqual(first.records.map(x => x.doi), ['10.1234/both/v1']);
  assert.deepEqual(second.records.map(x => x.doi), ['10.1234/both/v2']);
  assert.equal(third.status, 'failed');
  assert.ok(crossrefSupplementView(result));
  assert.equal(crossrefSupplementView({ ...result, directions: [{ ...first, fresh: 99 }] }), null);
});
test('限流后停止请求，正常题录最多展示 8 条，且不把摘要存入快照', async () => {
  let calls = 0;
  const result = await collectCrossrefSupplement({ topics, days: 7, now, primary: [], wait: async () => {},
    fetchImpl: async () => ++calls === 1 ? page(Array.from({ length: 20 }, (_, i) => row('eligible-' + i, 'Synthetic biology', { abstract: 'irrelevant payload' })))
      : { ok: false, status: 429 } });
  assert.equal(calls, 2);
  assert.deepEqual(result.directions.map(row => row.status), ['ok', 'limited', 'skipped']);
  assert.equal(result.directions[0].fresh, 20);
  assert.equal(result.directions[0].records.length, 8);
  assert.doesNotMatch(JSON.stringify(result), /abstract|irrelevant payload/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { rankRecommendations, recommendationId, restoreRecommendationVotes } from '../dist/recommendations.js';
import { persistRecommendationVotes, readLocalReaderState } from '../dist/local-state.js';

const voted = { id: 'a', doi: '10.1234/item/v1', title: 'Catalytic phosphatase analysis', publishedAt: '2026-11-20', topics: ['synthetic'] };
const similar = { id: 'b', title: 'Phosphatase characterization', publishedAt: '2026-11-19', topics: ['metabolic'] };
const unrelated = { id: 'c', title: 'Spectral imaging', publishedAt: '2026-11-20', topics: ['synthetic'] };
const deprecated = { ...similar, id: 'retracted', isRetraction: true };
const candidate = [voted, similar, unrelated, deprecated];
const signal = { id: recommendationId(voted), title: voted.title, choice: 1 };
const fields = (papers, votes) => rankRecommendations(papers, votes).map(row => [row.paper.id, row.score]);

test('喜欢和不喜欢立即提升或降低其他相似记录，撤回恢复原排序', () => {
  const neutral = [['a', 0], ['c', 0], ['b', 0]];
  assert.deepEqual(fields(candidate, []), neutral);
  assert.deepEqual(fields(candidate, [signal]), [['b', 1], ['a', 0], ['c', 0]]);
  assert.deepEqual(fields([similar, { ...unrelated, publishedAt: '2026-11-18' }], [signal]), [['b', 1], ['c', 0]]);
  assert.deepEqual(fields([similar, { ...unrelated, publishedAt: '2026-11-18' }], [{ ...signal, choice: -1 }]), [['c', 0], ['b', -1]]);
  assert.deepEqual(fields(candidate, []), neutral);
});

test('阅读偏好不会跨越大于有界日期位移的文献，缺失日期保留最后的稳定顺序', () => {
  const distant = { ...unrelated, publishedAt: '2026-10-01' };
  const undated = { ...similar, id: 'undated', publishedAt: null };
  const negative = Array.from({ length: 20 }, (_, i) => ({ ...signal, id: 'id:' + i, choice: -1 }));
  assert.deepEqual(fields([distant, undated, similar], negative), [['b', -8], ['c', 0], ['undated', -8]]);
});

test('版本化 DOI 独立、旧偏好仍能作用于其他文献、影响幅度有限', () => {
  assert.notEqual(recommendationId(voted), recommendationId({ ...voted, doi: '10.1234/item/v2' }));
  assert.deepEqual(fields([similar], Array.from({ length: 40 }, (_, i) => ({ ...signal, id: 'id:' + i }))), [['b', 8]]);
  assert.deepEqual(restoreRecommendationVotes([signal, signal, { ...signal, choice: 0 }]), { votes: [signal], skipped: 2 });
});

test('偏好只写本机专用记录并拒绝用旧版本覆盖跨标签页更新', () => {
  let raw = null;
  const storage = { getItem: key => key.endsWith('.recommendationVotes') ? raw : null,
    setItem: (key, value) => { assert.equal(key, 'bioscope.v1.recommendationVotes'); raw = value; } };
  const saved = persistRecommendationVotes(storage, [signal], null);
  assert.equal(saved.status, 'saved');
  assert.deepEqual(readLocalReaderState(storage).recommendationVotes, [signal]);
  assert.equal(persistRecommendationVotes(storage, [], null).status, 'changed');
  assert.equal(persistRecommendationVotes(storage, [], saved.raw).status, 'saved');
});

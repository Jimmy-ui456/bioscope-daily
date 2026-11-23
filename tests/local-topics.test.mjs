import test from 'node:test';
import assert from 'node:assert/strict';
import { localTopicSnapshot, restoreLocalTopics, localTopicMatches } from '../dist/local-topics.js';
import { rankRecommendations } from '../dist/recommendations.js';
import { persistLocalTopics, readLocalReaderState } from '../dist/local-state.js';

const topic = { id: 't1', name: '兴趣', phrases: ['ＡＢＣ   system', '共聚'], enabled: true };
const papers = [
  { id: 'outside', title: 'ABC system work', abstract: '', publishedAt: '2026-11-18' },
  { id: 'in', title: 'Recent article', abstract: '', publishedAt: '2026-11-20' },
  { id: 'split', title: 'ABC', abstract: 'system', publishedAt: '2026-11-20' },
  { id: 'abstract', title: 'Example', abstract: '有关共聚的记录', publishedAt: null },
];
test('主题按 NFKC、大写及空白进行任一字面匹配，题名和摘要不能拼接', () => {
  assert.deepEqual([...localTopicMatches(papers, [topic])], [['outside', ['兴趣']], ['abstract', ['兴趣']]]);
  assert.deepEqual(localTopicSnapshot({ ...topic, phrases: ['ＡＢＣ', 'abc'] }).phrases, ['ＡＢＣ']);
  assert.equal(localTopicSnapshot({ ...topic, phrases: ['x'.repeat(101)] }), null);
  assert.equal(restoreLocalTopics([topic, { ...topic, id: 't2', name: ' 兴趣 ' }]).skipped, 1);
});
test('开启本机主题纳入额外候选并有限提高日期优先级，停用后回到原候选', () => {
  const third = { ...topic, id: 't3', name: '第三主题' };
  const matches = localTopicMatches(papers, [topic, { ...third, name: '另一个主题' }, third]);
  const ranked = rankRecommendations(papers.filter(paper => paper.id === 'in' || matches.has(paper.id)), [], matches);
  assert.equal(ranked[0].paper.id, 'outside');
  assert.equal(ranked[0].rankDay - ranked[0].date, 6);
  assert.equal(ranked[0].score, 0);
  assert.equal(ranked[0].topicNames.length, 3);
  const disabled = [{ ...topic, enabled: false }];
  assert.equal(localTopicMatches(papers, disabled.filter(item => item.enabled)).size, 0);
  assert.equal(rankRecommendations([papers[1]], [])[0].paper.id, 'in');
});
test('本机主题正常保存、读取，过期标签页无法覆盖新值', () => {
  let raw = null;
  const storage = { getItem: key => key.endsWith('.localTopics') ? raw : null,
    setItem: (key, value) => { assert.equal(key, 'bioscope.v1.localTopics'); raw = value; } };
  const saved = persistLocalTopics(storage, [topic], null);
  assert.equal(saved.status, 'saved');
  assert.deepEqual(readLocalReaderState(storage).localTopics, [topic]);
  assert.equal(persistLocalTopics(storage, [], null).status, 'changed');
  assert.equal(persistLocalTopics(storage, [], saved.raw).status, 'saved');
});

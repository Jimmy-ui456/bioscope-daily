export const LOCAL_TOPIC_LIMIT = 20;
const normal = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export function localTopicSnapshot(value) {
  const { id, name, phrases, enabled } = value || {};
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)
    || typeof name !== 'string' || !name.trim() || name.length > 60 || /\p{Cc}/u.test(name)
    || typeof enabled !== 'boolean' || !Array.isArray(phrases) || !phrases.length || phrases.length > 12) return null;
  const unique = new Map();
  for (const phrase of phrases) {
    if (typeof phrase !== 'string' || !phrase.trim() || phrase.length > 100 || /\p{Cc}/u.test(phrase)) return null;
    if (!unique.has(normal(phrase))) unique.set(normal(phrase), phrase.trim());
  }
  return { id, name: name.trim(), phrases: [...unique.values()], enabled };
}

export function restoreLocalTopics(value) {
  if (value === undefined) return { items: [], skipped: 0 };
  if (!Array.isArray(value)) return { items: [], skipped: 1 };
  const items = [], keys = new Set();
  for (const entry of value) {
    if (items.length >= LOCAL_TOPIC_LIMIT) break;
    const topic = localTopicSnapshot(entry);
    if (!topic || keys.has('id:' + topic.id) || keys.has('name:' + normal(topic.name))) continue;
    keys.add('id:' + topic.id); keys.add('name:' + normal(topic.name)); items.push(topic);
  }
  return { items, skipped: value.length - items.length };
}

export function localTopicMatches(papers, topics) {
  const compiled = topics.map(topic => ({ name: topic.name, phrases: topic.phrases.map(normal) }));
  const matches = new Map();
  if (!compiled.length) return matches;
  for (const paper of papers) {
    const title = normal(paper.title || ''), abstract = normal(paper.abstract || '');
    const names = compiled.filter(topic => topic.phrases.some(phrase => title.includes(phrase) || abstract.includes(phrase))).map(topic => topic.name);
    if (names.length) matches.set(paper.id, names);
  }
  return matches;
}

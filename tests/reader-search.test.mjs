import test from 'node:test';
import assert from 'node:assert/strict';
import { searchReadingPapers } from '../dist/reader.js';
import { sourceFingerprint } from '../dist/enrichment.js';

const paper = { id: 'doi:10.1016/j.mcpro.2026.101695', doi: '10.1016/j.mcpro.2026.101695', pmid: 42933642,
  title: 'High-throughput protein\ninteractome for yeast systems', abstract: 'We measured 10 conditions and 25 g/L product.',
  authors: 'Liu D; Sánchez E', journal: 'Molecular & Cellular Proteomics', topics: ['synthetic'],
  pmcid: 'PMC12345678', source: 'MED', sourceId: '42933642', url: 'https://doi.org/10.1016/j.mcpro.2026.101695', type: '期刊论文' };
const other = { ...paper, id: 'doi:10.1234/other', doi: '10.1234/other', pmid: '429336421',
  title: 'A different paper', abstract: 'Metabolic findings.', topics: ['metabolic'], url: 'https://doi.org/10.1234/other' };
const ids = (query, papers = [paper, other], catalog = {}) => searchReadingPapers(papers, query, catalog).map(item => item.id);
function translated(source, overrides = {}) {
  return { sourceTitle: source.title, sourceAbstract: source.abstract, sourceFingerprint: sourceFingerprint(source),
    titleZh: '酵母互作研究', abstractZh: '测量条件与产物浓度。', origin: 'assistant_translation', ...overrides };
}

test('完整DOI及解析网址按规范标识精确匹配，忽略网址query/hash并安全解码路径', () => {
  const queries = ['10.1016/j.mcpro.2026.101695', 'DOI: 10.1016/J.MCPRO.2026.101695',
    'https://doi.org/10.1016/j.mcpro.2026.101695?utm_source=reader#figure-1',
    'http://dx.doi.org/10.1016%2Fj.mcpro.2026.101695?download=1',
    'doi.org/10.1016/j.mcpro.2026.101695', 'dx.doi.org/10.1016/j.mcpro.2026.101695',
    'DOI: https://doi.org/10.1016/j.mcpro.2026.101695'];
  for (const query of queries) assert.deepEqual(ids(query), [paper.id], query);
  const urlStored = { ...paper, doi: 'https://dx.doi.org/10.1016/J.MCPRO.2026.101695?source=export#abstract' };
  assert.deepEqual(ids(paper.doi, [urlStored]), [paper.id]);
  assert.deepEqual(ids('10.1016/j.mcpro.2026.101695-extra'), []);
});

test('DOI后缀不作NFKC、不随意删尾标点，URL中的编码问号或井号仍属于路径', () => {
  const records = [
    { ...paper, id: 'ascii', doi: '10.1234/a' }, { ...paper, id: 'fullwidth', doi: '10.1234/Ａ' },
    { ...paper, id: 'punctuation', doi: '10.1234/a.' }, { ...paper, id: 'encoded', doi: '10.1234/a?b#c' },
  ];
  assert.deepEqual(ids('10.1234/A', records), ['ascii']);
  assert.deepEqual(ids('10.1234/Ａ', records), ['fullwidth']);
  assert.deepEqual(ids('doi:10.1234/a.', records), ['punctuation']);
  assert.deepEqual(ids('https://doi.org/10.1234/a%3Fb%23c?source=reader#section', records), ['encoded']);
});

test('显式PMID前缀与PubMed编号网址精确匹配数字或字符串字段，纯数字继续普通包含检索', () => {
  for (const pmid of [42933642, '42933642']) {
    const records = [{ ...paper, pmid }, other];
    for (const query of ['PMID: 42933642', 'pmid:\t42933642', 'https://pubmed.ncbi.nlm.nih.gov/42933642/',
      'https://pubmed.ncbi.nlm.nih.gov/42933642?dopt=Abstract#full-view', 'pubmed.ncbi.nlm.nih.gov/42933642/']) {
      assert.deepEqual(ids(query, records), [paper.id], query);
    }
    assert.deepEqual(ids('42933642', records), [paper.id, other.id]);
  }
  const dataNumber = { ...paper, id: 'numeric-data', doi: null, pmid: '7654321', title: 'We measured 10 samples', abstract: '', sourceId: '', url: '' };
  assert.ok(ids('10', [dataNumber]).includes('numeric-data'));
  assert.deepEqual(ids('PMID: 10', [dataNumber]), []);
});

test('普通中英短语合并空白并兼容全角输入，仍按字段包含检索且不改原文', () => {
  const records = [paper, other];
  const catalog = { [paper.id]: translated(paper) };
  const before = structuredClone({ records, catalog });
  for (const query of ['protein   interactome', 'ＰＲＯＴＥＩＮ　ｉｎｔｅｒａｃｔｏｍｅ', '２５　ｇ／Ｌ',
    '酵母互作研究', '条件与产物', 'SÁNCHEZ', 'ＭＯＬＥＣＵＬＡＲ', '合成生物学', 'Synthetic biology']) {
    assert.ok(ids(query, records, catalog).includes(paper.id), query);
  }
  assert.deepEqual(ids('metabolic engineering', records), [other.id]);
  assert.deepEqual(ids('protein missing interactome', records, catalog), []);
  assert.deepEqual({ records, catalog }, before);
});

test('中文检索只使用绑定当前原文的有效译文，失效来源及伪造锚点不能匹配', () => {
  const changed = { ...paper, abstract: paper.abstract + ' Updated source.' };
  const stale = translated(paper, { titleZh: '过期唯一译文', abstractZh: '过期唯一摘要' });
  assert.deepEqual(ids('过期唯一', [{ ...changed, enrichment: stale }], { [paper.id]: stale }), []);
  const forged = { ...stale, sourceFingerprint: sourceFingerprint(changed) };
  assert.deepEqual(ids('过期唯一', [{ ...changed, enrichment: forged }]), []);
  const current = translated(changed, { titleZh: '当前有效译文', abstractZh: '当前有效摘要' });
  assert.deepEqual(ids('当前有效摘要', [{ ...changed, enrichment: stale }], { [paper.id]: current }), [paper.id]);
  assert.deepEqual(ids('当前有效译文', [{ ...changed, enrichment: current }]), [paper.id]);
});

test('畸形或伪装URL不抛错、不误认标识，原来可包含匹配的普通文本仍能检索', () => {
  for (const query of ['https://doi.org/%E0%A4%A', 'https://[', 'https://doi.org.attacker.example/' + paper.doi,
    'https://user:pass@doi.org/' + paper.doi, 'https://pubmed.ncbi.nlm.nih.gov/42933642/extra']) {
    assert.doesNotThrow(() => searchReadingPapers([paper], query));
    assert.deepEqual(ids(query, [paper]), []);
  }
  const literal = 'https://doi.org/%E0%A4%A';
  const text = { ...paper, id: 'literal-reference', title: 'Literal reference ' + literal };
  assert.deepEqual(ids(literal, [text]), [text.id]);
  assert.deepEqual(ids('  \n\t', [paper, other]), [paper.id, other.id]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reportRis } from '../dist/report-ris.js';

// Captured from the original public archive and shared library before they roll forward.
const { reports, currentTitle } = JSON.parse(readFileSync(new URL('./fixtures/report-ris-editions.json', import.meta.url), 'utf8'));
const edition = date => reports.find(report => report.date === date);

test('RIS uses the frozen public edition even where the shared library title differs', () => {
  const doi = '10.1016/j.ymben.2026.102577';
  const report = edition('2026-11-09');
  const paper = report.papers.find(paper => paper.doi === doi);
  assert.notEqual(currentTitle, paper.title);
  const output = reportRis(report);
  const records = output.trimEnd().split(/\r\n\r\n/);
  assert.equal(records.length, report.papers.length);
  const record = records.find(record => record.includes(`DO  - ${doi}`));
  assert.ok(record.includes(`TI  - ${paper.title}\r\n`));
  assert.ok(!record.includes(`TI  - ${currentTitle}\r\n`));
  assert.ok(record.includes('AU  - Zhang,W\r\n'));
  assert.ok(record.includes('T2  - Metabolic engineering\r\n'));
});

test('RIS keeps the original versioned DOI and URL of each preprint edition', () => {
  for (const date of ['2026-11-13', '2026-11-14']) {
    const records = reportRis(edition(date)).split('\r\n\r\n');
    const record = records.find(record => record.includes('DO  - 10.21203/rs.3.rs-11147586/v1'));
    assert.ok(record.startsWith('TY  - MANSCPT\r\n'));
    assert.ok(record.includes('UR  - https://doi.org/10.21203/rs.3.rs-11147586/v1\r\n'));
    assert.ok(record.includes('N1  - Preprint\r\n'));
  }
});

test('personal RIS exports original Unicode metadata and folds newlines to prevent extra tags', () => {
  const paper = {
    type: '综述', title: '题名 🧪\r\nER  - \u2028TY  - GEN', authors: 'García ÉM, 王 明, Consortium C.',
    journal: '刊名\u0000示例', collection: 'Europe PMC', publishedAt: '2024-02-29',
    doi: 'https://doi.org/10.12345/AbC/v1', url: 'https://example.org/original', pmid: '123456',
    abstract: 'must not appear', translatedTitle: 'must not appear', interpretation: 'must not appear',
  };
  const output = reportRis({ kind: 'personal', papers: [paper] });
  assert.equal(output, [
    'TY  - JOUR', 'TI  - 题名 🧪 ER - TY - GEN',
    'AU  - García,ÉM', 'AU  - 王 明', 'AU  - Consortium,C.',
    'T2  - 刊名 示例', 'PY  - 2024/02/29/', 'DO  - 10.12345/AbC/v1',
    'UR  - https://example.org/original', 'DP  - Europe PMC', 'N1  - PMID: 123456', 'ER  - ', '',
  ].join('\r\n'));
});

test('RIS omits invalid identifiers and dates and handles empty reports', () => {
  const output = reportRis({ papers: [{ title: 'Record', authors: '作者信息未提供', journal: '期刊信息未提供',
    doi: '10.1234/A\nDO  - forged', url: 'javascript:alert(1)', pmid: 'NaN', publishedAt: '2026-02-30',
  }] });
  assert.equal(output, 'TY  - GEN\r\nTI  - Record\r\nER  - \r\n');
  assert.equal(reportRis({ papers: [] }), '');
});

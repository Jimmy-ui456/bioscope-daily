import test from 'node:test';
import assert from 'node:assert/strict';
import { publicCollectionSource, validWorkflowRunUrl, collectionSourceLabel } from '../dist/collection-source.js';

const github = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'Example-owner/bioscope.daily', GITHUB_RUN_ID: '123456789012345678' };

test('采集来源仅提取标准GitHub字段，不复制环境密钥或其他URL', () => {
  const environment = { ...github, LLM_API_KEY: 'test-secret-never-publish', GITHUB_TOKEN: 'test-token-never-publish', RUN_URL: 'https://elsewhere.example/' };
  Object.defineProperty(environment, 'UNRELATED_SECRET', { get() { throw new Error('Unrelated environment field must not be read'); } });
  const source = publicCollectionSource(environment);
  assert.deepEqual(source, { trigger: 'schedule', runUrl: 'https://github.com/Example-owner/bioscope.daily/actions/runs/123456789012345678' });
  assert.deepEqual(Object.keys(source), ['trigger', 'runUrl']);
  assert.equal(JSON.stringify(source).includes('never-publish'), false);
  assert.deepEqual(publicCollectionSource(), { trigger: 'local', runUrl: null });
  assert.deepEqual(publicCollectionSource({ ...github, GITHUB_ACTIONS: 'false' }), { trigger: 'local', runUrl: null });
  assert.equal(publicCollectionSource({ ...github, GITHUB_EVENT_NAME: 'workflow_dispatch' }).trigger, 'workflow_dispatch');
  assert.equal(publicCollectionSource({ ...github, GITHUB_EVENT_NAME: 'push' }).trigger, 'unknown');
});

test('公开任务链接只接受官方HTTPS路径，不接受凭据、危险协议或伪造主机', () => {
  const valid = 'https://github.com/Example-owner/bioscope.daily/actions/runs/123';
  assert.equal(validWorkflowRunUrl(valid), true);
  const invalid = [
    'http://github.com/owner/repo/actions/runs/123', 'javascript:alert(1)',
    'https://username:example-password@github.com/owner/repo/actions/runs/123',
    'https://github.com.evil.example/owner/repo/actions/runs/123',
    'https://elsewhere.example/owner/repo/actions/runs/123',
    'https://github.com:443/owner/repo/actions/runs/123',
    `${valid}?token=example`, `${valid}#fragment`, `${valid}/jobs/1`, `${valid}\n`,
    'https://github.com/owner/../actions/runs/123',
    'https://github.com/owner/repo/actions/runs/not-a-number',
    'https://github.com/owner%2Frepo/name/actions/runs/123', null, {},
  ];
  for (const value of invalid) assert.equal(validWorkflowRunUrl(value), false);
  for (const overrides of [
    { GITHUB_SERVER_URL: 'https://username@example.org' },
    { GITHUB_SERVER_URL: 'https://github.enterprise.example' },
    { GITHUB_REPOSITORY: 'owner/repo/actions/runs/123?x=' },
    { GITHUB_RUN_ID: '123?secret=example' }, { GITHUB_RUN_ID: 123 },
  ]) assert.equal(publicCollectionSource({ ...github, ...overrides }).runUrl, null);
});

test('采集来源标签只解释已记录触发方式，旧记录或未知触发不猜测', () => {
  assert.equal(collectionSourceLabel({ trigger: 'schedule' }), '定时采集');
  assert.equal(collectionSourceLabel({ trigger: 'workflow_dispatch' }), '手动补采');
  assert.equal(collectionSourceLabel({ trigger: 'local' }), '本地采集');
  for (const source of [undefined, null, {}, { trigger: 'unknown' }, { trigger: 'push' }, { trigger: 'toString' }, { trigger: '__proto__' }]) assert.equal(collectionSourceLabel(source), '来源未记录');
});

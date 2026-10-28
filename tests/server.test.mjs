import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveAsset } from '../server.mjs';

test('静态目录带末尾斜线时仍能找到首页和资源', () => {
  const root = path.resolve('dist');
  assert.equal(resolveAsset(root + path.sep, '/'), path.join(root, 'index.html'));
  assert.equal(resolveAsset(root + path.sep, '/app.js'), path.join(root, 'app.js'));
});
test('不能读取静态目录外的文件', () => {
  assert.equal(resolveAsset(path.resolve('dist'), '/../package.json'), null);
  assert.equal(resolveAsset(path.resolve('dist'), '/../../secrets'), null);
});

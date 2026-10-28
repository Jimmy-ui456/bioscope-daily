import test from 'node:test';
import assert from 'node:assert/strict';
import { focusSnapshot, restoreFocus, applyNavigationState, trapFocus, focusNewResults } from '../dist/accessibility.js';

function element({ id = '', tagName = 'BUTTON', data = {}, classes = [], href = null, visible = true, disabled = false, inert = false } = {}) {
  const tokens = new Set(classes), attributes = new Map();
  return {
    id, tagName, dataset: data, disabled, inert, tabIndex: 0,
    classList: { contains: name => tokens.has(name), toggle(name, enabled) { if (enabled) tokens.add(name); else tokens.delete(name); } },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return name === 'href' ? href : attributes.get(name) ?? null; },
    closest() { return this.inert ? this : null; },
    getClientRects() { return visible ? [{}] : []; },
    focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; },
  };
}
function surface(elements, { titles = [], more = null } = {}) {
  const ownerDocument = { activeElement: null };
  for (const node of elements) node.ownerDocument = ownerDocument;
  return {
    ownerDocument,
    contains: node => elements.includes(node),
    querySelectorAll: selector => selector === '.paper-card .paper-title' ? titles : elements,
    querySelector: () => more,
  };
}

test('窄屏导航关闭时隔离导航，展开时隔离背景，桌面恢复正常导航', () => {
  const nodes = Object.fromEntries(['sidebar', 'shade', 'workspace', 'trigger', 'body', 'skipLink'].map(key => [key, element()]));
  applyNavigationState({ ...nodes, narrow: true, open: false });
  assert.equal(nodes.sidebar.inert, true);
  assert.equal(nodes.sidebar.getAttribute('aria-hidden'), 'true');
  assert.equal(nodes.workspace.inert, false);
  assert.equal(nodes.trigger.getAttribute('aria-expanded'), 'false');
  applyNavigationState({ ...nodes, narrow: true, open: true });
  assert.equal(nodes.sidebar.inert, false);
  assert.equal(nodes.sidebar.classList.contains('open'), true);
  assert.equal(nodes.workspace.inert, true);
  assert.equal(nodes.skipLink.inert, true);
  assert.equal(nodes.trigger.getAttribute('aria-expanded'), 'true');
  applyNavigationState({ ...nodes, narrow: false, open: true });
  assert.equal(nodes.sidebar.inert, false);
  assert.equal(nodes.sidebar.getAttribute('aria-hidden'), 'false');
  assert.equal(nodes.workspace.inert, false);
  assert.equal(nodes.skipLink.inert, false);
  assert.equal(nodes.shade.classList.contains('open'), false);
  assert.equal(nodes.body.classList.contains('menu-open'), false);
});

test('菜单 Tab 在首尾循环，跳过禁用与不可见控件，普通中间导航不被拦截', () => {
  const first = element(), hidden = element({ visible: false }), disabled = element({ disabled: true }), middle = element(), last = element();
  const root = surface([first, hidden, disabled, middle, last]);
  let prevented = 0;
  const event = { key: 'Tab', shiftKey: false, preventDefault() { prevented++; } };
  root.ownerDocument.activeElement = last;
  assert.equal(trapFocus(event, root), true);
  assert.equal(root.ownerDocument.activeElement, first);
  event.shiftKey = true;
  assert.equal(trapFocus(event, root), true);
  assert.equal(root.ownerDocument.activeElement, last);
  root.ownerDocument.activeElement = middle;
  assert.equal(trapFocus(event, root), false);
  assert.equal(prevented, 2);
});

test('详情操作重绘后按逻辑身份恢复同一按钮，忽略状态样式及 DOI 中的特殊字符', () => {
  const data = { bookmark: 'doi:10.1234/a"[b]' };
  const old = element({ data, classes: ['button'] });
  const before = surface([old]); before.ownerDocument.activeElement = old;
  const saved = focusSnapshot(before);
  const otherAction = element({ data: { select: data.bookmark } });
  const replacement = element({ data, classes: ['button', 'on'] });
  const after = surface([otherAction, replacement]);
  assert.equal(restoreFocus(after, saved), true);
  assert.equal(after.ownerDocument.activeElement, replacement);
  assert.equal(replacement.focusOptions.preventScroll, true);
  replacement.inert = true;
  assert.equal(restoreFocus(after, saved), false);
});

test('详情关闭后的重建列表仍能区分论文标题与同篇论文的详情图标按钮', () => {
  const old = element({ data: { paper: 'doi:10.1234/abc' }, classes: ['paper-title'] });
  const before = surface([old]); before.ownerDocument.activeElement = old;
  const saved = focusSnapshot(before);
  const arrow = element({ data: { paper: old.dataset.paper } });
  const title = element({ data: { paper: old.dataset.paper }, classes: ['paper-title'] });
  const after = surface([arrow, title]);
  assert.equal(restoreFocus(after, saved), true);
  assert.equal(after.ownerDocument.activeElement, title);
});

test('页面重绘保存搜索输入框的光标选区，避免键入位置跳到开头', () => {
  const old = Object.assign(element({ id: 'search', tagName: 'INPUT' }), { selectionStart: 2, selectionEnd: 5, selectionDirection: 'forward' });
  const before = surface([old]); before.ownerDocument.activeElement = old;
  const saved = focusSnapshot(before);
  const replacement = element({ id: 'search', tagName: 'INPUT' });
  replacement.setSelectionRange = (...args) => { replacement.selection = args; };
  const after = surface([replacement]);
  assert.equal(restoreFocus(after, saved), true);
  assert.deepEqual(replacement.selection, [2, 5, 'forward']);
});

test('加载更多后把焦点交给首条新增论文，末尾移除结果后提供可用退路', () => {
  const titles = Array.from({ length: 24 }, () => element({ classes: ['paper-title'] }));
  const root = surface(titles, { titles });
  assert.equal(focusNewResults(root, 12), true);
  assert.equal(root.ownerDocument.activeElement, titles[12]);
  assert.equal(focusNewResults(root, 24), true);
  assert.equal(root.ownerDocument.activeElement, titles[23]);
  assert.equal(focusNewResults(surface([]), 0), false);
});

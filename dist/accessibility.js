const focusableSelector = 'a[href],button,input,select,textarea,summary,[tabindex]';

function canFocus(element) {
  return !!element && !element.disabled && !element.closest('[inert],[hidden]');
}

// Store logical identities rather than DOM references, which do not survive a render.
export function focusSnapshot(root, active = root?.ownerDocument?.activeElement) {
  if (!active || !root?.contains(active)) return null;
  const data = { ...active.dataset };
  if (!active.id && !Object.keys(data).length && !active.getAttribute('href')) return null;
  return {
    id: active.id || null, tagName: active.tagName, data,
    href: active.getAttribute('href'), paperTitle: active.classList.contains('paper-title'),
    selection: typeof active.selectionStart === 'number'
      ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null,
  };
}

export function restoreFocus(root, snapshot, { preventScroll = true } = {}) {
  if (!root || !snapshot) return false;
  const target = [...root.querySelectorAll(focusableSelector)].find(element => {
    if (snapshot.id) return element.id === snapshot.id;
    return element.tagName === snapshot.tagName
      && element.getAttribute('href') === snapshot.href
      && element.classList.contains('paper-title') === snapshot.paperTitle
      && Object.entries(snapshot.data).every(([key, value]) => element.dataset[key] === value);
  });
  if (!canFocus(target)) return false;
  target.focus({ preventScroll });
  if (snapshot.selection && typeof target.setSelectionRange === 'function') {
    target.setSelectionRange(snapshot.selection.start, snapshot.selection.end, snapshot.selection.direction);
  }
  return true;
}

export function applyNavigationState({ narrow, open, sidebar, shade, workspace, trigger, body, skipLink }) {
  const expanded = narrow && open;
  if (sidebar) {
    sidebar.inert = narrow && !expanded;
    sidebar.setAttribute('aria-hidden', String(sidebar.inert));
    sidebar.classList.toggle('open', expanded);
  }
  if (workspace) workspace.inert = expanded;
  if (skipLink) skipLink.inert = expanded;
  shade?.classList.toggle('open', expanded);
  trigger?.setAttribute('aria-expanded', String(expanded));
  body?.classList.toggle('menu-open', expanded);
}

export function trapFocus(event, container) {
  if (event.key !== 'Tab' || !container) return false;
  const elements = [...container.querySelectorAll(focusableSelector)]
    .filter(element => canFocus(element) && element.tabIndex >= 0 && element.getClientRects().length);
  if (!elements.length) { event.preventDefault(); return true; }
  const active = container.ownerDocument.activeElement;
  const first = elements[0], last = elements.at(-1);
  if (!container.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  }
  return false;
}

export function focusNewResults(container, previousCount) {
  if (!container) return false;
  const titles = container.querySelectorAll('.paper-card .paper-title');
  const target = titles[previousCount] || container.querySelector('[data-action="more"]') || titles[titles.length - 1];
  if (!canFocus(target)) return false;
  target.focus();
  return true;
}

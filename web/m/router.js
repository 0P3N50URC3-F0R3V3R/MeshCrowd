import { createNavStack, popAction } from './lib/navStack.mjs';
import { hasOpenSheet, closeTopSheet } from './components/bottomSheet.js';

const views = new Map();
const stack = createNavStack({ name: 'tab', params: {} });
const nodes = []; // { el, handle } parallel to the stack
let host = null;

export const registerView = (name, mount) => views.set(name, mount);

function mountTop(screen) {
  const mount = views.get(screen.name);
  const el = document.createElement('div');
  el.className = 'm-screen';
  host.appendChild(el);
  nodes.push({ el, handle: (mount && mount(el, screen.params)) || {} });
}
function destroyTop() {
  const n = nodes.pop();
  n.handle.destroy?.();
  n.el.remove();
}

stack.subscribe(({ kind, top, depth }) => {
  if (kind === 'push') { nodes[nodes.length - 1]?.handle.onHide?.(); mountTop(top); }
  else if (kind === 'pop') { while (nodes.length > depth) destroyTop(); }
  else if (kind === 'replace') { destroyTop(); mountTop(top); }
  else if (kind === 'reset') { while (nodes.length) destroyTop(); mountTop(top); }
  nodes.forEach((n, i) => { n.el.hidden = i !== nodes.length - 1; });
  nodes[nodes.length - 1]?.handle.onShow?.();
});

export const nav = {
  depth: () => stack.depth(),
  push(name, params = {}) {
    closeTopSheet();
    stack.push({ name, params });
    history.pushState({ d: stack.depth() }, '');
  },
  replace(name, params = {}) { closeTopSheet(); stack.replace({ name, params }); },
  back() { history.back(); },
};

export function initRouter(el) {
  host = el;
  // history: [d0 sentinel][d1 root][d2 ...]; back from d1 lands on the sentinel, which exits the app.
  history.replaceState({ d: 0 }, '');
  history.pushState({ d: 1 }, '');
  window.addEventListener('popstate', (e) => {
    const d = e.state && typeof e.state.d === 'number' ? e.state.d : 1;
    const action = popAction({ d, depth: stack.depth(), sheetOpen: hasOpenSheet() });
    if (action === 'closeSheet') { closeTopSheet(); history.pushState({ d: stack.depth() }, ''); }
    else if (action === 'exit') history.back();
    else if (action === 'recover') { stack.popTo(1); history.pushState({ d: 1 }, ''); }
    else if (action === 'popTo') stack.popTo(d);
  });
  // The Android shell asks the page first on every back press; true = the page used it.
  window.__mcBack = () => {
    const overlays = document.querySelectorAll('body > .overlay, body > .settings-overlay');
    const top = overlays[overlays.length - 1];
    if (top) {
      const x = top.querySelector('#sc-close, [data-close]');
      if (x) { x.click(); return true; }
      top.remove();
      return true;
    }
    if (hasOpenSheet()) { closeTopSheet(); return true; }
    if (stack.depth() > 1) { history.back(); return true; }
    return window.__mcTabBack?.() ?? false;
  };
  stack.reset({ name: 'tab', params: {} });
}

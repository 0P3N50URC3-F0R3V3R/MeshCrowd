export function createNavStack(root) {
  const stack = [root];
  const listeners = new Set();
  const emit = (kind) => {
    const info = { kind, top: stack[stack.length - 1], depth: stack.length };
    for (const fn of [...listeners]) fn(info);
  };
  return {
    top: () => stack[stack.length - 1],
    depth: () => stack.length,
    push(screen) { stack.push(screen); emit('push'); },
    pop() { if (stack.length <= 1) return false; stack.pop(); emit('pop'); return true; },
    popTo(depth) { if (depth < 1 || depth >= stack.length) return false; stack.length = depth; emit('pop'); return true; },
    replace(screen) { stack[stack.length - 1] = screen; emit('replace'); },
    reset(screen) { stack.length = 0; stack.push(screen); emit('reset'); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// What a popstate means. d is the history entry we landed on (0 = the sentinel below the root).
export function popAction({ d, depth, sheetOpen }) {
  if (sheetOpen) return 'closeSheet';
  if (d === 0) return depth > 1 ? 'recover' : 'exit';
  return d < depth ? 'popTo' : 'none';
}

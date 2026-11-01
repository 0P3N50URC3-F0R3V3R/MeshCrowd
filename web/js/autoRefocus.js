import { isTextField, focusWasLost, isSendButton, restoreTarget } from './autoRefocus.mjs';

// One delegated mechanism instead of per-input .focus() calls: remember the text field the user was
// typing in, and when they submit it (Enter, or a send/save/post-style button next to it) hand focus
// back if the submit left it nowhere — new inputs inherit this with no extra wiring.
let last = null;
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

function describe(el) {
  return { el, id: el.id, placeholder: el.getAttribute('placeholder'), tag: el.tagName, box: el.closest('form, .composer, .m-composer-row, .modal, .m-sheet, .search-box') || el.parentElement };
}

function restore(info, button) {
  const a = document.activeElement;
  if (!focusWasLost(a, document.body, button)) return;
  const target = restoreTarget(info, document);
  if (!target) return;
  const dialogs = document.querySelectorAll('.overlay, .m-sheet-back');
  const dialog = dialogs[dialogs.length - 1];
  if (dialog && !dialog.contains(target)) return;
  target.focus({ preventScroll: true });
}

function schedule(info, button) {
  for (const ms of [80, 700]) setTimeout(() => restore(info, button), ms);
}

if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => { if (isTextField(e.target)) last = describe(e.target); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || !isTextField(e.target)) return;
    schedule(describe(e.target), null);
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('button, [role="button"]');
    if (!btn || !last || !last.box?.contains(btn)) return;
    if (!isSendButton(btn, coarse)) return;
    schedule(last, btn);
  });
}

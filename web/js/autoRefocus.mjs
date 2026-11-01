const TEXT_TYPES = /^(text|search|url|email|number|tel|password)?$/i;
const SEND = /send|submit|save|post|reply|comment|search|update|create|rename|confirm|add|ok\b/i;
const NOT_SEND = /cancel|close|back|dismiss|remove|delete|emoji|sticker|gif|attach|poll|voice|mic|schedule|file|plus/i;
const SEND_COARSE = /send|submit|save|post/i;

export function isTextField(el) {
  if (!el || el.disabled || el.readOnly) return false;
  return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_TYPES.test(el.type || ''));
}

export function focusWasLost(active, body, button) {
  return !active || active === body || active === button || !!active.disabled || active.isConnected === false;
}

export function isSendButton(btn, coarse = false) {
  const label = `${btn.id || ''} ${btn.className || ''} ${btn.getAttribute?.('data-action') || ''}`;
  if (btn.hasAttribute?.('data-no-refocus') || NOT_SEND.test(label)) return false;
  if (btn.type === 'submit') return true;
  return (coarse ? SEND_COARSE : SEND).test(label);
}

export function restoreTarget(info, doc) {
  if (info.el.isConnected) return isTextField(info.el) ? info.el : null;
  let found = null;
  if (info.id) found = doc.getElementById(info.id);
  else if (info.placeholder) found = doc.querySelector(`${info.tag.toLowerCase()}[placeholder="${CSS.escape(info.placeholder)}"]`);
  return isTextField(found) ? found : null;
}

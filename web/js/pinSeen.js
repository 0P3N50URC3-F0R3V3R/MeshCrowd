import { api } from './api.js';
import { clearPinUnseen, pinUnseen } from './state.js';

export function markPinsSeen(scopeType, scopeId) {
  if (!pinUnseen(scopeType, scopeId)) return;
  clearPinUnseen(scopeType, scopeId, new Date().toISOString());
  api.markPinsSeen(scopeType, scopeId).catch(() => {});
}

import { state } from '../../js/state.js';
import { memberPermissionBits, channelPermissionBits, has, PERMISSIONS } from '../../js/permissions.js';
import { toggleChecklistItem, openChecklistForm } from '../../js/checklist.js';
import { handleError } from '../lib/errors.js';
import { openSheet } from './bottomSheet.js';

export { checklistHtml } from '../../js/checklist.js';

export function onChecklistClick(target, msg, ctx) {
  if (!msg.checklist) return false;
  if (target.closest('[data-cl-edit]')) { openChecklistSheet(ctx, msg); return true; }
  const toggle = target.closest('[data-cl-toggle]');
  if (toggle) {
    toggleChecklistItem(msg.checklist, Number(toggle.dataset.clToggle))?.catch((err) => handleError(err, 'checklist.couldNotCheck'));
    return true;
  }
  return false;
}

function helperCandidates(ctx) {
  if (ctx.kind === 'dm') return (ctx.dm?.members || []).map((u) => ({ id: u.id, name: u.displayName }));
  const { detail, channel } = ctx;
  if (!detail || !channel) return [];
  return detail.members.filter((m) => m.user.id !== state.me.id && !m.user.isBot).filter((m) => {
    const bits = memberPermissionBits(detail.server, detail.roles, m, m.user.id);
    return has(channelPermissionBits(channel, detail.roles, m, bits, detail.server.owner_id === m.user.id), PERMISSIONS.VIEW_CHANNEL);
  }).map((m) => ({ id: m.user.id, name: m.nickname || m.user.displayName }));
}

// message omitted = create a new checklist in ctx's scope, given = edit that one
export function openChecklistSheet(ctx, message) {
  openChecklistForm({
    openPanel: openSheet,
    members: helperCandidates(ctx),
    meId: state.me.id,
    ...(message ? { mode: 'edit', message } : { mode: 'create', scope: { scopeType: ctx.scopeType, scopeId: ctx.scopeId } }),
  });
}

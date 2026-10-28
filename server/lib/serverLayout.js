'use strict';

const { singleLine } = require('./textSanitize');

const FOLDER_COLORS = new Set(['#0d9488', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f0b232', '#00a8fc', '#f97316', '#99aab5']);

// Kept in sync with web/js/icons.js's FOLDER_BUILTIN_ICONS by hand — client and server are
// separate module systems (ESM browser vs CJS server) here, same as the PERMISSIONS bitflags
// being defined once per side rather than shared, so this mirrors that existing pattern.
const FOLDER_BUILTIN_ICONS = new Set(['star', 'heart', 'gamepad', 'zap', 'music', 'book', 'briefcase', 'globe', 'flag', 'camera', 'rocket']);

// An uploaded folder icon's path must look exactly like what POST /me/folder-icon hands back —
// rejects path traversal and, since a folder is just client-submitted JSON, a crafted `value`
// trying to point the icon at an arbitrary external URL instead of an uploaded file.
const FOLDER_IMAGE_PATH_RE = /^\/uploads\/foldericons\/[A-Za-z0-9_.-]+$/;

// Validates/normalizes one folder's `icon` field down to a known-safe shape. Anything
// unrecognized falls back to 'auto' (the mini-grid-of-member-icons default) rather than being
// dropped/erroring, so a client sending a stale or malformed icon just loses that customization.
function sanitizeFolderIcon(icon) {
  if (!icon || typeof icon !== 'object') return { kind: 'auto' };
  if (icon.kind === 'builtin' && FOLDER_BUILTIN_ICONS.has(icon.value)) return { kind: 'builtin', value: icon.value };
  if (icon.kind === 'image' && typeof icon.value === 'string' && FOLDER_IMAGE_PATH_RE.test(icon.value)) return { kind: 'image', value: icon.value };
  return { kind: 'auto' };
}

// Validates/normalizes a client-submitted server-rail layout against the set of server ids the
// user is actually a member of. Pure function (no db access) so it's directly testable — the
// route just wires in the real membership set.
function sanitizeServerLayout(layout, myServerIds) {
  if (!Array.isArray(layout)) return [];
  const cleaned = [];
  for (const entry of layout.slice(0, 200)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'server') {
      const id = Number(entry.id);
      if (myServerIds.has(id)) cleaned.push({ type: 'server', id });
    } else if (entry.type === 'folder') {
      const servers = Array.isArray(entry.servers)
        ? [...new Set(entry.servers.map(Number))].filter((id) => myServerIds.has(id))
        : [];
      if (servers.length === 0) continue; // an emptied-out folder just disappears
      cleaned.push({
        type: 'folder',
        id: String(entry.id || '').slice(0, 64) || `f${Date.now()}`,
        name: singleLine(entry.name, 48) || 'Folder',
        color: FOLDER_COLORS.has(entry.color) ? entry.color : '#0d9488',
        icon: sanitizeFolderIcon(entry.icon),
        servers,
      });
    }
  }
  return cleaned;
}

module.exports = { sanitizeServerLayout, sanitizeFolderIcon, FOLDER_COLORS, FOLDER_BUILTIN_ICONS };

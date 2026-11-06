// Pure helpers for stickers outside the per-server channel flow (DMs, previews).
const PATH_RE = /^\/uploads\/stickers\/[0-9a-f]{20}\.(png|jpg|gif|webp)$/;
const NAME_RE = /^[a-zA-Z0-9_]{2,32}$/;

export function stickerRef(sticker) {
  if (!sticker) return null;
  return { id: sticker.id, name: sticker.name, imagePath: sticker.imagePath || sticker.image_path };
}

export function normalizeSticker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isSafeInteger(raw.id) || raw.id <= 0) return null;
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) return null;
  if (typeof raw.imagePath !== 'string' || !PATH_RE.test(raw.imagePath)) return null;
  return { id: raw.id, name: raw.name, imagePath: raw.imagePath };
}

// One-line text for a message in lists, previews and notifications.
export function previewText({ text, sticker, hasAttachments }, labels) {
  if (text) return text;
  if (sticker) return labels.sticker;
  return hasAttachments ? labels.attachment : '';
}

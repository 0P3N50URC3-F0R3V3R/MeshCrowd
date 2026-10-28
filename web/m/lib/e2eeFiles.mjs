// Mirrors the desktop rule: only small raster images are shown inline (never SVG or HTML);
// every other encrypted attachment is an opaque download chip.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const INLINE_MAX_BYTES = 16 * 1024 * 1024;

export const e2eeFileKind = (f) => (INLINE_TYPES.has(f.type) && f.size <= INLINE_MAX_BYTES ? 'image' : 'file');

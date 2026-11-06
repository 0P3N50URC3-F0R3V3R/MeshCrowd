// Bio markup: **bold**, *italic*, [#rrggbb]colored text[/]. Everything else is plain text; the
// renderer escapes first and only ever emits <b>, <i> and a validated color style.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const COLOR = /\[(#[0-9a-fA-F]{6})\]([^[\]]*?)\[\/\]/g;
const BOLD = /\*\*([^*]+?)\*\*/g;
const ITALIC = /\*([^*]+?)\*/g;

export function renderBio(text) {
  return esc(String(text || ''))
    .replace(COLOR, (_, c, t) => `<span style="color:${c}">${t}</span>`)
    .replace(BOLD, '<b>$1</b>')
    .replace(ITALIC, '<i>$1</i>');
}

export function bioPlain(text) {
  return String(text || '').replace(COLOR, '$2').replace(BOLD, '$1').replace(ITALIC, '$1');
}

// Wraps [start, end) of `value` for one toolbar action and returns the new value and selection.
export function applyFormat(value, start, end, kind, color) {
  const open = kind === 'bold' ? '**' : kind === 'italic' ? '*' : `[${color}]`;
  const close = kind === 'bold' ? '**' : kind === 'italic' ? '*' : '[/]';
  const picked = value.slice(start, end) || '';
  const out = value.slice(0, start) + open + picked + close + value.slice(end);
  return { value: out, selStart: start + open.length, selEnd: start + open.length + picked.length };
}

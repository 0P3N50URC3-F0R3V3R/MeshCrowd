const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `text` is already HTML-escaped. Names may hold spaces or non-ASCII letters, so match known names
// (longest first) instead of guessing a token shape; unknown #words stay plain text.
export function linkChannelRefs(text, channels, label) {
  if (!channels || !channels.length) return text;
  const byName = new Map();
  for (const c of channels) if (!byName.has(esc(c.name).toLowerCase())) byName.set(esc(c.name).toLowerCase(), c);
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![&\\w])#(${names.map(reEscape).join('|')})(?![\\p{L}\\p{N}_-])`, 'giu');
  return text.replace(re, (m, name) => {
    const ch = byName.get(name.toLowerCase());
    const aria = esc(label(ch.name));
    return `<span class="channel-ref" role="link" tabindex="0" data-channel-id="${ch.id}" title="${aria}" aria-label="${aria}">#${esc(ch.name)}</span>`;
  });
}

// Argument parsing for the /poll and /checklist slash commands (shared by desktop and phone, no DOM).
//   /poll Question | Option A | Option B [| ...] [--multi]
//   /checklist Title | Item 1 | Item 2 [| ...]
// Limits mirror the server: a poll takes 2-10 options, a checklist 1-50 items.

export const POLL_MAX_OPTIONS = 10;
export const CHECKLIST_MAX_ITEMS = 50;

const parts = (text) => text.split('|').map((s) => s.trim()).filter(Boolean);

export function parsePollArgs(rest) {
  let text = String(rest || '');
  const multiSelect = /(^|\s)--multi\s*$/i.test(text);
  if (multiSelect) text = text.replace(/(^|\s)--multi\s*$/i, '');
  const [question, ...options] = parts(text);
  if (!question) return { ok: false, error: 'usage' };
  const unique = [...new Set(options)];
  if (unique.length < 2 || unique.length > POLL_MAX_OPTIONS) return { ok: false, error: 'options' };
  return { ok: true, question, options: unique, multiSelect };
}

export function parseChecklistArgs(rest) {
  const [title, ...items] = parts(String(rest || ''));
  if (!title) return { ok: false, error: 'usage' };
  if (items.length < 1 || items.length > CHECKLIST_MAX_ITEMS) return { ok: false, error: 'items' };
  return { ok: true, title, items };
}

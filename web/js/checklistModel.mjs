// Pure checklist helpers shared by the desktop and mobile UIs (no DOM, so they run under node --test).

// 'edit' = creator or edit helper, 'check' = tick-only helper, null = view only.
export function checklistLevel(cl, meId) {
  if (!cl) return null;
  if (cl.creatorId === meId) return 'edit';
  return (cl.editors || []).find((e) => e.userId === meId)?.level || null;
}

export function checklistProgress(cl) {
  const total = cl.items.length;
  return { done: cl.items.filter((i) => i.checked).length, total };
}

// Swap rows[i] with its neighbour; returns a new array (unchanged when the move would leave the list).
export function moveRow(rows, i, dir) {
  const j = i + dir;
  if (i < 0 || i >= rows.length || j < 0 || j >= rows.length) return rows;
  const out = rows.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// A DM has no server of its own: a :name: resolves against the servers of whoever wrote it, so
// everyone in the conversation sees the same image. `list` is GET /api/dms/:id/emoji.
function dedupe(list) {
  const seen = new Set();
  return list.filter((e) => {
    const key = e.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const emojiFor = (list, userId) => dedupe(list.filter((e) => e.userIds.includes(userId)));

export const emojiForReaction = (list, reaction) => {
  const first = reaction.userIds[0];
  return dedupe([...list.filter((e) => e.userIds.includes(first)), ...list]);
};

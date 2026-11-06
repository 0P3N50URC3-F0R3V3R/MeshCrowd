export function dmPreview(dm, { attachmentLabel, stickerLabel }) {
  const m = dm.lastMessage;
  if (!m) return '';
  return m.content || (m.sticker ? stickerLabel : '') || (m.attachments?.length ? attachmentLabel : '');
}

export function dmTitle(dm, nameFor) {
  if (dm.isGroup) return dm.name || dm.members.map((u) => nameFor(u)).join(', ');
  return nameFor(dm.members[0] || dm.closedBy);
}

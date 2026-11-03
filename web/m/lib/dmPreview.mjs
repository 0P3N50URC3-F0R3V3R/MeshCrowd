export function dmPreview(dm, { peek, encryptedLabel, attachmentLabel, stickerLabel }) {
  const m = dm.lastMessage;
  if (!m) return '';
  if (m.isEncrypted) {
    const plain = peek(m.id);
    return plain?.text || (plain?.sticker ? stickerLabel : '') || encryptedLabel;
  }
  return m.content || (m.sticker ? stickerLabel : '') || (m.attachments?.length ? attachmentLabel : '');
}

export function dmTitle(dm, nameFor) {
  if (dm.isGroup) return dm.name || dm.members.map((u) => nameFor(u)).join(', ');
  return nameFor(dm.members[0] || dm.closedBy);
}

// Text safe to show for a message: an encrypted message is only shown once decryption succeeded.
export function messageText(m, failedLabel) {
  if (m.decryptFailed || (m.isEncrypted && m.decryptFailed !== false)) return failedLabel;
  return m.content || '';
}

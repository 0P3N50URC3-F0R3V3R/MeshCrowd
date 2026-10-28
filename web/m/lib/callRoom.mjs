// Identity of a voice room and whether the signed-in user is currently in it. Kept free of DOM and
// state imports so it can be unit tested.
export const roomKey = (p) => (p.kind === 'dm' || p.dmId ? `dm:${p.dmId}` : `ch:${p.channelId}`);

export function isJoinedTo(key, voice) {
  if (!key || !voice) return false;
  const [type, id] = key.split(':');
  return type === 'dm' ? voice.dmId === Number(id) : voice.channelId === Number(id);
}

// A room stays alive in the background only while the user is actually joined to it.
export const shouldKeepAlive = (key, voice) => isJoinedTo(key, voice);

export function callBarModel({ key, voice, screenVisible, label }) {
  if (!isJoinedTo(key, voice) || screenVisible) return null;
  return { label, muted: !!voice.muted };
}

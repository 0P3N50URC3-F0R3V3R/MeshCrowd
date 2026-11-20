// A friend in a voice channel the viewer cannot see arrives as a generic entry without channel or
// server names/ids; only entries carrying a numeric channel id and a name are navigable.
export function friendVoiceView(ch) {
  const channelId = Number(ch?.id);
  const serverId = Number(ch?.serverId);
  const name = typeof ch?.name === 'string' ? ch.name : '';
  if (!Number.isFinite(channelId) || !Number.isFinite(serverId) || !name) return { generic: true };
  return { generic: false, channelId, serverId, name, serverName: typeof ch.serverName === 'string' ? ch.serverName : '' };
}

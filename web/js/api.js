// Thin fetch wrappers over the Dismesh REST API. All calls are same-origin,
// credentials always included so the httpOnly session cookie is sent.

class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, { json, form, query } = {}) {
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  const opts = { method, credentials: 'include' };
  if (form) {
    opts.body = form;
  } else if (json !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(json);
  }

  const res = await fetch(url, opts);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

const get = (path, query) => request('GET', path, { query });
const post = (path, json) => request('POST', path, { json });
const patch = (path, json) => request('PATCH', path, { json });
const del = (path) => request('DELETE', path);
const put = (path, json) => request('PUT', path, { json });
const postForm = (path, form) => request('POST', path, { form });

export const api = {
  ApiError,

  // config
  config: () => get('/api/config'),
  voiceIce: () => get('/api/voice/ice'),

  // auth
  register: (payload) => post('/api/auth/register', payload),
  login: (payload) => post('/api/auth/login', payload),
  login2fa: (pendingToken, code) => post('/api/auth/login/2fa', { pendingToken, code }),
  loginParams: (username) => get('/api/auth/login-params', { username }),
  upgradeCredentials: (body) => post('/api/auth/upgrade-credentials', body),
  setup2fa: () => post('/api/auth/2fa/setup'),
  enable2fa: (code) => post('/api/auth/2fa/enable', { code }),
  disable2fa: (code) => post('/api/auth/2fa/disable', { code }),
  logout: () => post('/api/auth/logout'),
  me: () => get('/api/auth/me'),

  // users
  getLanguages: () => get('/api/languages'),
  getMyLanguage: () => get('/api/users/me/language'),
  setMyLanguage: (code) => put('/api/users/me/language', { code }),
  updateMe: (payload) => patch('/api/users/me', payload),
  getServerLayout: () => get('/api/users/me/server-layout'),
  setServerLayout: (layout) => put('/api/users/me/server-layout', { layout }),
  getTheme: () => get('/api/users/me/theme'),
  setTheme: (theme) => put('/api/users/me/theme', { theme }),
  getUiPrefs: () => get('/api/users/me/ui-prefs'),
  setUiPrefs: (prefs) => put('/api/users/me/ui-prefs', prefs),
  uploadFolderIcon: (file) => { const fd = new FormData(); fd.append('icon', file); return postForm('/api/users/me/folder-icon', fd); },
  uploadAvatar: (file) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return postForm('/api/users/me/avatar', fd);
  },
  setStatus: (payload) => put('/api/users/me/status', payload),
  uploadBanner: (file) => { const fd = new FormData(); fd.append('banner', file); return postForm('/api/users/me/banner', fd); },
  deleteBanner: () => del('/api/users/me/banner'),
  uploadCard: (file) => { const fd = new FormData(); fd.append('card', file); return postForm('/api/users/me/card', fd); },
  deleteCard: () => del('/api/users/me/card'),
  getUser: (id) => get(`/api/users/${id}`),
  searchUsers: (q) => get('/api/users/search', { q }),
  setE2eePublicKey: (publicKey) => put('/api/users/me/e2ee-key', { publicKey }),
  setE2eeBackup: (backup) => put('/api/users/me/e2ee-backup', backup),
  getE2eeBackup: () => get('/api/users/me/e2ee-backup'),
  passportChallenge: () => post('/api/passport/challenge', {}),
  passportRegister: (body) => post('/api/passport/register', body),
  passportLogin: (body) => post('/api/passport/login', body),
  passportRecover: (body) => post('/api/passport/recover', body),
  passportAttach: (body) => post('/api/passport/attach', body),
  changePassword: (body) => post('/api/auth/change-password', body),
  verifyPassword: (body) => post('/api/auth/verify-password', body),

  // friends
  friends: () => get('/api/friends'),
  friendRequest: (username) => post('/api/friends/request', { username }),
  friendAccept: (userId) => post(`/api/friends/${userId}/accept`),
  friendBlock: (userId) => post(`/api/friends/${userId}/block`),
  friendRemove: (userId) => del(`/api/friends/${userId}`),
  friendsVoiceActivity: () => get('/api/friends/activity/voice'),
  serverVoiceActivity: (serverId) => get(`/api/servers/${serverId}/voice-activity`),

  // servers
  createServer: (payload) => post('/api/servers', typeof payload === 'string' ? { name: payload } : payload),
  listServers: () => get('/api/servers'),
  joinServer: (inviteCode) => post('/api/servers/join', { inviteCode }),
  discoverServers: (q) => get('/api/servers/discover', { q }),
  joinPublicServer: (id) => post(`/api/servers/${id}/join-public`),
  getServer: (id) => get(`/api/servers/${id}`),
  updateServer: (id, payload) => patch(`/api/servers/${id}`, payload),
  deleteServer: (id) => del(`/api/servers/${id}`),
  leaveServer: (id) => post(`/api/servers/${id}/leave`),
  uploadServerIcon: (id, file) => {
    const fd = new FormData();
    fd.append('icon', file);
    return postForm(`/api/servers/${id}/icon`, fd);
  },
  regenerateInvite: (id) => post(`/api/servers/${id}/invite/regenerate`),
  // sites (PHP intranet servers)
  siteCreate: (payload) => post('/api/sites', payload),
  siteGet: (id) => get(`/api/sites/${id}`),
  siteUpdate: (id, payload) => patch(`/api/sites/${id}`, payload),
  siteDelete: (id) => del(`/api/sites/${id}`),
  siteRuntime: () => get('/api/sites/runtime'),
  siteFiles: (id) => get(`/api/sites/${id}/files`),
  siteReadFile: (id, path) => get(`/api/sites/${id}/files/content`, { path }),
  siteWriteFile: async (id, path, data, { mtimeMs, force } = {}) => {
    const qs = new URLSearchParams({ path });
    if (mtimeMs != null) qs.set('mtime', String(mtimeMs));
    if (force) qs.set('force', '1');
    const res = await fetch(`/api/sites/${id}/files/content?${qs}`, {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/octet-stream' }, body: data,
    });
    const body = (res.headers.get('content-type') || '').includes('application/json') ? await res.json().catch(() => null) : null;
    if (!res.ok) throw new ApiError(res.status, body);
    return body;
  },
  siteMkdir: (id, path) => post(`/api/sites/${id}/files/mkdir`, { path }),
  siteRename: (id, from, to) => post(`/api/sites/${id}/files/rename`, { from, to }),
  siteRemoveFile: (id, path) => del(`/api/sites/${id}/files?path=${encodeURIComponent(path)}`),
  getAuditLog: (id, before) => get(`/api/servers/${id}/audit-log`, before ? { before } : {}),
  setChannelSlowmode: (serverId, channelId, seconds) => put(`/api/servers/${serverId}/channels/${channelId}/slowmode`, { seconds }),
  timeoutMember: (serverId, userId, minutes) => put(`/api/servers/${serverId}/members/${userId}/timeout`, { minutes }),
  clearMemberTimeout: (serverId, userId) => del(`/api/servers/${serverId}/members/${userId}/timeout`),
  invitePeek: (code) => get(`/api/invites/${encodeURIComponent(code)}`),
  joinChannelInvite: (code) => post(`/api/servers/channel-invites/${code}/join`),
  directInviteToChannel: (serverId, channelId, userId) => post(`/api/servers/${serverId}/channels/${channelId}/invites/direct`, { userId }),
  listChannelInvites: (serverId, channelId) => get(`/api/servers/${serverId}/channels/${channelId}/invites`),
  createChannelInvite: (serverId, channelId, payload) => post(`/api/servers/${serverId}/channels/${channelId}/invites`, payload),
  revokeChannelInvite: (serverId, channelId, inviteId) => del(`/api/servers/${serverId}/channels/${channelId}/invites/${inviteId}`),

  // channels
  createChannel: (serverId, payload) => post(`/api/servers/${serverId}/channels`, payload),
  updateChannel: (serverId, channelId, payload) => patch(`/api/servers/${serverId}/channels/${channelId}`, payload),
  deleteChannel: (serverId, channelId) => del(`/api/servers/${serverId}/channels/${channelId}`),
  setChannelOverride: (serverId, channelId, roleId, payload) =>
    put(`/api/servers/${serverId}/channels/${channelId}/overrides/${roleId}`, payload),
  uploadChannelIcon: (serverId, channelId, file) => {
    const fd = new FormData();
    fd.append('icon', file);
    return postForm(`/api/servers/${serverId}/channels/${channelId}/icon`, fd);
  },

  // webhooks (channel-scoped, MANAGE_CHANNELS)
  listWebhooks: (serverId, channelId) => get(`/api/servers/${serverId}/channels/${channelId}/webhooks`),
  createWebhook: (serverId, channelId, name) => post(`/api/servers/${serverId}/channels/${channelId}/webhooks`, { name }),
  deleteWebhook: (serverId, channelId, webhookId) => del(`/api/servers/${serverId}/channels/${channelId}/webhooks/${webhookId}`),
  regenerateWebhookToken: (serverId, channelId, webhookId) => post(`/api/servers/${serverId}/channels/${channelId}/webhooks/${webhookId}/regenerate`),
  uploadWebhookIcon: (serverId, channelId, webhookId, file) => {
    const fd = new FormData();
    fd.append('icon', file);
    return postForm(`/api/servers/${serverId}/channels/${channelId}/webhooks/${webhookId}/icon`, fd);
  },

  // channel categories
  createCategory: (serverId, payload) => post(`/api/servers/${serverId}/categories`, payload),
  updateCategory: (serverId, categoryId, payload) => patch(`/api/servers/${serverId}/categories/${categoryId}`, payload),
  deleteCategory: (serverId, categoryId) => del(`/api/servers/${serverId}/categories/${categoryId}`),

  // welcome screen
  addWelcomeChannel: (serverId, payload) => post(`/api/servers/${serverId}/welcome-channels`, payload),
  updateWelcomeChannel: (serverId, wcId, payload) => patch(`/api/servers/${serverId}/welcome-channels/${wcId}`, payload),
  removeWelcomeChannel: (serverId, wcId) => del(`/api/servers/${serverId}/welcome-channels/${wcId}`),

  // scheduled events (server-wide, MANAGE_SERVER to create/edit/delete; RSVP open to any member)
  listEvents: (serverId) => get(`/api/servers/${serverId}/events`),
  createEvent: (serverId, payload) => post(`/api/servers/${serverId}/events`, payload),
  updateEvent: (serverId, eventId, payload) => patch(`/api/servers/${serverId}/events/${eventId}`, payload),
  deleteEvent: (serverId, eventId) => del(`/api/servers/${serverId}/events/${eventId}`),
  rsvpEvent: (serverId, eventId) => put(`/api/servers/${serverId}/events/${eventId}/rsvp`),
  unrsvpEvent: (serverId, eventId) => del(`/api/servers/${serverId}/events/${eventId}/rsvp`),

  // custom emoji
  uploadCustomEmoji: (serverId, name, file) => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('image', file);
    return postForm(`/api/servers/${serverId}/emoji`, fd);
  },
  deleteCustomEmoji: (serverId, emojiId) => del(`/api/servers/${serverId}/emoji/${emojiId}`),

  // stickers (per-server, MANAGE_SERVER)
  uploadSticker: (serverId, name, description, file) => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('description', description || '');
    fd.append('image', file);
    return postForm(`/api/servers/${serverId}/stickers`, fd);
  },
  deleteSticker: (serverId, stickerId) => del(`/api/servers/${serverId}/stickers/${stickerId}`),

  // stickers (site-admin, MANAGE_ANY_SERVER — any server, not just ones you're a member of)
  adminListServers: () => get('/api/admin/servers'),
  adminListStickers: (serverId) => get(`/api/admin/servers/${serverId}/stickers`),
  adminUploadSticker: (serverId, name, description, file) => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('description', description || '');
    fd.append('image', file);
    return postForm(`/api/admin/servers/${serverId}/stickers`, fd);
  },
  adminDeleteSticker: (serverId, stickerId) => del(`/api/admin/servers/${serverId}/stickers/${stickerId}`),

  // AI providers and bots (site-admin, MANAGE_AI) and per-server bots (MANAGE_BOTS)
  adminListAiProviders: () => get('/api/admin/ai/providers'),
  adminCreateAiProvider: (body) => post('/api/admin/ai/providers', body),
  adminUpdateAiProvider: (id, body) => patch(`/api/admin/ai/providers/${id}`, body),
  adminDeleteAiProvider: (id) => del(`/api/admin/ai/providers/${id}`),
  adminTestAiProvider: (body) => post('/api/admin/ai/providers/test', body),
  adminListAiServers: () => get('/api/admin/ai/servers'),
  adminListAiBots: () => get('/api/admin/ai/bots'),
  adminCreateAiBot: (body) => post('/api/admin/ai/bots', body),
  adminUpdateAiBot: (id, body) => patch(`/api/admin/ai/bots/${id}`, body),
  adminDeleteAiBot: (id) => del(`/api/admin/ai/bots/${id}`),
  adminUploadAiBotAvatar: (id, file) => { const fd = new FormData(); fd.append('avatar', file); return postForm(`/api/admin/ai/bots/${id}/avatar`, fd); },
  listServerTemplates: (serverId) => get(`/api/servers/${serverId}/templates`),
  createServerTemplate: (serverId, body) => post(`/api/servers/${serverId}/templates`, body),
  syncServerTemplate: (serverId, id) => post(`/api/servers/${serverId}/templates/${id}/sync`, {}),
  deleteServerTemplate: (serverId, id) => del(`/api/servers/${serverId}/templates/${id}`),
  useTemplate: (code, body) => post(`/api/templates/${encodeURIComponent(code)}/use`, body),
  getServerInsights: (serverId, days) => get(`/api/servers/${serverId}/insights`, { days }),
  listScheduled: () => get('/api/scheduled'),
  createScheduled: (body) => post('/api/scheduled', body),
  cancelScheduled: (id) => del(`/api/scheduled/${id}`),
  listReactionRoles: (serverId) => get(`/api/servers/${serverId}/reaction-roles`),
  createReactionRole: (serverId, body) => post(`/api/servers/${serverId}/reaction-roles`, body),
  deleteReactionRole: (serverId, id) => del(`/api/servers/${serverId}/reaction-roles/${id}`),
  getOnboarding: (serverId) => get(`/api/servers/${serverId}/onboarding`),
  saveOnboarding: (serverId, body) => put(`/api/servers/${serverId}/onboarding`, body),
  acceptOnboarding: (serverId, answers) => post(`/api/servers/${serverId}/onboarding/accept`, { answers }),
  getAutomod: (serverId) => get(`/api/servers/${serverId}/automod`),
  createAutomodRule: (serverId, body) => post(`/api/servers/${serverId}/automod/rules`, body),
  updateAutomodRule: (serverId, ruleId, body) => patch(`/api/servers/${serverId}/automod/rules/${ruleId}`, body),
  deleteAutomodRule: (serverId, ruleId) => del(`/api/servers/${serverId}/automod/rules/${ruleId}`),
  listServerInvites: (serverId) => get(`/api/servers/${serverId}/invites`),
  createServerInvite: (serverId, body) => post(`/api/servers/${serverId}/invites`, body),
  revokeServerInvite: (serverId, inviteId) => del(`/api/servers/${serverId}/invites/${inviteId}`),
  setServerVanity: (serverId, code) => put(`/api/servers/${serverId}/invites/vanity`, { code }),
  issueServerBotToken: (serverId, botId) => post(`/api/servers/${serverId}/bots/${botId}/token`, {}),
  revokeServerBotToken: (serverId, botId) => del(`/api/servers/${serverId}/bots/${botId}/token`),
  rotateServerBotSecret: (serverId, botId) => post(`/api/servers/${serverId}/bots/${botId}/webhook/secret`, {}),
  testServerBotWebhook: (serverId, botId) => post(`/api/servers/${serverId}/bots/${botId}/webhook/test`, {}),
  adminIssueBotToken: (botId) => post(`/api/admin/ai/bots/${botId}/token`, {}),
  adminRevokeBotToken: (botId) => del(`/api/admin/ai/bots/${botId}/token`),
  adminRotateBotSecret: (botId) => post(`/api/admin/ai/bots/${botId}/webhook/secret`, {}),
  adminTestBotWebhook: (botId) => post(`/api/admin/ai/bots/${botId}/webhook/test`, {}),
  listServerAiProviders: (serverId) => get(`/api/servers/${serverId}/ai/providers`),
  listServerBots: (serverId) => get(`/api/servers/${serverId}/bots`),
  createServerBot: (serverId, body) => post(`/api/servers/${serverId}/bots`, body),
  updateServerBot: (serverId, botId, body) => patch(`/api/servers/${serverId}/bots/${botId}`, body),
  deleteServerBot: (serverId, botId) => del(`/api/servers/${serverId}/bots/${botId}`),
  uploadServerBotAvatar: (serverId, botId, file) => { const fd = new FormData(); fd.append('avatar', file); return postForm(`/api/servers/${serverId}/bots/${botId}/avatar`, fd); },

  // soundboard (per-server, MANAGE_SERVER)
  uploadSound: (serverId, name, emoji, file) => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('emoji', emoji || '');
    fd.append('audio', file);
    return postForm(`/api/servers/${serverId}/sounds`, fd);
  },
  deleteSound: (serverId, soundId) => del(`/api/servers/${serverId}/sounds/${soundId}`),

  // soundboard (site-admin, MANAGE_ANY_SERVER)
  adminListSounds: (serverId) => get(`/api/admin/servers/${serverId}/sounds`),
  adminUploadSound: (serverId, name, emoji, file) => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('emoji', emoji || '');
    fd.append('audio', file);
    return postForm(`/api/admin/servers/${serverId}/sounds`, fd);
  },
  adminDeleteSound: (serverId, soundId) => del(`/api/admin/servers/${serverId}/sounds/${soundId}`),

  // roles
  createRole: (serverId, payload) => post(`/api/servers/${serverId}/roles`, payload),
  updateRole: (serverId, roleId, payload) => patch(`/api/servers/${serverId}/roles/${roleId}`, payload),
  uploadRoleIcon: (serverId, roleId, file) => {
    const fd = new FormData();
    fd.append('icon', file);
    return postForm(`/api/servers/${serverId}/roles/${roleId}/icon`, fd);
  },
  deleteRoleIcon: (serverId, roleId) => del(`/api/servers/${serverId}/roles/${roleId}/icon`),
  confirmAge: () => post('/api/users/me/age-confirmation', {}),
  listServerCommands: (serverId) => get(`/api/servers/${serverId}/commands`),
  invokeCommand: (serverId, body) => post(`/api/servers/${serverId}/commands/invoke`, body),
  deleteRole: (serverId, roleId) => del(`/api/servers/${serverId}/roles/${roleId}`),
  assignRole: (serverId, userId, roleId) => put(`/api/servers/${serverId}/members/${userId}/roles/${roleId}`),
  unassignRole: (serverId, userId, roleId) => del(`/api/servers/${serverId}/members/${userId}/roles/${roleId}`),
  setNickname: (serverId, userId, nickname) => patch(`/api/servers/${serverId}/members/${userId}/nickname`, { nickname }),
  setMemberColor: (serverId, userId, color) => patch(`/api/servers/${serverId}/members/${userId}/color`, { color }),
  kickMember: (serverId, userId) => post(`/api/servers/${serverId}/members/${userId}/kick`),
  inviteUserToServer: (serverId, userId) => post(`/api/servers/${serverId}/invite-direct`, { userId }),
  banMember: (serverId, userId, reason) => post(`/api/servers/${serverId}/members/${userId}/ban`, { reason }),
  unbanMember: (serverId, userId) => del(`/api/servers/${serverId}/bans/${userId}`),

  // messages (channel scope)
  listChannelMessages: (serverId, channelId, { before, after, limit, around } = {}) =>
    get(`/api/servers/${serverId}/channels/${channelId}/messages`, { before, after, limit, around }),
  sendChannelMessage: (serverId, channelId, { content, files, onProgress, replyToMessageId, stickerId, voiceDurationMs }) =>
    uploadMessage(`/api/servers/${serverId}/channels/${channelId}/messages`, content, files, onProgress, replyToMessageId, stickerId, voiceDurationMs),
  globalSearch: (q, serverId, { limit } = {}) => get('/api/search', { q, serverId, limit }),
  searchServerMessages: (serverId, q, { channelId, limit, fields } = {}) =>
    get(`/api/servers/${serverId}/search`, { q, channelId, limit, fields }),

  // threads (forum posts + "Create Thread" off a channel message)
  listNotes: (serverId, channelId, before) => get(`/api/servers/${serverId}/channels/${channelId}/notes`, { before }),
  createNote: (serverId, channelId, payload) => post(`/api/servers/${serverId}/channels/${channelId}/notes`, payload),
  updateNote: (serverId, channelId, noteId, payload) => patch(`/api/servers/${serverId}/channels/${channelId}/notes/${noteId}`, payload),
  deleteNote: (serverId, channelId, noteId) => del(`/api/servers/${serverId}/channels/${channelId}/notes/${noteId}`),
  trimNotes: (serverId, channelId, payload) => post(`/api/servers/${serverId}/channels/${channelId}/notes/trim`, payload),
  uploadNoteFile: async (serverId, channelId, bytes) => {
    const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/notes/files`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, body);
    return body;
  },
  downloadNoteFile: async (serverId, channelId, fileId) => {
    const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/notes/files/${fileId}`, { credentials: 'include' });
    if (!res.ok) throw new ApiError(res.status, null);
    return new Uint8Array(await res.arrayBuffer());
  },
  deleteNoteFile: (serverId, channelId, fileId) => del(`/api/servers/${serverId}/channels/${channelId}/notes/files/${fileId}`),
  listThreads: (serverId, channelId) => get(`/api/servers/${serverId}/channels/${channelId}/threads`),
  createThread: (serverId, channelId, payload) => post(`/api/servers/${serverId}/channels/${channelId}/threads`, payload),
  getThread: (serverId, channelId, threadId) => get(`/api/servers/${serverId}/channels/${channelId}/threads/${threadId}`),
  updateThread: (serverId, channelId, threadId, payload) => patch(`/api/servers/${serverId}/channels/${channelId}/threads/${threadId}`, payload),
  deleteThread: (serverId, channelId, threadId) => del(`/api/servers/${serverId}/channels/${channelId}/threads/${threadId}`),
  uploadThreadIcon: (serverId, channelId, threadId, file) => {
    const fd = new FormData();
    fd.append('icon', file);
    return postForm(`/api/servers/${serverId}/channels/${channelId}/threads/${threadId}/icon`, fd);
  },
  listThreadMessages: (serverId, channelId, threadId, { before, after, limit, around } = {}) =>
    get(`/api/servers/${serverId}/channels/${channelId}/threads/${threadId}/messages`, { before, after, limit, around }),
  sendThreadMessage: (serverId, channelId, threadId, { content, files, onProgress, replyToMessageId, stickerId, voiceDurationMs }) =>
    uploadMessage(`/api/servers/${serverId}/channels/${channelId}/threads/${threadId}/messages`, content, files, onProgress, replyToMessageId, stickerId, voiceDurationMs),

  // DMs
  listRemoteServers: () => get('/api/remote/servers'),
  getRemoteServer: (peerId, serverId) => get(`/api/remote/${peerId}/${serverId}`),
  leaveRemoteServer: (peerId, serverId) => del(`/api/remote/${peerId}/${serverId}`),
  listRemoteMessages: (peerId, serverId, channelId, query) => get(`/api/remote/${peerId}/${serverId}/channels/${channelId}/messages`, query),
  sendRemoteMessage: (peerId, serverId, channelId, content, files, onProgress) => (files?.length
    ? uploadMessage(`/api/remote/${peerId}/${serverId}/channels/${channelId}/messages`, content, files, onProgress)
    : post(`/api/remote/${peerId}/${serverId}/channels/${channelId}/messages`, { content })),
  listRemoteMembers: (peerId, serverId) => get(`/api/remote/${peerId}/${serverId}/members`),
  listRemoteThreads: (peerId, serverId, channelId) => get(`/api/remote/${peerId}/${serverId}/channels/${channelId}/threads`),
  listRemoteThreadMessages: (peerId, serverId, channelId, threadId, query) => get(`/api/remote/${peerId}/${serverId}/channels/${channelId}/threads/${threadId}/messages`, query),
  remoteAttachmentUrl: (peerId, serverId, channelId, attachmentId) => `/api/remote/${peerId}/${serverId}/channels/${channelId}/attachments/${attachmentId}`,
  remoteAvatarUrl: (peerId, serverId, userId) => `/api/remote/${peerId}/${serverId}/members/${userId}/avatar`,
  editRemoteMessage: (peerId, serverId, channelId, messageId, content) => patch(`/api/remote/${peerId}/${serverId}/channels/${channelId}/messages/${messageId}`, { content }),
  deleteRemoteMessage: (peerId, serverId, channelId, messageId) => del(`/api/remote/${peerId}/${serverId}/channels/${channelId}/messages/${messageId}`),
  addRemoteReaction: (peerId, serverId, channelId, messageId, emoji) => put(`/api/remote/${peerId}/${serverId}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`),
  removeRemoteReaction: (peerId, serverId, channelId, messageId, emoji) => del(`/api/remote/${peerId}/${serverId}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`),
  listDms: () => get('/api/dms'),
  openDm: (userId) => post('/api/dms', { userId }),
  openGroupDm: (userIds, name) => post('/api/dms/group', { userIds, name }),
  listDmMessages: (dmId, { before, after, limit, around } = {}) => get(`/api/dms/${dmId}/messages`, { before, after, limit, around }),
  sendDmMessage: (dmId, { content, files, onProgress, replyToMessageId, voiceDurationMs }) =>
    uploadMessage(`/api/dms/${dmId}/messages`, content, files, onProgress, replyToMessageId, undefined, voiceDurationMs),
  sendEncryptedDmMessage: (dmId, { content, replyToMessageId, fileIds }) => post(`/api/dms/${dmId}/messages`, { content, replyToMessageId, fileIds }),
  uploadDmFile: async (dmId, blobId, bytes) => {
    const res = await fetch(`/api/dms/${dmId}/e2ee-files/${blobId}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, body);
    return body;
  },
  downloadDmFile: async (dmId, blobId) => {
    const res = await fetch(`/api/dms/${dmId}/e2ee-files/${blobId}`, { credentials: 'include' });
    if (!res.ok) throw new ApiError(res.status, null);
    return new Uint8Array(await res.arrayBuffer());
  },
  deleteDmFile: (dmId, blobId) => del(`/api/dms/${dmId}/e2ee-files/${blobId}`),
  enableDmEncryption: (dmId) => post(`/api/dms/${dmId}/encryption/enable`),
  linkPreview: (url) => post('/api/link-preview', { url }),
  searchDmMessages: (dmId, q, { limit, fields } = {}) => get(`/api/dms/${dmId}/search`, { q, limit, fields }),

  // messages (generic)
  editMessage: (id, content) => patch(`/api/messages/${id}`, { content }),
  deleteMessage: (id) => del(`/api/messages/${id}`),
  addReaction: (id, emoji) => put(`/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
  removeReaction: (id, emoji) => del(`/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
  pinMessage: (id) => put(`/api/messages/${id}/pin`),
  unpinMessage: (id) => del(`/api/messages/${id}/pin`),
  listPins: (scopeType, scopeId) => get('/api/messages/pins', { scopeType, scopeId }),
  forwardMessage: (id, payload) => post(`/api/messages/${id}/forward`, payload),

  // polls
  createPoll: (payload) => post('/api/polls', payload),
  votePoll: (pollId, optionId) => put(`/api/polls/${pollId}/vote/${optionId}`),
  unvotePoll: (pollId, optionId) => del(`/api/polls/${pollId}/vote/${optionId}`),

  // notifications
  getUserAnnotations: () => get('/api/user-annotations'),
  setUserAnnotation: (targetId, patch) => put(`/api/user-annotations/${targetId}`, patch),
  getDmPrefs: () => get('/api/dm-prefs'),
  setDmPref: (dmId, patch) => put(`/api/dm-prefs/${dmId}`, patch),
  getBookmarks: () => get('/api/bookmarks'),
  getBookmarkIds: () => get('/api/bookmarks/ids'),
  addBookmark: (messageId) => put(`/api/bookmarks/${messageId}`, {}),
  removeBookmark: (messageId) => del(`/api/bookmarks/${messageId}`),
  createReminder: (messageId, minutes) => post('/api/reminders', { messageId, minutes }),
  markUnreadFrom: (scopeType, scopeId, messageId) => put(`/api/read-state/${scopeType}/${scopeId}`, { messageId, force: true }),
  getServerPrefs: () => get('/api/server-prefs'),
  setServerPrefs: (serverId, patch) => put(`/api/server-prefs/${serverId}`, patch),
  getNotificationPrefs: () => get('/api/notification-prefs'),
  setNotificationPref: (scopeType, scopeId, pref, extra = {}) => put(`/api/notification-prefs/${scopeType}/${scopeId}`, { pref, ...extra }),

  // read state (unread indicators + DM "Seen")
  getReadState: () => get('/api/read-state'),
  markRead: (scopeType, scopeId, messageId) => put(`/api/read-state/${scopeType}/${scopeId}`, { messageId }),

  // admin
  adminListLanguages: () => get('/api/admin/languages'),
  adminUploadLanguage: (code, name, file) => {
    const fd = new FormData();
    fd.append('code', code);
    fd.append('name', name);
    fd.append('file', file);
    return postForm('/api/admin/languages', fd);
  },
  adminSetLanguageEnabled: (code, enabled) => patch(`/api/admin/languages/${code}`, { enabled }),
  adminDeleteLanguage: (code) => del(`/api/admin/languages/${code}`),
  federationStatus: () => get('/federation/admin/status'),
  federationSetup: (password) => post('/federation/admin/setup', { password }),
  federationLogin: (password) => post('/federation/admin/login', { password }),
  federationLogout: () => post('/federation/admin/logout'),
  federationPeers: () => get('/federation/admin/peers'),
  federationCreateInvite: () => post('/federation/admin/invites'),
  federationRedeemInvite: (invite) => post('/federation/admin/redeem-invite', { invite }),
  federationAcceptPeer: (id) => post(`/federation/admin/peers/${id}/accept`),
  federationRejectPeer: (id) => post(`/federation/admin/peers/${id}/reject`),
  federationRevokePeer: (id) => del(`/federation/admin/peers/${id}`),
  adminGetSettings: () => get('/api/admin/settings'),
  adminUpdateSettings: (payload) => patch('/api/admin/settings', payload),
  captchaStatus: (kind) => get('/api/auth/captcha/status', { kind }),
  captchaChallenge: () => post('/api/auth/captcha'),
  adminSecOverview: () => get('/api/admin/security/overview'),
  adminSecSettings: () => get('/api/admin/security/settings'),
  adminSecUpdateSettings: (payload) => patch('/api/admin/security/settings', payload),
  adminSecCaptchaPreview: (captcha) => post('/api/admin/security/captcha/preview', { captcha }),
  adminSecCheckWords: (text) => post('/api/admin/security/words/check', { text }),
  adminSecUnderAttack: (enabled, minutes) => post('/api/admin/security/under-attack', { enabled, minutes }),
  adminSecBans: (query) => get('/api/admin/security/bans', query),
  adminSecAddBan: (payload) => post('/api/admin/security/bans', payload),
  adminSecImportBans: (text, reason) => post('/api/admin/security/bans/import', { text, reason }),
  adminSecRemoveBan: (id) => del(`/api/admin/security/bans/${id}`),
  adminSecClearBans: (source) => request('DELETE', '/api/admin/security/bans', { query: { source } }),
  adminSecBlocklists: () => get('/api/admin/security/blocklists'),
  adminSecAddBlocklist: (payload) => post('/api/admin/security/blocklists', payload),
  adminSecUpdateBlocklist: (id, payload) => patch(`/api/admin/security/blocklists/${id}`, payload),
  adminSecRefreshBlocklist: (id) => post(`/api/admin/security/blocklists/${id}/refresh`),
  adminSecRemoveBlocklist: (id) => del(`/api/admin/security/blocklists/${id}`),
  adminSecLookup: (ip) => get('/api/admin/security/lookup', { ip }),
  adminSecEvents: (query) => get('/api/admin/security/events', query),
  adminSecClearEvents: () => del('/api/admin/security/events'),
  adminGetCalls: () => get('/api/admin/calls'),
  adminUpdateCalls: (payload) => patch('/api/admin/calls', payload),
  adminTestCalls: () => post('/api/admin/calls/test', {}),
  adminDetectIp: () => post('/api/admin/calls/detect-ip', {}),
  adminStats: () => get('/api/admin/stats'),
  adminUsers: () => get('/api/admin/users'),
  adminSetDisabled: (id, isDisabled) => patch(`/api/admin/users/${id}`, { isDisabled }),
  adminUpdateUser: (id, payload) => patch(`/api/admin/users/${id}`, payload),
  adminUploadUserAvatar: (id, file) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return postForm(`/api/admin/users/${id}/avatar`, fd);
  },
  adminSiteRoles: () => get('/api/admin/site-roles'),
  adminCreateSiteRole: (payload) => post('/api/admin/site-roles', payload),
  adminUpdateSiteRole: (id, payload) => patch(`/api/admin/site-roles/${id}`, payload),
  adminDeleteSiteRole: (id) => del(`/api/admin/site-roles/${id}`),
  adminAssignSiteRole: (userId, roleId) => put(`/api/admin/users/${userId}/site-roles/${roleId}`),
  adminUnassignSiteRole: (userId, roleId) => del(`/api/admin/users/${userId}/site-roles/${roleId}`),
  adminReports: (status) => get('/api/admin/reports', { status }),
  adminResolveReport: (id, status) => patch(`/api/admin/reports/${id}`, { status }),

  // admin data pruning (instance-wide, PRUNE_DATA)
  adminPruneServers: () => get('/api/admin/prune/servers'),
  adminPruneServerChannels: (serverId) => get(`/api/admin/prune/servers/${serverId}/channels`),
  adminPruneDms: () => get('/api/admin/prune/dms'),
  adminPrunePreview: (payload) => post('/api/admin/prune/preview', payload),
  adminPruneExecute: (payload) => post('/api/admin/prune/execute', payload),

  // server-scoped data pruning (PRUNE_CONTENT — this server's own channels only)
  pruneChannelsList: (serverId) => get(`/api/servers/${serverId}/prune/channels`),
  prunePreview: (serverId, payload) => post(`/api/servers/${serverId}/prune/preview`, payload),
  pruneExecute: (serverId, payload) => post(`/api/servers/${serverId}/prune/execute`, payload),

  // group DM pruning (creator only, immediate-only)
  dmPrunePreview: (dmId, payload) => post(`/api/dms/${dmId}/prune/preview`, payload),
  dmPruneExecute: (dmId, payload) => post(`/api/dms/${dmId}/prune/execute`, payload),
  leaveDm: (dmId) => del(`/api/dms/${dmId}/members/me`),
  deleteDm: (dmId) => del(`/api/dms/${dmId}`),

  // reports
  fileReport: (payload) => post('/api/reports', payload),
};

// Uses XHR (not fetch) so we can report upload progress for attachments.
function uploadMessage(url, content, files, onProgress, replyToMessageId, stickerId, voiceDurationMs) {
  const fd = new FormData();
  if (voiceDurationMs) fd.append('voiceDurationMs', String(Math.round(voiceDurationMs)));
  fd.append('content', content || '');
  if (replyToMessageId) fd.append('replyToMessageId', replyToMessageId);
  if (stickerId) fd.append('stickerId', stickerId);
  for (const f of files || []) fd.append('files', f);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new ApiError(xhr.status, body));
    };
    xhr.onerror = () => reject(new ApiError(0, { error: 'network error' }));
    xhr.send(fd);
  });
}

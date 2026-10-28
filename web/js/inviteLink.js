import { api } from './api.js';

// null for federated `code@domain` codes: the owning instance is not queried before the user confirms.
export async function peekInvite(code) {
  return code.includes('@') ? null : api.invitePeek(code);
}

// Tries a server invite first, then a channel invite (the two look identical to a user) and joins.
// Throws the server-invite error when neither code is valid.
export async function redeemInviteCode(code) {
  try {
    const res = await api.joinServer(code);
    return res.federated ? { kind: 'federated', res } : { kind: 'server', res };
  } catch (err) {
    try { return { kind: 'channel', res: await api.joinChannelInvite(code) }; } catch { throw err; }
  }
}

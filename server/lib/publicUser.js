'use strict';

const { isSiteAdmin, canManageSites } = require('./siteAuth');
const { isOnline } = require('./presence');

// `users.status` is the user's *chosen presence preference* (online/idle/dnd/invisible) — it is
// never mutated by connect/disconnect. What's actually shown to a viewer also depends on whether
// the user currently has any open WebSocket connection at all (tracked separately in presence.js),
// so a preference of "online" set before going offline doesn't come back stale on next connect.
function effectiveStatus(user, viewerIsSelf) {
  if (!isOnline(user.id)) return 'offline';
  if (user.status === 'invisible' && !viewerIsSelf) return 'offline';
  return user.status;
}

// Shape a DB user row for API responses. `viewerIsSelf`/`areFriends` gate privacy-sensitive fields.
function toPublicUser(user, { viewerIsSelf = false, areFriends = false } = {}) {
  if (!user) return null;
  const base = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarPath: user.avatar_path || null,
    bannerColor: user.banner_color || '',
    bannerPath: user.banner_path || null,
    cardColor: user.card_color || '',
    cardPath: user.card_path || null,
    status: effectiveStatus(user, viewerIsSelf),
    customStatusText: user.custom_status_text || '',
    customStatusEmoji: user.custom_status_emoji || '',
    isSiteAdmin: isSiteAdmin(user.id),
    canManageSites: canManageSites(user.id),
    e2eePublicKey: user.e2ee_public_key || null,
    passportId: user.passport_id || null,
    isBot: !!user.is_bot,
  };

  const canSeeProfile =
    viewerIsSelf || user.profile_privacy === 'everyone' || (user.profile_privacy === 'friends' && areFriends);

  if (canSeeProfile || viewerIsSelf) {
    base.bio = user.bio || '';
  }
  if (viewerIsSelf) {
    base.email = user.email;
    base.dmPrivacy = user.dm_privacy;
    base.profilePrivacy = user.profile_privacy;
    base.discoverable = !!user.discoverable;
    base.totpEnabled = !!user.totp_enabled;
    base.authMode = user.auth_mode || 'password';
    base.notifySoundMode = user.notify_sound_mode || 'auto';
    base.language = user.language || null;
  }
  return base;
}

module.exports = { toPublicUser };

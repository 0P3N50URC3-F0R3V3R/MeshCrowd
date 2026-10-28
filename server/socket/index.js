'use strict';

const { WebSocketServer } = require('ws');
const { db } = require('../db');
const { getSession } = require('../lib/session');
const { parseCookies } = require('../middleware/auth');
const { load: loadConfig } = require('../lib/config');
const { canAccessChannel, getChannelPermissionBits, isPendingMember } = require('../lib/channelAccess');
const { PERMISSIONS, has } = require('../lib/permissions');
const { toPublicUser } = require('../lib/publicUser');
const hub = require('./hub');
const guard = require('../lib/security/guard');
const voice = require('./voice');
const stage = require('./stage');
const { isAllowedWsOrigin } = require('../lib/wsOrigin');

function getChannel(id) {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

// DM voice rooms share the same in-memory registry as server voice channels (server/socket/voice.js),
// keyed by a string so a DM id can never collide with a numeric channels.id.
function dmRoomKey(dmChannelId) {
  return `dm:${dmChannelId}`;
}

function isDmMember(dmChannelId, userId) {
  return !!db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').get(dmChannelId, userId);
}

// Invite-only: only current DM members ever see this, never broadcast to friends/member lists
// like broadcastFriendVoiceActivity does for server voice channels — a DM call must not leak
// presence to anyone outside the conversation.
function broadcastDmVoiceState(dmChannelId) {
  const participants = voice.participants(dmRoomKey(dmChannelId)).map((userId) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return user ? toPublicUser(user, {}) : null;
  }).filter(Boolean);
  hub.broadcastToDm(dmChannelId, { type: 'voice_state', dmChannelId, participants });
}

function broadcastVoiceState(channel) {
  const participants = voice.participants(channel.id).map((userId) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return user ? { ...toPublicUser(user, {}), mutedByMod: voice.isForceMuted(channel.id, userId) } : null;
  }).filter(Boolean);
  hub.broadcastToChannel(channel, { type: 'voice_state', channelId: channel.id, participants });
}

// Sent only to people actually in the room (not every channel viewer, unlike broadcastVoiceState)
// — the speaker/raised-hand roster is meaningless to someone not on the call.
function broadcastStageState(channel) {
  hub.notifyUserIds(voice.participants(channel.id), { type: 'stage_state', channelId: channel.id, ...stage.getState(channel.id) });
}

// Powers the "friends in voice" activity feed — narrower than broadcastVoiceState (friends only,
// not everyone who can see the channel) and carries the server name too, since a friend viewing
// their own activity feed isn't necessarily a member of that server.
function broadcastFriendVoiceActivity(userId, channel) {
  let channelInfo = null;
  if (channel) {
    const server = db.prepare('SELECT id, name FROM servers WHERE id = ?').get(channel.server_id);
    channelInfo = { id: channel.id, name: channel.name, serverId: server?.id, serverName: server?.name };
  }
  hub.broadcastToFriends(userId, { type: 'friend_voice', userId, channel: channelInfo });
}

function attach(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  const config = loadConfig();

  httpServer.on('upgrade', (req, socket, head) => {
    if (guard.isUpgradeBlocked(req, config.trustProxy)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!req.url || !req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    if (!isAllowedWsOrigin(req, config)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const cookies = parseCookies(req);
    const session = getSession(cookies.dismesh_session);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (!user || user.is_disabled) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, user);
    });
  });

  wss.on('connection', (ws, req, user) => {
    hub.registerConnection(user.id, ws);
    // The user's chosen status preference doesn't change here — only whether they're reachable
    // at all does, and that flips effectiveStatus() in lib/publicUser.js. Broadcast so viewers
    // pick up the change (e.g. offline -> whatever they had set before disconnecting).
    hub.broadcastPresence(user.id);
    // broadcastPresence only notifies friends/server-mates, never the connecting user themself —
    // without this, a client's own status dot stays stuck at whatever the login/register HTTP
    // response computed (always "offline", since that request necessarily ran before this
    // connection existed) until the page is reloaded.
    hub.notifyUser(user.id, { type: 'presence', user: toPublicUser(user, { viewerIsSelf: true }) });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'typing' && msg.scopeType && msg.scopeId) {
        const payload = { type: 'typing', scopeType: msg.scopeType, scopeId: msg.scopeId, userId: user.id };
        if (msg.scopeType === 'dm') {
          const isMember = db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id = ? AND user_id = ?')
            .get(msg.scopeId, user.id);
          if (isMember) hub.broadcastToDm(msg.scopeId, payload);
        } else if (msg.scopeType === 'channel') {
          const channel = getChannel(msg.scopeId);
          if (channel && canAccessChannel(channel, user.id, PERMISSIONS.SEND_MESSAGES)) {
            hub.broadcastToChannel(channel, payload);
          }
        }
        return;
      }

      if (msg.type === 'voice_join' && msg.dmChannelId) {
        if (!isDmMember(msg.dmChannelId, user.id)) return;
        const roomKey = dmRoomKey(msg.dmChannelId);
        if (voice.inOtherRoom(roomKey, user.id)) { ws.send(JSON.stringify({ type: 'voice_join_denied', dmChannelId: msg.dmChannelId })); return; }
        const wasEmpty = voice.participants(roomKey).length === 0;
        voice.join(roomKey, user.id);
        broadcastDmVoiceState(msg.dmChannelId);
        // Ring every other DM member the first time this call goes from empty to non-empty —
        // not on every subsequent joiner, so a group DM doesn't re-ring people already on the call.
        if (wasEmpty) {
          const others = db.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ? AND user_id != ?')
            .all(msg.dmChannelId, user.id);
          for (const m of others) {
            hub.notifyUser(m.user_id, { type: 'voice_ring', dmChannelId: msg.dmChannelId, fromUser: toPublicUser(user, {}) });
          }
        }
        return;
      }

      if (msg.type === 'voice_join' && msg.channelId) {
        const channel = getChannel(msg.channelId);
        if (!channel || (channel.type !== 'voice' && channel.type !== 'stage')) return;
        if (!canAccessChannel(channel, user.id, PERMISSIONS.VIEW_CHANNEL)) return;
        if (isPendingMember(channel.server_id, user.id)) return;
        if (voice.inOtherRoom(channel.id, user.id)) { ws.send(JSON.stringify({ type: 'voice_join_denied', channelId: channel.id })); return; }
        voice.join(channel.id, user.id);
        if (channel.type === 'stage') {
          const canManageChannel = has(getChannelPermissionBits(channel, user.id), PERMISSIONS.MANAGE_CHANNELS);
          stage.onJoin(channel.id, user.id, canManageChannel);
          broadcastStageState(channel);
        }
        broadcastVoiceState(channel);
        broadcastFriendVoiceActivity(user.id, channel);
        return;
      }

      if (msg.type === 'voice_leave' && msg.dmChannelId) {
        if (!isDmMember(msg.dmChannelId, user.id)) return;
        voice.leave(dmRoomKey(msg.dmChannelId), user.id);
        broadcastDmVoiceState(msg.dmChannelId);
        return;
      }

      if (msg.type === 'voice_leave' && msg.channelId) {
        const channel = getChannel(msg.channelId);
        if (!channel) return;
        voice.leave(channel.id, user.id);
        if (channel.type === 'stage') {
          stage.onLeave(channel.id, user.id);
          broadcastStageState(channel);
        }
        broadcastVoiceState(channel);
        broadcastFriendVoiceActivity(user.id, null);
        return;
      }

      // Stage channels: speaker/audience + raise-hand, layered on top of the same voice room a
      // regular voice channel uses — see server/socket/stage.js. Any of these silently no-ops if
      // the sender isn't actually a participant (join already required VIEW_CHANNEL, same
      // "both sides must be a registered room participant" pattern voice_signal below uses).
      if (msg.type === 'stage_raise_hand' && msg.channelId) {
        const channel = getChannel(msg.channelId);
        if (!channel || channel.type !== 'stage') return;
        if (!voice.isParticipant(channel.id, user.id)) return;
        if (stage.isSpeaker(channel.id, user.id)) return; // already a speaker, raising a hand is meaningless
        stage.raiseHand(channel.id, user.id, !!msg.raised);
        broadcastStageState(channel);
        return;
      }

      if (msg.type === 'stage_invite_speaker' && msg.channelId && msg.userId) {
        const channel = getChannel(msg.channelId);
        if (!channel || channel.type !== 'stage') return;
        // Any current speaker may invite someone else up — same as Discord, not moderator-only.
        if (!stage.isSpeaker(channel.id, user.id)) return;
        if (!voice.isParticipant(channel.id, msg.userId)) return;
        stage.inviteSpeaker(channel.id, msg.userId);
        broadcastStageState(channel);
        return;
      }

      if (msg.type === 'stage_move_to_audience' && msg.channelId && msg.userId) {
        const channel = getChannel(msg.channelId);
        if (!channel || channel.type !== 'stage') return;
        // Stepping yourself down is always allowed; moving someone else requires Manage Channels
        // (otherwise any co-speaker could silence another speaker they don't like).
        const isSelf = msg.userId === user.id;
        const canManageChannel = has(getChannelPermissionBits(channel, user.id), PERMISSIONS.MANAGE_CHANNELS);
        if (!isSelf && !canManageChannel) return;
        if (!voice.isParticipant(channel.id, msg.userId)) return;
        stage.moveToAudience(channel.id, msg.userId);
        broadcastStageState(channel);
        return;
      }

      // "Complete" mute for a server voice channel (never DMs, which have no role/permission
      // system to gate this with) - requires MODERATE_MEMBERS, same permission channel slowmode
      // and member timeouts already use. There's no central mixer to actually silence someone
      // else's outgoing audio, so this works the same way Discord's own server-mute does under
      // the hood: broadcastVoiceState tells the target's own client to stop sending (see
      // voice.js's forceMuted and the client's applyRoster), enforced there, not here.
      if ((msg.type === 'voice_force_mute' || msg.type === 'voice_force_unmute') && msg.channelId && msg.userId) {
        const channel = getChannel(msg.channelId);
        if (!channel || (channel.type !== 'voice' && channel.type !== 'stage')) return;
        if (!has(getChannelPermissionBits(channel, user.id), PERMISSIONS.MODERATE_MEMBERS)) return;
        if (!voice.isParticipant(channel.id, msg.userId)) return;
        if (msg.type === 'voice_force_mute') voice.forceMute(channel.id, msg.userId);
        else voice.forceUnmute(channel.id, msg.userId);
        broadcastVoiceState(channel);
        return;
      }

      // Soundboard — played locally by every client currently in the voice room (including the
      // sender, which hears its own broadcast echo rather than playing optimistically) since
      // there's no central mixer to inject the clip into anyone's outgoing WebRTC track. DM/group
      // calls don't get a soundboard (sounds are server-scoped, DMs have no server).
      if (msg.type === 'voice_soundboard_play' && msg.channelId && msg.soundId) {
        const channel = getChannel(msg.channelId);
        // Stage channels are a voice room too (see voice_join above) — the client already shows
        // this button there with no isStage gate, so the server needs to accept it or the button
        // silently does nothing in a stage channel.
        if (!channel || (channel.type !== 'voice' && channel.type !== 'stage')) return;
        if (!voice.isParticipant(channel.id, user.id)) return;
        const sound = db.prepare('SELECT * FROM sounds WHERE id = ? AND server_id = ?').get(Number(msg.soundId), channel.server_id);
        if (!sound) return;
        hub.notifyUserIds(voice.participants(channel.id), {
          type: 'voice_soundboard_play',
          channelId: channel.id,
          sound: { id: sound.id, name: sound.name, audioPath: sound.audio_path },
          playedBy: toPublicUser(user, {}),
        });
        return;
      }

      if (msg.type === 'voice_signal' && msg.toUserId && msg.signal && (msg.channelId || msg.dmChannelId)) {
        // Both parties must currently be registered participants of that voice room — this is
        // the permission check (join already required VIEW_CHANNEL/DM membership), and it stops a
        // client from relaying WebRTC signalling to an arbitrary user via a forged id.
        const roomKey = msg.dmChannelId ? dmRoomKey(msg.dmChannelId) : msg.channelId;
        if (!voice.isParticipant(roomKey, user.id)) return;
        if (!voice.isParticipant(roomKey, msg.toUserId)) return;
        hub.notifyUser(msg.toUserId, {
          type: 'voice_signal', channelId: msg.channelId, dmChannelId: msg.dmChannelId, fromUserId: user.id, signal: msg.signal,
        });
      }
    });

    ws.on('close', () => {
      hub.unregisterConnection(user.id, ws);
      if (!hub.isOnline(user.id)) hub.broadcastPresence(user.id);

      const affectedRooms = voice.leaveAll(user.id);
      let leftServerVoiceChannel = false;
      for (const roomKey of affectedRooms) {
        if (typeof roomKey === 'string' && roomKey.startsWith('dm:')) {
          broadcastDmVoiceState(Number(roomKey.slice(3)));
          continue;
        }
        const channel = getChannel(roomKey);
        if (channel) { broadcastVoiceState(channel); leftServerVoiceChannel = true; }
      }
      if (leftServerVoiceChannel) broadcastFriendVoiceActivity(user.id, null);
    });
  });

  return wss;
}

module.exports = { attach };

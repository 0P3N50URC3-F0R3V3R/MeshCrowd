'use strict';

// In-memory voice-channel presence registry: channelId -> Set<userId>. Deliberately not
// persisted — voice presence is meaningless across a server restart, every client rejoins.
const rooms = new Map();

// Moderator-imposed "mute for everyone" per room, since this is a P2P mesh with no central
// mixer/media server to actually silence someone else's outgoing audio - a force-mute only works
// by telling the target's own client (over this same voice_state broadcast) to stop sending,
// which is exactly how Discord's server-mute also works under the hood. Cleared whenever the room
// itself empties out, so it can never carry over into an unrelated later session in that channel.
const forceMuted = new Map();

function join(channelId, userId) {
  if (!rooms.has(channelId)) rooms.set(channelId, new Set());
  rooms.get(channelId).add(userId);
}

function leave(channelId, userId) {
  const room = rooms.get(channelId);
  if (!room) return;
  room.delete(userId);
  if (room.size === 0) { rooms.delete(channelId); forceMuted.delete(channelId); }
}

function forceMute(channelId, userId) {
  if (!forceMuted.has(channelId)) forceMuted.set(channelId, new Set());
  forceMuted.get(channelId).add(userId);
}

function forceUnmute(channelId, userId) {
  forceMuted.get(channelId)?.delete(userId);
}

function isForceMuted(channelId, userId) {
  return forceMuted.get(channelId)?.has(userId) ?? false;
}

function inOtherRoom(roomKey, userId) {
  for (const [key, members] of rooms) {
    if (key !== roomKey && members.has(userId)) return true;
  }
  return false;
}

function participants(channelId) {
  return [...(rooms.get(channelId) || [])];
}

function isParticipant(channelId, userId) {
  return rooms.get(channelId)?.has(userId) ?? false;
}

// Called on socket disconnect — a user can only be in one voice channel at a time in this
// client, but scan all rooms defensively (e.g. multiple tabs/devices). Returns the channel ids
// the user was removed from, so the caller can broadcast updated rosters for each.
function leaveAll(userId) {
  const affected = [];
  for (const [channelId, members] of rooms) {
    if (members.delete(userId)) {
      affected.push(channelId);
      if (members.size === 0) { rooms.delete(channelId); forceMuted.delete(channelId); }
    }
  }
  return affected;
}

// Given a list of user ids, finds which of them currently have an active voice channel and which
// one — used by the friends-activity feed to answer "which of my friends are in voice right now"
// without an initial WS round-trip, and by GET /api/friends/activity for the same purpose.
function activeChannelFor(userIds) {
  const wanted = new Set(userIds);
  const result = new Map();
  for (const [channelId, members] of rooms) {
    for (const userId of members) {
      if (wanted.has(userId)) result.set(userId, channelId);
    }
  }
  return result;
}

module.exports = { inOtherRoom, join, leave, participants, isParticipant, leaveAll, activeChannelFor, forceMute, forceUnmute, isForceMuted };

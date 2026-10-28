'use strict';

// In-memory per-stage-channel speaker/raised-hand registry — same "meaningless across a restart"
// reasoning as voice.js's room registry, and keyed the same way (channels.id).
const stages = new Map(); // channelId -> { speakers: Set<userId>, raisedHands: Set<userId> }

function ensure(channelId) {
  if (!stages.has(channelId)) stages.set(channelId, { speakers: new Set(), raisedHands: new Set() });
  return stages.get(channelId);
}

function cleanupIfEmpty(channelId) {
  const s = stages.get(channelId);
  if (s && s.speakers.size === 0 && s.raisedHands.size === 0) stages.delete(channelId);
}

// `autoSpeaker` — anyone who can manage the channel joins as a speaker automatically (same as
// Discord: whoever starts/moderates a stage doesn't need to raise their hand for it).
function onJoin(channelId, userId, autoSpeaker) {
  const s = ensure(channelId);
  if (autoSpeaker) s.speakers.add(userId);
}

function onLeave(channelId, userId) {
  const s = stages.get(channelId);
  if (!s) return;
  s.speakers.delete(userId);
  s.raisedHands.delete(userId);
  cleanupIfEmpty(channelId);
}

function raiseHand(channelId, userId, raised) {
  const s = ensure(channelId);
  if (raised) s.raisedHands.add(userId); else s.raisedHands.delete(userId);
  cleanupIfEmpty(channelId);
}

function inviteSpeaker(channelId, userId) {
  const s = ensure(channelId);
  s.raisedHands.delete(userId);
  s.speakers.add(userId);
}

function moveToAudience(channelId, userId) {
  const s = ensure(channelId);
  s.speakers.delete(userId);
  cleanupIfEmpty(channelId);
}

function isSpeaker(channelId, userId) {
  return stages.get(channelId)?.speakers.has(userId) ?? false;
}

function getState(channelId) {
  const s = stages.get(channelId);
  return { speakers: [...(s?.speakers || [])], raisedHands: [...(s?.raisedHands || [])] };
}

module.exports = { onJoin, onLeave, raiseHand, inviteSpeaker, moveToAudience, isSpeaker, getState };

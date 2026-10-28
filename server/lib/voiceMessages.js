'use strict';

const fs = require('node:fs');

const MAX_DURATION_MS = 5 * 60 * 1000;
const MIN_DURATION_MS = 500;
const MAX_BYTES = 8 * 1024 * 1024;
const AUDIO_TYPE = /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac|x-m4a)(?:\s*;.*)?$/i;

class VoiceMessageError extends Error {
  constructor(message) { super(message); this.name = 'VoiceMessageError'; this.status = 400; }
}

// A voice message is a normal message with exactly one audio attachment plus the clip length the
// recorder measured. Returns null for an ordinary message, the validated length otherwise.
function parseVoiceUpload(body, files) {
  const raw = body?.voiceDurationMs;
  if (raw === undefined || raw === null || raw === '') return null;
  const list = files || [];
  if (list.length !== 1) throw new VoiceMessageError('a voice message carries exactly one audio file');
  const file = list[0];
  if (!AUDIO_TYPE.test(file.mimetype || '')) throw new VoiceMessageError('a voice message must be an audio file');
  if (file.size > MAX_BYTES) throw new VoiceMessageError('the voice message is too large');
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < MIN_DURATION_MS || ms > MAX_DURATION_MS) throw new VoiceMessageError('a voice message is between half a second and five minutes long');
  return ms;
}

// The mime type without the codec parameter, so <audio> and the stored row stay simple.
const cleanMime = (mimetype) => String(mimetype || '').split(';')[0].trim().toLowerCase();

function discardFiles(files) {
  for (const f of files || []) { try { fs.unlinkSync(f.path); } catch { /* already gone */ } }
}

module.exports = { VoiceMessageError, parseVoiceUpload, cleanMime, discardFiles, MAX_DURATION_MS, MAX_BYTES };

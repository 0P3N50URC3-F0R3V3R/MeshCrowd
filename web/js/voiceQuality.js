export const VOICE_QUALITY_PRESETS = {
  mobile: { id: 'mobile', khz: 8, bitrate: 12000, stereo: false },
  low: { id: 'low', khz: 16, bitrate: 24000, stereo: false },
  medium: { id: 'medium', khz: 24, bitrate: 48000, stereo: false },
  high: { id: 'high', khz: 48, bitrate: 96000, stereo: false },
  hd: { id: 'hd', khz: 48, bitrate: 192000, stereo: true },
};
export const VOICE_QUALITY_IDS = Object.keys(VOICE_QUALITY_PRESETS);
export const DEFAULT_VOICE_QUALITY = 'medium';

export function voiceQualityPreset(id) {
  return VOICE_QUALITY_PRESETS[id] || VOICE_QUALITY_PRESETS[DEFAULT_VOICE_QUALITY];
}

// fmtp on our SDP describes what we are willing to receive, so every participant applying the same
// preset makes both directions honour it. maxaveragebitrate is bits/s per RFC 7587.
export function tuneOpusSdp(sdp, id) {
  const p = voiceQualityPreset(id);
  const pt = /^a=rtpmap:(\d+) opus\/48000\/2\r?$/im.exec(sdp)?.[1];
  if (!pt) return sdp;
  const wanted = {
    maxaveragebitrate: p.bitrate,
    maxplaybackrate: p.khz * 1000,
    stereo: p.stereo ? 1 : 0,
    'sprop-stereo': p.stereo ? 1 : 0,
    useinbandfec: 1,
  };
  const fmtpRe = new RegExp(`^(a=fmtp:${pt} )(.*?)(\\r?)$`, 'm');
  const m = fmtpRe.exec(sdp);
  if (m) {
    const params = new Map(m[2].split(';').map((kv) => kv.trim()).filter(Boolean).map((kv) => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; }));
    for (const [k, v] of Object.entries(wanted)) params.set(k, String(v));
    const line = [...params].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
    return sdp.replace(fmtpRe, `$1${line}$3`);
  }
  const line = `a=fmtp:${pt} ${Object.entries(wanted).map(([k, v]) => `${k}=${v}`).join(';')}`;
  return sdp.replace(new RegExp(`^(a=rtpmap:${pt} opus/48000/2)(\\r?)$`, 'im'), `$1$2\n${line}$2`);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { tuneOpusSdp, voiceQualityPreset, VOICE_QUALITY_IDS } from './voiceQuality.js';

const SDP_WITH_FMTP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\na=rtpmap:63 red/48000/2\r\n';
const SDP_NO_FMTP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=rtcp-fb:111 transport-cc\r\n';

test('unknown preset falls back to medium', () => {
  assert.equal(voiceQualityPreset('nope').id, 'medium');
  assert.deepEqual(VOICE_QUALITY_IDS, ['mobile', 'low', 'medium', 'high', 'hd']);
});

test('rewrites existing opus fmtp and keeps unrelated params', () => {
  const out = tuneOpusSdp(SDP_WITH_FMTP, 'mobile');
  assert.match(out, /a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=12000;maxplaybackrate=8000;stereo=0;sprop-stereo=0\r\n/);
  assert.match(out, /a=rtpmap:63 red\/48000\/2\r\n/);
});

test('adds fmtp line when opus has none', () => {
  const out = tuneOpusSdp(SDP_NO_FMTP, 'hd');
  assert.match(out, /a=rtpmap:111 opus\/48000\/2\r\na=fmtp:111 maxaveragebitrate=192000;maxplaybackrate=48000;stereo=1;sprop-stereo=1;useinbandfec=1\r\na=rtcp-fb/);
});

test('sdp without opus is untouched', () => {
  const sdp = 'v=0\r\nm=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n';
  assert.equal(tuneOpusSdp(sdp, 'high'), sdp);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { linkChannelRefs } from './channelRefs.mjs';

const channels = [{ id: 1, name: 'general' }, { id: 2, name: 'általános' }, { id: 3, name: 'dev talk' }, { id: 4, name: 'dev' }, { id: 5, name: '39' }];
const label = (n) => `Open #${n}`;

test('links known channels case-insensitively with a label', () => {
  const out = linkChannelRefs('see #General now', channels, label);
  assert.match(out, /data-channel-id="1"/);
  assert.match(out, /aria-label="Open #general"/);
  assert.match(out, />#general</);
});

test('unknown names stay plain text', () => {
  assert.equal(linkChannelRefs('issue #123 and #nope', channels, label), 'issue #123 and #nope');
});

test('non-ASCII names and names with spaces match, longest first', () => {
  assert.match(linkChannelRefs('go #általános!', channels, label), /data-channel-id="2"/);
  assert.match(linkChannelRefs('go #dev talk please', channels, label), /data-channel-id="3"/);
  assert.match(linkChannelRefs('go #dev please', channels, label), /data-channel-id="4"/);
});

test('does not match inside longer words or HTML entities', () => {
  assert.equal(linkChannelRefs('#generalities', channels, label), '#generalities');
  assert.equal(linkChannelRefs('it&#39;s', channels, label), 'it&#39;s');
  assert.equal(linkChannelRefs('a#general', channels, label), 'a#general');
});

test('no channels means no change', () => {
  assert.equal(linkChannelRefs('#general', [], label), '#general');
  assert.equal(linkChannelRefs('#general', null, label), '#general');
});

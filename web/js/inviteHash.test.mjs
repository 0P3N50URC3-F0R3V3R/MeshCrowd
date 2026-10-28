import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInviteHash, inviteLinkFor } from './inviteHash.mjs';

test('parseInviteHash accepts plain, vanity and encoded federated codes', () => {
  assert.equal(parseInviteHash('#invite=abc12345'), 'abc12345');
  assert.equal(parseInviteHash('#invite=my-server'), 'my-server');
  assert.equal(parseInviteHash('#invite=abc%40other.example'), 'abc@other.example');
});

test('parseInviteHash rejects malformed values', () => {
  for (const h of ['', '#invite=', '#invite=a b', '#invite=%E0%A4%A', '#invite=<x>', '#invite=a&b=c', '#msg=channel:1:2:3', '#invite=' + 'a'.repeat(129)]) assert.equal(parseInviteHash(h), null, h);
});

test('inviteLinkFor builds an /i/ link', () => {
  assert.equal(inviteLinkFor('abc@d.example', 'https://x:8443'), 'https://x:8443/i/abc%40d.example');
});

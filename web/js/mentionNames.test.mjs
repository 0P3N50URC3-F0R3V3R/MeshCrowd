import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionNamesFor } from './mentionNames.mjs';

test('server scope: usernames, single-word roles, everyone and here', () => {
  const detail = { members: [{ user: { username: 'Mara' } }], roles: [{ name: 'Mods' }, { name: 'two words' }, { name: '' }] };
  const set = mentionNamesFor({ detail });
  assert.deepEqual([...set].sort(), ['everyone', 'here', 'mara', 'mods']);
  assert.equal(mentionNamesFor({ detail }), set);
  detail.members.push({ user: { username: 'zed' } });
  assert.ok(mentionNamesFor({ detail }).has('zed'));
});

test('dm scope: only the participants; no data: undefined', () => {
  assert.deepEqual([...mentionNamesFor({ dmMembers: [{ username: 'Ann' }, { username: 'bo' }] })], ['ann', 'bo']);
  assert.equal(mentionNamesFor({}), undefined);
  assert.equal(mentionNamesFor(), undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { memberRoleIcon } from './roleIcon.js';

const roles = [
  { id: 1, name: '@everyone', is_default: 1, position: 0, icon_emoji: '👋' },
  { id: 2, name: 'Mod', position: 3, icon_emoji: '🛡️' },
  { id: 3, name: 'Gamer', position: 2, icon_path: '/uploads/roleicons/3-a.png' },
  { id: 4, name: 'Plain', position: 5 },
];

test('the highest role that has an icon wins, plain roles and @everyone are ignored', () => {
  assert.deepEqual(memberRoleIcon(roles, { roleIds: [2, 3, 4] }), { name: 'Mod', path: null, emoji: '🛡️' });
  assert.deepEqual(memberRoleIcon(roles, { roleIds: [3, 4] }), { name: 'Gamer', path: '/uploads/roleicons/3-a.png', emoji: null });
});

test('no icon when the member has no role with one', () => {
  assert.equal(memberRoleIcon(roles, { roleIds: [4] }), null);
  assert.equal(memberRoleIcon(roles, { roleIds: [] }), null);
  assert.equal(memberRoleIcon(roles, null), null);
});

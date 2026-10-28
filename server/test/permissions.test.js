'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PERMISSIONS, has, SITE_PERMISSIONS, hasSite } = require('../lib/permissions');

test('has() requires the exact flag to be set', () => {
  const bits = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES;
  assert.equal(has(bits, PERMISSIONS.VIEW_CHANNEL), true);
  assert.equal(has(bits, PERMISSIONS.MANAGE_CHANNELS), false);
});

test('has() ADMINISTRATOR bypasses every other flag', () => {
  const bits = PERMISSIONS.ADMINISTRATOR;
  assert.equal(has(bits, PERMISSIONS.BAN_MEMBERS), true);
  assert.equal(has(bits, PERMISSIONS.MANAGE_ROLES), true);
});

test('has() with zero bits denies everything', () => {
  assert.equal(has(0, PERMISSIONS.VIEW_CHANNEL), false);
});

test('site permissions mirror the same ADMINISTRATOR-bypass shape', () => {
  assert.equal(hasSite(SITE_PERMISSIONS.SITE_ADMINISTRATOR, SITE_PERMISSIONS.MANAGE_USERS), true);
  assert.equal(hasSite(SITE_PERMISSIONS.VIEW_ADMIN_PANEL, SITE_PERMISSIONS.MANAGE_USERS), false);
});

test('permission bit values are all distinct powers of two', () => {
  const values = Object.values(PERMISSIONS);
  const seen = new Set();
  for (const v of values) {
    assert.equal(v & (v - 1), 0, `${v} is not a power of two`);
    assert.equal(seen.has(v), false, `duplicate bit ${v}`);
    seen.add(v);
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scopeKey, pruneRecent, clearRecentOnFocus } = require('./trayState');
const { unreadBadgeLayout, buildTrayIconPNG, ICON_SIZE } = require('./trayIcon');

test('pruneRecent drops entries whose scope was read', () => {
  const recent = [{ scopeType: 'dm', scopeId: 1 }, { scopeType: 'channel', scopeId: 2 }, { scopeType: 'dm', scopeId: 1 }];
  assert.deepEqual(pruneRecent(recent, ['dm:1']), [{ scopeType: 'channel', scopeId: 2 }]);
  assert.equal(pruneRecent(recent, []).length, 3);
  assert.equal(scopeKey({ scopeType: 'friends', scopeId: 'pending' }), 'friends:pending');
});

test('recent list is cleared on focus only with nothing unread', () => {
  assert.equal(clearRecentOnFocus(0), true);
  assert.equal(clearRecentOnFocus(2), false);
});

test('unread badge is large and fits inside the icon for every label length', () => {
  for (const count of [1, 9, 10, 99, 100, 1000]) {
    const L = unreadBadgeLayout(count);
    assert.ok(L.pillH >= ICON_SIZE * 0.5, `pill height for ${count}`);
    assert.ok(L.pillX - L.ring >= 0 && L.pillX + L.pillW + L.ring <= ICON_SIZE);
    assert.ok(L.pillY - L.ring >= 0 && L.pillY + L.pillH + L.ring <= ICON_SIZE);
    assert.ok(L.textX >= L.pillX && L.textY >= L.pillY);
  }
  assert.equal(unreadBadgeLayout(150).label, '99+');
  assert.ok(unreadBadgeLayout(5).glyphScale > unreadBadgeLayout(50).glyphScale);
});

test('normal icon is untouched by the badge and unread icon differs', () => {
  const plain = buildTrayIconPNG({ status: 'online', count: 0 });
  const unread = buildTrayIconPNG({ status: 'online', count: 5 });
  assert.equal(plain.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.notDeepEqual(plain, unread);
});

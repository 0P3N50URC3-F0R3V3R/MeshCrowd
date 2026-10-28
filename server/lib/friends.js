'use strict';

const { db } = require('../db');

function pairKey(a, b) {
  return a < b ? [a, b] : [b, a];
}

function getFriendship(a, b) {
  const [x, y] = pairKey(a, b);
  return db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').get(x, y);
}

function areFriends(a, b) {
  const f = getFriendship(a, b);
  return !!f && f.status === 'accepted';
}

function isBlocked(a, b) {
  const f = getFriendship(a, b);
  return !!f && f.status === 'blocked';
}

module.exports = { pairKey, getFriendship, areFriends, isBlocked };

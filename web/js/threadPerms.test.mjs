import test from 'node:test';
import assert from 'node:assert/strict';
import { canEditPost, canDeletePost } from './threadPerms.mjs';

const post = { id: 5, createdBy: { id: 1 }, messageCount: 3, lastMessageAt: 'a' };

test('only the author may edit a post', () => {
  assert.equal(canEditPost(post, { id: 1, isSiteAdmin: true }) , true);
  assert.equal(canEditPost(post, { id: 2, isSiteAdmin: true }), false);
});

test('author, MANAGE_MESSAGES holders and site admins may delete', () => {
  assert.equal(canDeletePost(post, { id: 1 }), true);
  assert.equal(canDeletePost(post, { id: 2 }, { canManage: true }), true);
  assert.equal(canDeletePost(post, { id: 2, isSiteAdmin: true }), true);
  assert.equal(canDeletePost(post, { id: 2 }), false);
});

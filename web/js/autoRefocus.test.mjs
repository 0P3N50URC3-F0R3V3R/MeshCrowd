import test from 'node:test';
import assert from 'node:assert/strict';
import { isTextField, focusWasLost, isSendButton, restoreTarget } from './autoRefocus.mjs';

const btn = (o) => ({ id: '', className: '', type: 'button', hasAttribute: () => false, getAttribute: () => null, ...o });

test('focus is lost only when nothing or the button/disabled/removed element has it', () => {
  const body = {};
  assert.equal(focusWasLost(null, body, null), true);
  assert.equal(focusWasLost(body, body, null), true);
  const b = {};
  assert.equal(focusWasLost(b, body, b), true);
  assert.equal(focusWasLost({ tagName: 'INPUT' }, body, b), false);
});

test('send-like buttons refocus, cancel/emoji/attach do not', () => {
  assert.equal(isSendButton(btn({ id: 'btn-send' })), true);
  assert.equal(isSendButton(btn({ id: 'notes-save' })), true);
  assert.equal(isSendButton(btn({ id: 'btn-emoji' })), false);
  assert.equal(isSendButton(btn({ id: 'reply-cancel' })), false);
  assert.equal(isSendButton(btn({ id: 'x', type: 'submit' })), true);
  assert.equal(isSendButton(btn({ id: 'c-add' }), true), false);
});

test('text field detection skips readonly, disabled and checkboxes', () => {
  assert.equal(isTextField({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextField({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isTextField({ tagName: 'INPUT', type: 'text', readOnly: true }), false);
});

test('a re-rendered input is found again by id', () => {
  const fresh = { tagName: 'TEXTAREA' };
  const doc = { getElementById: (id) => (id === 'composer-input' ? fresh : null) };
  assert.equal(restoreTarget({ el: { isConnected: false }, id: 'composer-input' }, doc), fresh);
  assert.equal(restoreTarget({ el: { isConnected: false }, id: 'gone' }, doc), null);
});

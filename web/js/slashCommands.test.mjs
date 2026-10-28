import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, usageOf, parseInvocation, missingRequired } from './slashCommands.js';

const roll = { name: 'roll', options: [{ name: 'sides', type: 'integer', required: true }, { name: 'note', type: 'string' }] };

test('usage shows required and optional options with their types', () => {
  assert.equal(usageOf(roll), '/roll <sides:integer> [note]');
  assert.equal(usageOf({ name: 'ping', options: [] }), '/ping');
});

test('tokenize keeps quoted text together', () => {
  assert.deepEqual(tokenize('a "b c" d').map((t) => t.value), ['a', 'b c', 'd']);
});

test('options are positional and the last string option takes the rest of the line', () => {
  assert.deepEqual(parseInvocation(roll, '20'), { sides: '20' });
  assert.deepEqual(parseInvocation(roll, '20 for the   boss fight'), { sides: '20', note: 'for the   boss fight' });
  assert.deepEqual(parseInvocation(roll, '20 "quoted note"'), { sides: '20', note: 'quoted note' });
  assert.deepEqual(parseInvocation(roll, ''), {});
});

test('name:value works for any option, in any order', () => {
  assert.deepEqual(parseInvocation(roll, 'note:hello sides:6'), { note: 'hello', sides: '6' });
  assert.deepEqual(parseInvocation(roll, 'sides:6 note text'), { sides: '6', note: 'note text' });
});

test('missingRequired names the first absent required option', () => {
  assert.equal(missingRequired(roll, {}), 'sides');
  assert.equal(missingRequired(roll, { sides: '6' }), null);
});

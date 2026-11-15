import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePollArgs, parseChecklistArgs } from './slashLists.mjs';

test('/poll splits the question and options on pipes and trims them', () => {
  assert.deepEqual(parsePollArgs('Pizza tonight? | Yes | No | Maybe'), { ok: true, question: 'Pizza tonight?', options: ['Yes', 'No', 'Maybe'], multiSelect: false });
});

test('/poll --multi at the end switches on multiple answers and is not part of an option', () => {
  assert.deepEqual(parsePollArgs('Toppings | Ham | Corn | Olives --multi'), { ok: true, question: 'Toppings', options: ['Ham', 'Corn', 'Olives'], multiSelect: true });
});

test('/poll needs a question and between 2 and 10 distinct options', () => {
  assert.deepEqual(parsePollArgs(''), { ok: false, error: 'usage' });
  assert.deepEqual(parsePollArgs('Only a question'), { ok: false, error: 'options' });
  assert.deepEqual(parsePollArgs('Q | one'), { ok: false, error: 'options' });
  assert.deepEqual(parsePollArgs('Q | same | same'), { ok: false, error: 'options' });
  assert.equal(parsePollArgs(`Q | ${Array.from({ length: 11 }, (_, i) => `o${i}`).join(' | ')}`).error, 'options');
  assert.equal(parsePollArgs(`Q | ${Array.from({ length: 10 }, (_, i) => `o${i}`).join(' | ')}`).ok, true);
});

test('/poll ignores empty segments from stray pipes', () => {
  assert.deepEqual(parsePollArgs('Q || a | | b |').options, ['a', 'b']);
});

test('/checklist takes the title first, then one or more items', () => {
  assert.deepEqual(parseChecklistArgs('Groceries | milk | eggs | bread'), { ok: true, title: 'Groceries', items: ['milk', 'eggs', 'bread'] });
  assert.deepEqual(parseChecklistArgs('Todo | one'), { ok: true, title: 'Todo', items: ['one'] });
});

test('/checklist needs a title, at least one item and at most 50', () => {
  assert.deepEqual(parseChecklistArgs(''), { ok: false, error: 'usage' });
  assert.deepEqual(parseChecklistArgs('Just a title'), { ok: false, error: 'items' });
  assert.equal(parseChecklistArgs(`T | ${Array.from({ length: 51 }, (_, i) => `i${i}`).join(' | ')}`).error, 'items');
  assert.equal(parseChecklistArgs(`T | ${Array.from({ length: 50 }, (_, i) => `i${i}`).join(' | ')}`).ok, true);
});

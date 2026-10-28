import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_MAX, parseHistory, rememberQuery, fieldsParam } from './searchHistory.mjs';

test('rememberQuery trims, dedupes to the front and caps the list', () => {
  assert.deepEqual(rememberQuery(['a', 'b'], '  b '), ['b', 'a']);
  assert.deepEqual(rememberQuery(['a'], '   '), ['a']);
  const long = Array.from({ length: HISTORY_MAX }, (_, i) => `q${i}`);
  const next = rememberQuery(long, 'new');
  assert.equal(next.length, HISTORY_MAX);
  assert.equal(next[0], 'new');
});

test('parseHistory survives garbage', () => {
  assert.deepEqual(parseHistory('not json'), []);
  assert.deepEqual(parseHistory('{"a":1}'), []);
  assert.deepEqual(parseHistory('["x", 3, "y"]'), ['x', 'y']);
  assert.deepEqual(parseHistory(null), []);
});

test('fieldsParam joins the selected field keys', () => {
  assert.equal(fieldsParam(new Set(['text', 'mentions'])), 'text,mentions');
  assert.equal(fieldsParam(new Set()), '');
});

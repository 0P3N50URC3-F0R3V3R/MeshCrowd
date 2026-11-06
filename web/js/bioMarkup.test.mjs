import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBio, bioPlain, applyFormat } from './bioMarkup.mjs';

test('renders bold, italic and color', () => {
  assert.equal(renderBio('**hi** *there* [#ff0000]red[/]'), '<b>hi</b> <i>there</i> <span style="color:#ff0000">red</span>');
});

test('escapes html and rejects non-hex colors', () => {
  assert.equal(renderBio('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.equal(renderBio('[#ff0000" onclick="x]a[/]'), '[#ff0000&quot; onclick=&quot;x]a[/]');
  assert.equal(renderBio('[red]a[/]'), '[red]a[/]');
});

test('plain text strips markup', () => {
  assert.equal(bioPlain('**a** *b* [#00ff00]c[/]'), 'a b c');
});

test('applyFormat wraps the selection and keeps it selected', () => {
  const r = applyFormat('hello world', 6, 11, 'bold');
  assert.deepEqual(r, { value: 'hello **world**', selStart: 8, selEnd: 13 });
  assert.equal(applyFormat('ab', 0, 2, 'color', '#112233').value, '[#112233]ab[/]');
  assert.equal(applyFormat('ab', 1, 1, 'italic').value, 'a**b');
});

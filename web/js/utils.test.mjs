import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessageContent, renderCompactSticker, avatarHtml, colorForId, initials } from './utils.js';
import { SHRUG } from './builtinSlash.js';

test('shrug renders with its underscores intact', () => {
  assert.equal(renderMessageContent(SHRUG), '¯\\_(ツ)_/¯');
});

test('backslash makes markdown characters literal', () => {
  assert.equal(renderMessageContent('\\*not bold\\*'), '*not bold*');
  assert.equal(renderMessageContent('\\_a\\_'), '_a_');
});

test('unescaped markdown and plain backslashes are unchanged', () => {
  assert.equal(renderMessageContent('_a_'), '<em>a</em>');
  assert.equal(renderMessageContent('C:\\dir\\file'), 'C:\\dir\\file');
});

test('compact sticker renders an escaped image, or nothing', () => {
  assert.equal(renderCompactSticker(null, 'x'), '');
  const html = renderCompactSticker({ name: 'a"b', imagePath: '/uploads/stickers/x.png' }, 'sr-attachments');
  assert.match(html, /^<div class="sr-attachments"><img class="compact-sticker" src="\/uploads\/stickers\/x\.png"/);
  assert.ok(!html.includes('a"b'));
});

test('uploaded avatar picture has no background color unless avatarBackground is on', () => {
  const user = { id: 3, username: 'a', displayName: 'A', avatarPath: '/uploads/avatars/x.png' };
  assert.doesNotMatch(avatarHtml(user, 40), /background/);
  assert.doesNotMatch(avatarHtml({ ...user, avatarBackground: false }, 40), /background/);
  assert.match(avatarHtml({ ...user, avatarBackground: true }, 40), new RegExp(`background:${colorForId(3)}`));
});

test('avatar without a picture keeps the colored initial circle regardless of avatarBackground', () => {
  const user = { id: 3, username: 'a', displayName: 'Anna Bo' };
  for (const avatarBackground of [undefined, false, true]) {
    const html = avatarHtml({ ...user, avatarBackground }, 40);
    assert.match(html, new RegExp(`background:${colorForId(3)}`));
    assert.match(html, />AB</);
  }
});

test('trailing punctuation and an unbalanced paren stay out of the link', () => {
  const a = (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`;
  assert.equal(renderMessageContent('(see https://x.com/q).'), `(see ${a('https://x.com/q')}).`);
  assert.equal(renderMessageContent('go to https://x.com, now'), `go to ${a('https://x.com')}, now`);
  assert.equal(renderMessageContent('https://x.com/a_(b)_c ok'), `${a('https://x.com/a_(b)_c')} ok`);
  assert.equal(renderMessageContent('https://x.com/?a=1&b=2'), a('https://x.com/?a=1&amp;b=2'));
});

test('initials never split an emoji surrogate pair', () => {
  assert.equal(initials('\u{1F600}'), '\u{1F600}');
  assert.equal(initials('\u{1F600}x'), '\u{1F600}X');
  assert.equal(initials('\u{1F600} Bob'), '\u{1F600}B');
  assert.equal(initials('ada lovelace'), 'AL');
});

const A = (url, text = url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;

test('backslash-backtick is a literal backtick', () => {
  assert.equal(renderMessageContent('a \\` b'), 'a ` b');
  assert.equal(renderMessageContent('\\`not code\\`'), '`not code`');
  assert.equal(renderMessageContent('\\``x`'), '`<code class="md-code">x</code>');
});

test('double-backtick spans may contain single backticks', () => {
  assert.equal(renderMessageContent('``code with ` inside``'), '<code class="md-code">code with ` inside</code>');
  assert.equal(renderMessageContent('`` `x` ``'), '<code class="md-code">`x`</code>');
  assert.equal(renderMessageContent('``<b>x</b>``'), '<code class="md-code">&lt;b&gt;x&lt;/b&gt;</code>');
  assert.equal(renderMessageContent('`a` and `b`'), '<code class="md-code">a</code> and <code class="md-code">b</code>');
});

test('markdown links for http, https and mailto', () => {
  assert.equal(renderMessageContent('[site](https://x.com/a?b=1&c=2)'), A('https://x.com/a?b=1&amp;c=2', 'site'));
  assert.equal(renderMessageContent('see [docs](http://x.com) now'), `see ${A('http://x.com', 'docs')} now`);
  assert.equal(renderMessageContent('[mail me](mailto:a@b.co)'), A('mailto:a@b.co', 'mail me'));
  assert.equal(renderMessageContent('[w](https://en.wikipedia.org/wiki/A_(b))'), A('https://en.wikipedia.org/wiki/A_(b)', 'w'));
});

test('markdown links: label keeps inline markup, no nested autolink', () => {
  assert.equal(renderMessageContent('[**bold**](https://x.com)'), A('https://x.com', '<strong>bold</strong>'));
  assert.equal(renderMessageContent('[`c`](https://x.com)'), A('https://x.com', '<code class="md-code">c</code>'));
  assert.equal(renderMessageContent('[https://a.com](https://b.com)'), A('https://b.com', 'https://a.com'));
  assert.equal(renderMessageContent('[@mara](https://x.com)'), A('https://x.com', '@mara'));
});

test('markdown links reject dangerous schemes and escape everything', () => {
  for (const bad of ['[x](javascript:alert(1))', '[x](JavaScript:alert(1))', '[x](data:text/html,<script>alert(1)</script>)', '[x]( javascript:alert(1))', '[x](vbscript:x)', '[x](//evil.com)']) {
    const out = renderMessageContent(bad);
    assert.ok(!/<a href="(javascript|data|vbscript|\/\/)/i.test(out), out);
    assert.ok(!out.includes('<script'), out);
  }
  assert.equal(renderMessageContent('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  const q = renderMessageContent('[a](https://x.com/"onmouseover="alert(1))');
  assert.ok(!/<a [^>]*onmouseover/.test(q) || q.includes('&quot;onmouseover'), q);
  assert.ok(!q.includes('"onmouseover'), q);
  const q2 = renderMessageContent(`[a](https://x.com/'x onclick='y)`);
  assert.ok(!/<a [^>]*\sonclick/.test(q2), q2);
  assert.equal(renderMessageContent('[<img src=x onerror=alert(1)>](https://x.com)'), A('https://x.com', '&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(renderMessageContent('[x](https://x.com/<script>)'), A('https://x.com/&lt;script&gt;', 'x'));
});

test('a URL directly followed by a code span keeps the marker out of the link', () => {
  assert.equal(renderMessageContent('https://x.com`code`'), `${A('https://x.com')}<code class="md-code">code</code>`);
  assert.equal(renderMessageContent('see https://x.com/a`b` end'), `see ${A('https://x.com/a')}<code class="md-code">b</code> end`);
  assert.ok(!renderMessageContent('https://x.com``a`b``').includes('\x01'));
});

test('mentions are styled only when they resolve', () => {
  const names = new Set(['mara', 'everyone', 'mods']);
  assert.equal(renderMessageContent('hi @mara', { mentionNames: names }), 'hi <span class="mention">@mara</span>');
  assert.equal(renderMessageContent('hi @MARA!', { mentionNames: names }), 'hi <span class="mention">@MARA</span>!');
  assert.equal(renderMessageContent('@everyone @mods', { mentionNames: names }), '<span class="mention">@everyone</span> <span class="mention">@mods</span>');
  assert.equal(renderMessageContent('hi @nobody', { mentionNames: names }), 'hi @nobody');
  assert.equal(renderMessageContent('mail me@example.com', { mentionNames: names }), 'mail me@example.com');
  assert.equal(renderMessageContent('@mara.', { mentionNames: names }), '<span class="mention">@mara</span>.');
  assert.equal(renderMessageContent('hi @mara'), 'hi @mara');
  assert.equal(renderMessageContent('hi @mara', { mentionNames: names, remote: true }), 'hi @mara');
});

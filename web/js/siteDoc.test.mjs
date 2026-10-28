import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitDocument, joinDocument, tokenizePhp, protectPhp, restorePhp, relativeAsset, isVisualCandidate, modeForPath, canonicalHtml,
} from './siteDoc.js';

const DOC = '<?php $t = "x"; ?>\n<!doctype html><html><head><title><?= $t ?></title></head>\n<body class="<?= $c ?>">\n<h1>Hi</h1>\n<?php include "nav.php"; ?>\n</body></html>\n';

test('splitDocument/joinDocument round-trip, even with PHP inside the body tag', () => {
  const s = splitDocument(DOC);
  assert.equal(s.prefix.endsWith('<body class="<?= $c ?>">'), true);
  assert.equal(s.suffix.startsWith('</body>'), true);
  assert.match(s.body, /<h1>Hi<\/h1>/);
  assert.equal(joinDocument(s), DOC);
});

test('splitDocument treats a fragment without <body> as all body', () => {
  assert.deepEqual(splitDocument('<p>x</p>'), { prefix: '', body: '<p>x</p>', suffix: '' });
});

test('tokenizePhp pulls out every block including short echo tags and an unterminated one', () => {
  const { text, blocks } = tokenizePhp('a<?php echo 1; ?>b<?= $x ?>c<?php if (1) {');
  assert.equal(blocks.length, 3);
  assert.doesNotMatch(text, /<\?/);
  assert.deepEqual(blocks, ['<?php echo 1; ?>', '<?= $x ?>', '<?php if (1) {']);
});

test('protectPhp: chips in text, plain tokens in attributes/script/style/comments; restore is byte-exact', () => {
  const body = '<div class="<?= $c ?>"><?php include "a.php"; ?><p>x</p>'
    + '<script>var a = "<?= $js ?>";</script><style>p{width:<?= $w ?>px}</style><!-- <?php c(); ?> --></div>';
  const { html, blocks } = protectPhp(body);
  assert.match(html, /<span class="php-ph" contenteditable="false" data-php="1"/);
  assert.match(html, /class="__PHPBLK_0__"/);
  assert.doesNotMatch(html, /<span[^>]*data-php="[023]/);
  assert.doesNotMatch(html, /<\?/);
  assert.equal(restorePhp(html, blocks), body);
});

test('restorePhp survives attribute reordering of a chip by the visual editor', () => {
  const { html, blocks } = protectPhp('<p><?= $a ?></p>');
  const mangled = html.replace('class="php-ph" contenteditable="false" data-php="0"', 'data-php="0" class="php-ph" contenteditable="false"');
  assert.equal(restorePhp(mangled, blocks), '<p><?= $a ?></p>');
});

test('relativeAsset computes a path relative to the page', () => {
  assert.equal(relativeAsset('index.php', 'assets/a.png'), 'assets/a.png');
  assert.equal(relativeAsset('docs/x.html', 'assets/a.png'), '../assets/a.png');
  assert.equal(relativeAsset('docs/x.html', 'docs/img/a.png'), 'img/a.png');
  assert.equal(relativeAsset('a/b/c.html', 'a/x.png'), '../x.png');
});

test('isVisualCandidate and modeForPath classify by extension', () => {
  assert.equal(isVisualCandidate('a.html'), true);
  assert.equal(isVisualCandidate('a.PHP'), true);
  assert.equal(isVisualCandidate('a.css'), false);
  assert.equal(modeForPath('a.php'), 'application/x-httpd-php');
  assert.equal(modeForPath('a.htm'), 'htmlmixed');
  assert.equal(modeForPath('a.js'), 'javascript');
  assert.deepEqual(modeForPath('a.json'), { name: 'javascript', json: true });
  assert.equal(modeForPath('a.css'), 'css');
  assert.equal(modeForPath('a.svg'), 'xml');
  assert.equal(modeForPath('a.md'), 'text/plain');
});

test('canonicalHtml normalises whitespace through the supplied parser', () => {
  const parse = (h) => h;
  assert.equal(canonicalHtml('<p>a</p>\n  <p>b</p>', parse), canonicalHtml('<p>a</p><p>b</p>', parse));
  assert.notEqual(canonicalHtml('<p>a</p>', parse), canonicalHtml('<div>a</div>', parse));
});

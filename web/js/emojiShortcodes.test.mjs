import test from 'node:test';
import assert from 'node:assert/strict';
import { EMOJI_SHORTCODES } from './emojiShortcodes.js';

test('every shortcode name matches the renderer pattern and maps to an emoji', () => {
  for (const [name, glyph] of Object.entries(EMOJI_SHORTCODES)) {
    assert.match(name, /^[a-zA-Z0-9_+-]{2,32}$/, name);
    assert.ok(glyph.length > 0, name);
  }
});

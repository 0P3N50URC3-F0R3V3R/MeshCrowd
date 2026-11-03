import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = { localStorage: { getItem: () => 'hu' } };
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(`lang/${url.split('/').pop()}`, 'utf8')) });

const { initI18n, translateError } = await import('./i18n.js');
await initI18n({ language: 'hu' });

test('exact message is translated', () => {
  assert.equal(translateError('invalid credentials'), 'Érvénytelen bejelentkezési adatok');
});

test('placeholder message is translated with its value', () => {
  assert.equal(translateError('pin limit reached (50)'), 'Elérted a kitűzések korlátját (50)');
  assert.equal(translateError('attachment too large - max 25MB'), 'A csatolmány túl nagy – legfeljebb 25 MB lehet');
});

test('unknown message passes through', () => {
  assert.equal(translateError('something brand new'), 'something brand new');
});

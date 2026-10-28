// Merges a JSON fragment into lang/en.json and lang/hu.json.
// Usage: node scripts/add-lang.mjs <fragment.json>
// The fragment is { "path.to.group": { "en": { key: text }, "hu": { key: text } } }; the group is created if missing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fragment = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

for (const lang of ['en', 'hu']) {
  const file = path.join(root, 'lang', `${lang}.json`);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [group, texts] of Object.entries(fragment)) {
    let node = json;
    for (const part of group.split('.')) node = node[part] ??= {};
    Object.assign(node, texts[lang]);
  }
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}
console.log('merged', Object.keys(fragment).join(', '));

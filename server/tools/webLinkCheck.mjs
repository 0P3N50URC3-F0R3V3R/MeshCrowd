import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Links (never evaluates) every browser module so a missing or renamed named export fails here
// instead of blanking the app in the browser. Bare specifiers (libsodium, resolved by the page's
// import map) are stubbed with a default export.
const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const roots = [path.join(webRoot, 'js'), path.join(webRoot, 'm')];

function listModules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listModules(p);
    return /\.(js|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

const cache = new Map();
function load(file) {
  if (!cache.has(file)) {
    cache.set(file, new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: pathToFileURL(file).href }));
  }
  return cache.get(file);
}

async function linker(specifier, referencing) {
  if (/^\.\.?\//.test(specifier)) {
    return load(fileURLToPath(new URL(specifier, referencing.identifier)));
  }
  if (specifier.startsWith('/') || specifier.startsWith('node:')) throw new Error(`unexpected specifier ${specifier} in ${referencing.identifier}`);
  const stub = new vm.SyntheticModule(['default'], function () { this.setExport('default', {}); });
  return stub;
}

const failures = [];
for (const file of roots.flatMap(listModules)) {
  try {
    const m = load(file); if (m.status === 'unlinked') await m.link(linker);
  } catch (err) {
    failures.push(`${path.relative(webRoot, file)}: ${err.message}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`linked ${cache.size} modules`);

// Measures how long POST /messages takes for a server with many members. Usage: node scripts/bench-send.mjs [members=300] [messages=30]
// Starts a throwaway server on :8098 with its own data dir, seeds fake members straight into SQLite.
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MEMBERS = Number(process.argv[2] || 300);
const COUNT = Number(process.argv[3] || 30);
const PORT = 8098;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ useHttps: false, port: PORT }));
let d = new DatabaseSync(path.join(dir, 'dismesh.db'));
d.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
d.prepare('INSERT OR IGNORE INTO meta (key,value) VALUES (?,?)').run('security_settings', JSON.stringify({ captcha: { registerRequired: false } }));
d.close();
const srv = spawn('node', [...(process.env.BENCH_PROF ? ['--cpu-prof', '--cpu-prof-dir=' + process.env.BENCH_PROF] : []), 'server/index.js'], { env: { ...process.env, DISMESH_DATA_DIR: dir }, stdio: 'ignore' });
const stop = () => { try { srv.kill(); } catch { /* gone */ } };
process.on('exit', stop);
const BASE = `http://localhost:${PORT}`;
let cookie = '';
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() || [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p} ${res.status} ${JSON.stringify(j)}`);
  return j;
};
for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
await api('POST', '/api/auth/register', { username: 'sender', displayName: 'Sender', email: 'sender@x.local', password: 'benchpass123' });
const { server } = await api('POST', '/api/servers', { name: 'Bench', visibility: 'private' });
const detail = await api('GET', `/api/servers/${server.id}`);
const channel = detail.channels.find((c) => c.type === 'public' || c.name === 'general');

d = new DatabaseSync(path.join(dir, 'dismesh.db'));
d.exec('BEGIN');
const insU = d.prepare("INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, 'x', ?)");
const insM = d.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)');
for (let i = 0; i < MEMBERS; i++) { const r = insU.run(`u${i}`, `u${i}@x.local`, `User ${i}`); insM.run(server.id, r.lastInsertRowid); }
d.exec('COMMIT'); d.close();

const probe = async (label, fn) => { const a = []; for (let i = 0; i < 10; i++) { const t = performance.now(); await fn(); a.push(performance.now() - t); } a.sort((x, y) => x - y); console.log(`${label} median=${a[5].toFixed(0)}ms`); };
await probe('GET /api/config (no auth)', () => fetch(BASE + '/api/config').then((r) => r.text()));
await probe('GET server detail (auth)', () => api('GET', `/api/servers/${server.id}`));
const times = [];
for (let i = 0; i < COUNT; i++) {
  const t = performance.now();
  await api('POST', `/api/servers/${server.id}/channels/${channel.id}/messages`, { content: process.env.BENCH_MENTION ? `@everyone bench message ${i}` : `bench message ${i}` });
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const q = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(0);
console.log(`members=${MEMBERS} messages=${COUNT}  median=${q(0.5)}ms  p95=${q(0.95)}ms  max=${times.at(-1).toFixed(0)}ms`);
stop();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* server still releasing the files */ }
process.exit(0);

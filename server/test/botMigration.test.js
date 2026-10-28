'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const LEGACY_BOTS = `
CREATE TABLE bots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  provider_id      INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE RESTRICT,
  model            TEXT NOT NULL,
  persona          TEXT NOT NULL DEFAULT '',
  mention_enabled  INTEGER NOT NULL DEFAULT 1,
  dm_enabled       INTEGER NOT NULL DEFAULT 0,
  context_messages INTEGER NOT NULL DEFAULT 12,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_bots_server ON bots(server_id);`;

test('a database created before API bots gets bots.provider_id/model made nullable without losing rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-mig-'));
  try {
    const legacy = new DatabaseSync(path.join(dir, 'dismesh.db'), { enableForeignKeyConstraints: false });
    legacy.exec(LEGACY_BOTS);
    legacy.prepare('INSERT INTO bots (user_id, server_id, provider_id, model, persona, dm_enabled) VALUES (?, ?, ?, ?, ?, ?)').run(11, 22, 33, 'gemma3:12b', 'be brief', 1);
    legacy.close();

    const script = `
      const { db } = require(${JSON.stringify(path.join(__dirname, '..', 'db'))});
      const cols = Object.fromEntries(db.prepare('PRAGMA table_info(bots)').all().map((c) => [c.name, c.notnull]));
      const row = db.prepare('SELECT * FROM bots').get();
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare("INSERT INTO bots (user_id, server_id, provider_id, model) VALUES (12, 22, NULL, NULL)").run();
      db.exec('PRAGMA foreign_keys = ON');
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name = 'bots'").all().map((r) => r.name);
      console.log(JSON.stringify({ cols, row, idx, fk: db.prepare('PRAGMA foreign_keys').get().foreign_keys }));
    `;
    const out = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, DISMESH_DATA_DIR: dir }, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const r = JSON.parse(out.stdout.trim().split('\n').pop());
    assert.equal(r.cols.provider_id, 0);
    assert.equal(r.cols.model, 0);
    assert.equal(r.cols.webhook_enabled, 1);
    assert.equal(r.row.provider_id, 33);
    assert.equal(r.row.model, 'gemma3:12b');
    assert.equal(r.row.persona, 'be brief');
    assert.equal(r.row.dm_enabled, 1);
    assert.equal(r.row.webhook_scope, 'mention');
    assert.ok(r.idx.includes('idx_bots_server'));
    assert.ok(r.idx.includes('trg_bots_disable_user'));
    assert.equal(r.fk, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

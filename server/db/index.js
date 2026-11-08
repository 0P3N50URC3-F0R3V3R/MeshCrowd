'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DISMESH_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'dismesh.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
for (const sub of ['avatars', 'attachments', 'servericons', 'channelicons', 'foldericons', 'certs', 'banners', 'cards', 'emoji', 'stickers', 'sounds', 'webhookicons', 'threadicons', 'roleicons', 'notefiles', 'sites']) {
  const p = path.join(DATA_DIR, sub);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const isNewDb = !fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');
// WAL + NORMAL fsyncs only at checkpoints: a crash or power loss can drop the last few commits but never corrupts the file.
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA temp_store = MEMORY;');
db.exec('PRAGMA cache_size = -32768;');
// Checkpoints sync the files, which is slow on a spinning disk. Raise the automatic threshold so a message
// send is rarely the commit that pays for one, and run the routine one on a timer instead.
db.exec('PRAGMA wal_autocheckpoint = 8000;');
setInterval(() => { try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* database closed or busy */ } }, 30_000).unref();

const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Additive column migrations for DBs created before a given column existed. schema.sql's
// CREATE TABLE IF NOT EXISTS only covers brand-new tables, not columns added to an existing one.
const COLUMN_MIGRATIONS = [
  { table: 'channels', column: 'icon_path', ddl: 'ALTER TABLE channels ADD COLUMN icon_path TEXT' },
  { table: 'users', column: 'discoverable', ddl: 'ALTER TABLE users ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 1' },
  { table: 'messages', column: 'event_type', ddl: 'ALTER TABLE messages ADD COLUMN event_type TEXT' },
  { table: 'messages', column: 'event_data', ddl: 'ALTER TABLE messages ADD COLUMN event_data TEXT' },
  { table: 'channels', column: 'event_filter', ddl: "ALTER TABLE channels ADD COLUMN event_filter TEXT NOT NULL DEFAULT '[]'" },
  { table: 'servers', column: 'description', ddl: "ALTER TABLE servers ADD COLUMN description TEXT NOT NULL DEFAULT ''" },
  { table: 'servers', column: 'visibility', ddl: "ALTER TABLE servers ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'" },
  { table: 'servers', column: 'auto_join', ddl: 'ALTER TABLE servers ADD COLUMN auto_join INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'banner_color', ddl: "ALTER TABLE users ADD COLUMN banner_color TEXT NOT NULL DEFAULT ''" },
  { table: 'users', column: 'avatar_bg', ddl: 'ALTER TABLE users ADD COLUMN avatar_bg INTEGER NOT NULL DEFAULT 0' },
  { table: 'dm_channels', column: 'closed_by', ddl: 'ALTER TABLE dm_channels ADD COLUMN closed_by INTEGER' },
  { table: 'read_state', column: 'seen_id', ddl: 'ALTER TABLE read_state ADD COLUMN seen_id INTEGER' },
  { table: 'users', column: 'avatar_bg_color', ddl: "ALTER TABLE users ADD COLUMN avatar_bg_color TEXT NOT NULL DEFAULT ''" },
  { table: 'users', column: 'banner_path', ddl: 'ALTER TABLE users ADD COLUMN banner_path TEXT' },
  { table: 'users', column: 'card_color', ddl: "ALTER TABLE users ADD COLUMN card_color TEXT NOT NULL DEFAULT ''" },
  { table: 'users', column: 'card_path', ddl: 'ALTER TABLE users ADD COLUMN card_path TEXT' },
  { table: 'users', column: 'totp_secret', ddl: 'ALTER TABLE users ADD COLUMN totp_secret TEXT' },
  { table: 'users', column: 'totp_enabled', ddl: 'ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'totp_recovery_codes', ddl: 'ALTER TABLE users ADD COLUMN totp_recovery_codes TEXT' },
  { table: 'messages', column: 'reply_to_message_id', ddl: 'ALTER TABLE messages ADD COLUMN reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL' },
  { table: 'users', column: 'server_layout', ddl: "ALTER TABLE users ADD COLUMN server_layout TEXT NOT NULL DEFAULT '[]'" },
  { table: 'channels', column: 'category_id', ddl: 'ALTER TABLE channels ADD COLUMN category_id INTEGER REFERENCES channel_categories(id) ON DELETE SET NULL' },
  { table: 'messages', column: 'pinned_at', ddl: 'ALTER TABLE messages ADD COLUMN pinned_at TEXT' },
  { table: 'messages', column: 'pinned_by', ddl: 'ALTER TABLE messages ADD COLUMN pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL' },
  { table: 'users', column: 'notify_sound_mode', ddl: "ALTER TABLE users ADD COLUMN notify_sound_mode TEXT NOT NULL DEFAULT 'auto'" },
  { table: 'users', column: 'theme', ddl: "ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT '{}'" },
  { table: 'channels', column: 'slowmode_seconds', ddl: 'ALTER TABLE channels ADD COLUMN slowmode_seconds INTEGER NOT NULL DEFAULT 0' },
  { table: 'channels', column: 'voice_quality', ddl: "ALTER TABLE channels ADD COLUMN voice_quality TEXT NOT NULL DEFAULT 'medium'" },
  { table: 'attachments', column: 'voice_ms', ddl: 'ALTER TABLE attachments ADD COLUMN voice_ms INTEGER' },
  { table: 'servers', column: 'screening_enabled', ddl: 'ALTER TABLE servers ADD COLUMN screening_enabled INTEGER NOT NULL DEFAULT 0' },
  { table: 'servers', column: 'rules_text', ddl: "ALTER TABLE servers ADD COLUMN rules_text TEXT NOT NULL DEFAULT ''" },
  { table: 'server_members', column: 'screened_at', ddl: 'ALTER TABLE server_members ADD COLUMN screened_at TEXT' },
  { table: 'servers', column: 'vanity_code', ddl: 'ALTER TABLE servers ADD COLUMN vanity_code TEXT' },
  { table: 'servers', column: 'icon_bg', ddl: 'ALTER TABLE servers ADD COLUMN icon_bg INTEGER NOT NULL DEFAULT 1' },
  { table: 'servers', column: 'icon_bg_color', ddl: "ALTER TABLE servers ADD COLUMN icon_bg_color TEXT NOT NULL DEFAULT ''" },
  { table: 'servers', column: 'delete_at', ddl: 'ALTER TABLE servers ADD COLUMN delete_at TEXT' },
  { table: 'sessions', column: 'ip', ddl: 'ALTER TABLE sessions ADD COLUMN ip TEXT' },
  { table: 'sessions', column: 'last_used_at', ddl: 'ALTER TABLE sessions ADD COLUMN last_used_at TEXT' },
  { table: 'bots', column: 'api_token_hash', ddl: 'ALTER TABLE bots ADD COLUMN api_token_hash TEXT' },
  { table: 'bots', column: 'api_token_prefix', ddl: 'ALTER TABLE bots ADD COLUMN api_token_prefix TEXT' },
  { table: 'bots', column: 'api_token_at', ddl: 'ALTER TABLE bots ADD COLUMN api_token_at TEXT' },
  { table: 'bots', column: 'webhook_enabled', ddl: 'ALTER TABLE bots ADD COLUMN webhook_enabled INTEGER NOT NULL DEFAULT 0' },
  { table: 'bots', column: 'webhook_url', ddl: 'ALTER TABLE bots ADD COLUMN webhook_url TEXT' },
  { table: 'bots', column: 'webhook_secret_enc', ddl: 'ALTER TABLE bots ADD COLUMN webhook_secret_enc TEXT' },
  { table: 'bots', column: 'webhook_scope', ddl: "ALTER TABLE bots ADD COLUMN webhook_scope TEXT NOT NULL DEFAULT 'mention'" },
  { table: 'bots', column: 'webhook_allow_private', ddl: 'ALTER TABLE bots ADD COLUMN webhook_allow_private INTEGER NOT NULL DEFAULT 0' },
  { table: 'bots', column: 'webhook_last_status', ddl: 'ALTER TABLE bots ADD COLUMN webhook_last_status TEXT' },
  { table: 'bots', column: 'webhook_last_at', ddl: 'ALTER TABLE bots ADD COLUMN webhook_last_at TEXT' },
  { table: 'server_members', column: 'timeout_until', ddl: 'ALTER TABLE server_members ADD COLUMN timeout_until TEXT' },
  { table: 'messages', column: 'embed', ddl: 'ALTER TABLE messages ADD COLUMN embed TEXT' },
  { table: 'messages', column: 'forwarded_from_message_id', ddl: 'ALTER TABLE messages ADD COLUMN forwarded_from_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL' },
  { table: 'servers', column: 'welcome_enabled', ddl: 'ALTER TABLE servers ADD COLUMN welcome_enabled INTEGER NOT NULL DEFAULT 0' },
  { table: 'servers', column: 'welcome_message', ddl: "ALTER TABLE servers ADD COLUMN welcome_message TEXT NOT NULL DEFAULT ''" },
  { table: 'messages', column: 'sticker_id', ddl: 'ALTER TABLE messages ADD COLUMN sticker_id INTEGER REFERENCES stickers(id) ON DELETE SET NULL' },
  { table: 'messages', column: 'sound_id', ddl: 'ALTER TABLE messages ADD COLUMN sound_id INTEGER REFERENCES sounds(id) ON DELETE SET NULL' },
  { table: 'messages', column: 'webhook_id', ddl: 'ALTER TABLE messages ADD COLUMN webhook_id INTEGER REFERENCES webhooks(id) ON DELETE SET NULL' },
  { table: 'users', column: 'home_instance_id', ddl: 'ALTER TABLE users ADD COLUMN home_instance_id INTEGER REFERENCES federation_peers(id) ON DELETE SET NULL' },
  { table: 'users', column: 'remote_user_id', ddl: 'ALTER TABLE users ADD COLUMN remote_user_id INTEGER' },
  { table: 'users', column: 'federated_uid', ddl: 'ALTER TABLE users ADD COLUMN federated_uid TEXT' },
  { table: 'messages', column: 'federation_peer_id', ddl: 'ALTER TABLE messages ADD COLUMN federation_peer_id INTEGER REFERENCES federation_peers(id) ON DELETE SET NULL' },
  { table: 'messages', column: 'federation_message_id', ddl: 'ALTER TABLE messages ADD COLUMN federation_message_id TEXT' },
  { table: 'server_members', column: 'name_color', ddl: 'ALTER TABLE server_members ADD COLUMN name_color TEXT' },
  { table: 'server_members', column: 'restrictions', ddl: 'ALTER TABLE server_members ADD COLUMN restrictions INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'ui_prefs', ddl: "ALTER TABLE users ADD COLUMN ui_prefs TEXT NOT NULL DEFAULT '{}'" },
  { table: 'users', column: 'language', ddl: 'ALTER TABLE users ADD COLUMN language TEXT' },
  { table: 'users', column: 'e2ee_public_key', ddl: 'ALTER TABLE users ADD COLUMN e2ee_public_key TEXT' },
  { table: 'users', column: 'passport_id', ddl: 'ALTER TABLE users ADD COLUMN passport_id TEXT' },
  { table: 'users', column: 'passport_public_key', ddl: 'ALTER TABLE users ADD COLUMN passport_public_key TEXT' },
  { table: 'users', column: 'auth_mode', ddl: "ALTER TABLE users ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'password'" },
  { table: 'users', column: 'auth_salt', ddl: 'ALTER TABLE users ADD COLUMN auth_salt TEXT' },
  { table: 'passport_audit', column: 'actor_user_id', ddl: 'ALTER TABLE passport_audit ADD COLUMN actor_user_id INTEGER' },
  { table: 'threads', column: 'icon_path', ddl: 'ALTER TABLE threads ADD COLUMN icon_path TEXT' },
  { table: 'threads', column: 'pinned', ddl: 'ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0' },
  { table: 'servers', column: 'raw_html_enabled', ddl: 'ALTER TABLE servers ADD COLUMN raw_html_enabled INTEGER NOT NULL DEFAULT 0' },
  { table: 'federation_peers', column: 'direction', ddl: "ALTER TABLE federation_peers ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound'" },
  { table: 'dm_channels', column: 'e2ee_enabled', ddl: 'ALTER TABLE dm_channels ADD COLUMN e2ee_enabled INTEGER NOT NULL DEFAULT 0' },
  { table: 'dm_channels', column: 'e2ee_enabled_at', ddl: 'ALTER TABLE dm_channels ADD COLUMN e2ee_enabled_at TEXT' },
  { table: 'dm_channels', column: 'e2ee_enabled_by', ddl: 'ALTER TABLE dm_channels ADD COLUMN e2ee_enabled_by INTEGER' },
  { table: 'notification_prefs', column: 'muted_until', ddl: 'ALTER TABLE notification_prefs ADD COLUMN muted_until TEXT' },
  { table: 'friendships', column: 'accepted_at', ddl: 'ALTER TABLE friendships ADD COLUMN accepted_at TEXT' },
  { table: 'messages', column: 'is_encrypted', ddl: 'ALTER TABLE messages ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0' },
  { table: 'reports', column: 'plaintext_evidence', ddl: 'ALTER TABLE reports ADD COLUMN plaintext_evidence TEXT' },
  { table: 'servers', column: 'kind', ddl: "ALTER TABLE servers ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'" },
  { table: 'servers', column: 'site_csp_origins', ddl: "ALTER TABLE servers ADD COLUMN site_csp_origins TEXT NOT NULL DEFAULT '[]'" },
  { table: 'users', column: 'is_bot', ddl: 'ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0' },
  { table: 'channels', column: 'nsfw', ddl: 'ALTER TABLE channels ADD COLUMN nsfw INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'nsfw_ack_at', ddl: 'ALTER TABLE users ADD COLUMN nsfw_ack_at TEXT' },
  { table: 'servers', column: 'verification_level', ddl: 'ALTER TABLE servers ADD COLUMN verification_level INTEGER NOT NULL DEFAULT 0' },
  { table: 'notifications_outbox', column: 'kind', ddl: 'ALTER TABLE notifications_outbox ADD COLUMN kind TEXT' },
  { table: 'notifications_outbox', column: 'extra_json', ddl: 'ALTER TABLE notifications_outbox ADD COLUMN extra_json TEXT' },
  { table: 'roles', column: 'icon_emoji', ddl: 'ALTER TABLE roles ADD COLUMN icon_emoji TEXT' },
  { table: 'roles', column: 'icon_path', ddl: 'ALTER TABLE roles ADD COLUMN icon_path TEXT' },
  { table: 'messages', column: 'interaction_command', ddl: 'ALTER TABLE messages ADD COLUMN interaction_command TEXT' },
  { table: 'messages', column: 'interaction_user_id', ddl: 'ALTER TABLE messages ADD COLUMN interaction_user_id INTEGER' },
  { table: 'reports', column: 'admin_notes', ddl: "ALTER TABLE reports ADD COLUMN admin_notes TEXT NOT NULL DEFAULT ''" },
  { table: 'reports', column: 'updated_at', ddl: 'ALTER TABLE reports ADD COLUMN updated_at TEXT' },
  { table: 'reports', column: 'updated_by', ddl: 'ALTER TABLE reports ADD COLUMN updated_by INTEGER' },
  { table: 'users', column: 'name_fx', ddl: 'ALTER TABLE users ADD COLUMN name_fx TEXT' },
  { table: 'roles', column: 'name_effect', ddl: 'ALTER TABLE roles ADD COLUMN name_effect TEXT' },
  { table: 'roles', column: 'name_fx', ddl: 'ALTER TABLE roles ADD COLUMN name_fx TEXT' },
  { table: 'users', column: 'name_effect', ddl: 'ALTER TABLE users ADD COLUMN name_effect TEXT' },
  { table: 'users', column: 'name_color', ddl: 'ALTER TABLE users ADD COLUMN name_color TEXT' },
  { table: 'users', column: 'notify_grid', ddl: 'ALTER TABLE users ADD COLUMN notify_grid TEXT' },
];
for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(ddl);
    console.log(`[db] migrated: added ${table}.${column}`);
  }
}
// End-to-end encrypted DMs were removed: their messages are ciphertext the server cannot read, so
// they are dropped once. The e2ee_* columns stay for old databases but nothing reads them any more.
{
  const legacy = db.prepare('SELECT COUNT(*) AS n FROM dm_channels WHERE e2ee_enabled = 1').get().n
    + db.prepare('SELECT COUNT(*) AS n FROM messages WHERE is_encrypted = 1').get().n;
  if (legacy > 0) {
    db.prepare("DELETE FROM messages WHERE is_encrypted = 1 OR event_type = 'e2ee_enabled'").run();
    db.prepare('UPDATE dm_channels SET e2ee_enabled = 0 WHERE e2ee_enabled = 1').run();
    console.log('[db] migrated: removed end-to-end encrypted DM history');
  }
  const hasFiles = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dm_e2ee_files'").get();
  if (hasFiles) db.exec('DROP TABLE dm_e2ee_files');
  require('node:fs').rmSync(require('node:path').join(DATA_DIR, 'attachments', 'e2ee'), { recursive: true, force: true });
}
// bots.provider_id / model became nullable (an API-only bot has no AI). SQLite cannot drop NOT NULL
// in place, so a DB created with the earlier schema gets the table rebuilt once.
{
  const botCols = db.prepare('PRAGMA table_info(bots)').all();
  if (botCols.some((c) => c.name === 'provider_id' && c.notnull === 1)) {
    const shared = botCols.map((c) => c.name).join(', ');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      const createSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bots'").get().sql;
      const fresh = createSql
        .replace(/CREATE TABLE "?bots"?/, 'CREATE TABLE bots_new')
        .replace(/provider_id(\s+)INTEGER NOT NULL/, 'provider_id$1INTEGER')
        .replace(/model(\s+)TEXT NOT NULL/, 'model$1TEXT');
      db.exec(fresh);
      db.exec(`INSERT INTO bots_new (${shared}) SELECT ${shared} FROM bots`);
      db.exec('DROP TABLE bots');
      db.exec('ALTER TABLE bots_new RENAME TO bots');
      db.exec('CREATE INDEX IF NOT EXISTS idx_bots_server ON bots(server_id)');
      db.exec('CREATE TRIGGER IF NOT EXISTS trg_bots_disable_user AFTER DELETE ON bots BEGIN UPDATE users SET is_disabled = 1 WHERE id = OLD.user_id; END');
      db.exec('COMMIT');
      console.log('[db] migrated: bots.provider_id/model are now nullable');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}
// MANAGE_CONSOLE joined the Owner role after installs already existed, and older Owner roles also
// miss later flags (PRUNE_DATA, MANAGE_AI), so an exact 511 match skips real installs. The role is
// recognised by how setup creates it: named Owner, holding SITE_ADMINISTRATOR, and assigned to the
// lowest-id real account. Gated on a meta marker (fresh DBs just set it) because matching by role
// name on every boot would let anyone able to name/edit a role escalate to console access; a second
// role an admin names Owner is never the first account's role, so it is not touched.
function migrateOwnerConsoleBit() {
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'owner_console_bit_migrated'").get()) return;
  const { SITE_PERMISSIONS, OWNER_SITE_PERMISSIONS } = require('../lib/permissions');
  const first = db.prepare("SELECT id FROM users WHERE username != '__webhook__' AND is_bot = 0 ORDER BY id LIMIT 1").get();
  let changes = 0;
  if (first) {
    changes = db.prepare(
      `UPDATE site_roles SET permissions = permissions | ?
        WHERE name = 'Owner' AND (permissions & ?) != 0
          AND id IN (SELECT role_id FROM user_site_roles WHERE user_id = ?)`,
    ).run(OWNER_SITE_PERMISSIONS, SITE_PERMISSIONS.SITE_ADMINISTRATOR, first.id).changes;
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('owner_console_bit_migrated', '1')").run();
  if (changes) console.log('[db] migrated: Owner site role gained MANAGE_CONSOLE');
}
migrateOwnerConsoleBit();

// The per-status notification grid replaced the single sound mode. Users who had picked 'always' or
// 'never' get the equivalent grid once, so nobody's sound behavior changes. Gated on a meta marker.
function migrateNotifyGrid() {
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'notify_grid_migrated'").get()) return;
  const { migrateSoundMode } = require('../lib/notifyGrid');
  const set = db.prepare('UPDATE users SET notify_grid = ? WHERE id = ? AND notify_grid IS NULL');
  for (const u of db.prepare("SELECT id, notify_sound_mode FROM users WHERE notify_sound_mode IN ('always', 'never')").all()) {
    set.run(JSON.stringify(migrateSoundMode(u.notify_sound_mode)), u.id);
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('notify_grid_migrated', '1')").run();
}
migrateNotifyGrid();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_vanity ON servers(vanity_code) WHERE vanity_code IS NOT NULL');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_api_token ON bots(api_token_hash) WHERE api_token_hash IS NOT NULL');
// Created after the column migration above so it also works on a DB that predates passport_id.
// SQLite treats NULLs as distinct, so any number of accounts may have no passport yet.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_passport_id ON users(passport_id)');

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_federated_uid ON users(federated_uid) WHERE federated_uid IS NOT NULL`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_federation ON messages(federation_peer_id, federation_message_id) WHERE federation_peer_id IS NOT NULL`);

// One-time backfill of messages_fts for a DB that already had messages before the FTS5 index
// existed — the triggers only cover inserts/edits/deletes from this point forward. Gated on a
// meta flag rather than "is messages_fts empty" so it can't re-scan every boot on a server that
// legitimately has zero messages, and can't mistake a genuinely-synced-but-currently-empty index
// (all messages deleted) for one that was never backfilled.
// Bios used to allow 500 characters; clip the long ones once (SQLite substr counts characters, not bytes).
{
  const { BIO_MAX } = require('../lib/bio');
  const clipped = db.prepare('UPDATE users SET bio = substr(bio, 1, ?) WHERE length(bio) > ?').run(BIO_MAX, BIO_MAX).changes;
  if (clipped) console.log(`[db] shortened ${clipped} bio(s) to ${BIO_MAX} characters`);
}

const ftsWasBackfilled = !!db.prepare("SELECT 1 FROM meta WHERE key = 'messages_fts_backfilled'").get();
if (!ftsWasBackfilled) {
  db.exec("INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages WHERE scope_type != 'dm'");
  db.prepare("INSERT INTO meta (key, value) VALUES ('messages_fts_backfilled', '1')").run();
  console.log('[db] backfilled messages_fts');
}

// DM text is sealed at rest (lib/atRest.js). Older databases hold DM text in clear, in messages and
// in the FTS index, so seal it once: the index entry is removed with the exact text that was indexed,
// then the row is overwritten. The triggers are replaced first so the sealing writes never re-index.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'dm_at_rest_v1'").get()) {
  const { seal, isSealed } = require('../lib/atRest');
  const ftsTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_fts_au'").get();
  if (ftsTrigger && !ftsTrigger.sql.includes("scope_type")) {
    for (const name of ['messages_fts_ai', 'messages_fts_ad', 'messages_fts_au']) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.exec(`
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN new.scope_type != 'dm' BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages WHEN old.scope_type != 'dm' BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages WHEN old.scope_type != 'dm' BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;`);
  }
  const rows = db.prepare("SELECT id, content, embed FROM messages WHERE scope_type = 'dm'").all();
  const sched = db.prepare("SELECT id, content FROM scheduled_messages WHERE scope_type = 'dm'").all();
  db.exec('BEGIN');
  try {
    const unindex = db.prepare("INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', ?, ?)");
    const update = db.prepare('UPDATE messages SET content = ?, embed = ? WHERE id = ?');
    for (const r of rows) {
      if (isSealed(r.content)) continue;
      if (ftsWasBackfilled) unindex.run(r.id, r.content);
      update.run(seal(r.content), r.embed && !isSealed(r.embed) ? seal(r.embed) : r.embed, r.id);
    }
    const updateSched = db.prepare('UPDATE scheduled_messages SET content = ? WHERE id = ?');
    for (const r of sched) if (!isSealed(r.content)) updateSched.run(seal(r.content), r.id);
    // Queued Android notifications carry the whole message; they are short-lived, so just drop the DM ones.
    db.prepare("DELETE FROM notifications_outbox WHERE scope_type = 'dm'").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('dm_at_rest_v1', '1')").run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (rows.length || sched.length) {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    console.log(`[db] migrated: sealed ${rows.length} DM message(s) at rest`);
  }
}

// DM attachment files, their names, poll options and queued federation events were still in the clear
// after the message text was sealed: seal them too, once. Files move to a random name; the real name
// is kept sealed in the database.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'dm_files_at_rest_v1'").get()) {
  const { seal, isSealed } = require('../lib/atRest');
  const { sealFileSync, isSealedFile } = require('../lib/fileSeal');
  const crypto = require('node:crypto');
  let files = 0;
  const rows = db.prepare(
    "SELECT a.id, a.file_path, a.file_name FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.scope_type = 'dm'"
  ).all();
  const updAtt = db.prepare('UPDATE attachments SET file_path = ?, file_name = ? WHERE id = ?');
  for (const a of rows) {
    const m = /^\/uploads\/attachments\/(dm-\d+)\/([A-Za-z0-9._-]+)$/.exec(a.file_path);
    if (!m) continue;
    const dir = path.join(DATA_DIR, 'attachments', m[1]);
    const oldPath = path.join(dir, m[2]);
    try {
      let newName = m[2];
      if (fs.existsSync(oldPath) && !isSealedFile(oldPath)) {
        newName = `${crypto.randomBytes(12).toString('hex')}.bin`;
        sealFileSync(oldPath, path.join(dir, newName));
        fs.unlinkSync(oldPath);
        files++;
      }
      updAtt.run(`/uploads/attachments/${m[1]}/${newName}`, isSealed(a.file_name) ? a.file_name : seal(a.file_name), a.id);
    } catch (err) {
      console.error(`[db] could not seal DM attachment ${a.id}: ${err.message}`);
    }
  }
  const updOpt = db.prepare('UPDATE poll_options SET label = ? WHERE id = ?');
  for (const o of db.prepare("SELECT o.id, o.label FROM poll_options o JOIN polls p ON p.id = o.poll_id JOIN messages m ON m.id = p.message_id WHERE m.scope_type = 'dm'").all()) {
    if (!isSealed(o.label)) updOpt.run(seal(o.label), o.id);
  }
  const updEv = db.prepare('UPDATE federation_outbox SET payload_json = ? WHERE id = ?');
  for (const e of db.prepare("SELECT id, payload_json FROM federation_outbox WHERE substr(type, 1, 3) = 'dm_'").all()) {
    if (!isSealed(e.payload_json)) updEv.run(seal(e.payload_json), e.id);
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('dm_files_at_rest_v1', '1')").run();
  if (files) { db.exec('VACUUM'); console.log(`[db] migrated: sealed ${files} DM attachment file(s) at rest`); }
}

// Display names are filtered to characters that cannot break layouts (lib/textSanitize.js displayName);
// clean the ones stored before that existed, once.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'display_names_clean_v1'").get()) {
  const { displayName } = require('../lib/textSanitize');
  let fixed = 0;
  const upd = db.prepare('UPDATE users SET display_name = ? WHERE id = ?');
  for (const u of db.prepare('SELECT id, username, display_name FROM users').all()) {
    const clean = displayName(u.display_name) || u.username;
    if (clean !== u.display_name) { upd.run(clean, u.id); fixed++; }
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('display_names_clean_v1', '1')").run();
  if (fixed) console.log(`[db] migrated: cleaned ${fixed} display name(s)`);
}

// Reserved account webhook-posted messages attach to, purely to satisfy messages.author_id's
// NOT NULL constraint without touching that column's schema — the actual per-message identity
// (name/avatar) always comes from the joined webhooks row via messages.webhook_id instead (see
// lib/messages.js serializeMessage). Undiscoverable, unusable as a real login (random bcrypt hash
// of bytes nobody has), and filtered out of the admin Users list.
const WEBHOOK_SYSTEM_USERNAME = '__webhook__';
let webhookSystemUserRow = db.prepare('SELECT id FROM users WHERE username = ?').get(WEBHOOK_SYSTEM_USERNAME);
if (!webhookSystemUserRow) {
  const bcrypt = require('bcryptjs');
  const crypto = require('node:crypto');
  const info = db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name, discoverable) VALUES (?, ?, ?, ?, 0)'
  ).run(WEBHOOK_SYSTEM_USERNAME, 'webhook@local.invalid', bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12), 'Webhook');
  webhookSystemUserRow = { id: info.lastInsertRowid };
}
const WEBHOOK_SYSTEM_USER_ID = webhookSystemUserRow.id;

// Seed the languages this instance ships with. `en` is protected (builtin) — see
// server/routes/adminLanguages.js, which refuses to disable/delete it.
const LANGUAGE_SEEDS = [
  { code: 'en', name: 'English', builtin: 1 },
  { code: 'hu', name: 'Magyar', builtin: 0 },
];
for (const { code, name, builtin } of LANGUAGE_SEEDS) {
  const existing = db.prepare('SELECT code FROM languages WHERE code = ?').get(code);
  if (!existing) {
    db.prepare('INSERT INTO languages (code, name, enabled, builtin) VALUES (?, ?, 1, ?)').run(code, name, builtin);
  }
}

if (isNewDb) {
  console.log('[db] fresh database created at', DB_PATH);
}

// One commit (one write-ahead-log sync) for a batch of writes instead of one per statement. Joins an open transaction.
function inTransaction(fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw err; }
}

module.exports = { db, inTransaction, isNewDb, DATA_DIR, WEBHOOK_SYSTEM_USER_ID, migrateOwnerConsoleBit, migrateNotifyGrid };

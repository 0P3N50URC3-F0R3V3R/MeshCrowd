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
  { table: 'messages', column: 'webhook_id', ddl: 'ALTER TABLE messages ADD COLUMN webhook_id INTEGER REFERENCES webhooks(id) ON DELETE SET NULL' },
  { table: 'users', column: 'home_instance_id', ddl: 'ALTER TABLE users ADD COLUMN home_instance_id INTEGER REFERENCES federation_peers(id) ON DELETE SET NULL' },
  { table: 'users', column: 'remote_user_id', ddl: 'ALTER TABLE users ADD COLUMN remote_user_id INTEGER' },
  { table: 'users', column: 'federated_uid', ddl: 'ALTER TABLE users ADD COLUMN federated_uid TEXT' },
  { table: 'messages', column: 'federation_peer_id', ddl: 'ALTER TABLE messages ADD COLUMN federation_peer_id INTEGER REFERENCES federation_peers(id) ON DELETE SET NULL' },
  { table: 'messages', column: 'federation_message_id', ddl: 'ALTER TABLE messages ADD COLUMN federation_message_id TEXT' },
  { table: 'server_members', column: 'name_color', ddl: 'ALTER TABLE server_members ADD COLUMN name_color TEXT' },
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
  { table: 'roles', column: 'icon_emoji', ddl: 'ALTER TABLE roles ADD COLUMN icon_emoji TEXT' },
  { table: 'roles', column: 'icon_path', ddl: 'ALTER TABLE roles ADD COLUMN icon_path TEXT' },
  { table: 'messages', column: 'interaction_command', ddl: 'ALTER TABLE messages ADD COLUMN interaction_command TEXT' },
  { table: 'messages', column: 'interaction_user_id', ddl: 'ALTER TABLE messages ADD COLUMN interaction_user_id INTEGER' },
];
for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(ddl);
    console.log(`[db] migrated: added ${table}.${column}`);
  }
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
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'messages_fts_backfilled'").get()) {
  db.exec("INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages");
  db.prepare("INSERT INTO meta (key, value) VALUES ('messages_fts_backfilled', '1')").run();
  console.log('[db] backfilled messages_fts');
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

module.exports = { db, isNewDb, DATA_DIR, WEBHOOK_SYSTEM_USER_ID };

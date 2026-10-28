-- Dismesh schema. Applied once on first boot if data/dismesh.db is missing.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  auth_mode      TEXT NOT NULL DEFAULT 'password', -- 'password' (legacy: password_hash = bcrypt(password)) | 'split' (password_hash = bcrypt(authKey))
  auth_salt      TEXT,                             -- split only: base64 16-byte Argon2id salt for the browser-side derivation
  display_name   TEXT NOT NULL,
  bio            TEXT NOT NULL DEFAULT '',
  avatar_path    TEXT,
  banner_color   TEXT NOT NULL DEFAULT '',
  banner_path    TEXT,
  card_color     TEXT NOT NULL DEFAULT '',
  card_path      TEXT,
  is_disabled    INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'online',    -- chosen presence preference: online|idle|dnd|invisible
  custom_status_text TEXT NOT NULL DEFAULT '',
  custom_status_emoji TEXT NOT NULL DEFAULT '',
  dm_privacy     TEXT NOT NULL DEFAULT 'everyone',  -- everyone|friends|none
  profile_privacy TEXT NOT NULL DEFAULT 'everyone', -- everyone|friends
  discoverable   INTEGER NOT NULL DEFAULT 1,        -- appear in user search/directory when adding friends
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row per user: their Passport seed, encrypted client-side. Legacy accounts: key derived from
-- the login password (Argon2id; `salt` is that Argon2 salt). Split accounts: key = wrapKey derived
-- in the browser (never sent); `salt` holds the tag 'split:v1' and the Argon2 salt is users.auth_salt.
-- The server only ever stores/serves this ciphertext. Deleted automatically if the user is deleted.
CREATE TABLE IF NOT EXISTS e2ee_key_backups (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_key TEXT NOT NULL,
  salt          TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Site-level trail of passport and credential events (register/login/recover/attach/upgrade/admin_reset),
-- success and failure. audit_log is per-server, so it cannot hold these. user_id survives as NULL if the account goes.
CREATE TABLE IF NOT EXISTS passport_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  passport_id TEXT,
  action      TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  ip          TEXT,
  actor_user_id INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_passport_audit_created ON passport_audit(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS friendships (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,          -- pending|accepted|blocked
  requested_by INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_friend_a ON friendships(user_a);
CREATE INDEX IF NOT EXISTS idx_friend_b ON friendships(user_b);

-- Direct message conversations (2-person or group)
CREATE TABLE IF NOT EXISTS dm_channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  is_group    INTEGER NOT NULL DEFAULT 0,
  name        TEXT,                  -- only used for groups
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  e2ee_enabled    INTEGER NOT NULL DEFAULT 0, -- one-way: no route ever sets it back to 0
  e2ee_enabled_at TEXT,
  e2ee_enabled_by INTEGER
);

CREATE TABLE IF NOT EXISTS dm_members (
  dm_channel_id INTEGER NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (dm_channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_dm_members_user ON dm_members(user_id);

CREATE TABLE IF NOT EXISTS servers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  icon_path         TEXT,
  owner_id          INTEGER NOT NULL REFERENCES users(id),
  invite_code       TEXT UNIQUE,
  visibility        TEXT NOT NULL DEFAULT 'private', -- private (invite-only, unlisted) | public (searchable, joinable without an invite)
  auto_join         INTEGER NOT NULL DEFAULT 0,       -- public only: every newly-registered user is added as a member automatically
  welcome_enabled   INTEGER NOT NULL DEFAULT 0,
  welcome_message   TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname    TEXT,
  name_color  TEXT, -- per-member name color override; takes precedence over their highest colored role
  joined_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id);

-- Roles: bitflag permissions. @everyone role auto-created per server (position 0, is_default=1).
CREATE TABLE IF NOT EXISTS roles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '#99aab5',
  permissions  INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0,
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server_id);

CREATE TABLE IF NOT EXISTS member_roles (
  server_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id),
  FOREIGN KEY (server_id, user_id) REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
);

-- Discord-style channel grouping in the sidebar. A channel with category_id NULL renders above
-- the first category, ungrouped. Deleting a category just ungroups its channels (ON DELETE SET
-- NULL on channels.category_id, added via COLUMN_MIGRATIONS since channels predates this table).
CREATE TABLE IF NOT EXISTS channel_categories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_categories_server ON channel_categories(server_id);

-- Highlighted channels shown on a server's welcome screen (servers.welcome_enabled), each with
-- its own emoji + short blurb — clicking a row jumps a new member straight to that channel.
CREATE TABLE IF NOT EXISTS welcome_channels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  emoji        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_welcome_channels_server ON welcome_channels(server_id);

-- Server-uploaded custom emoji, used in message content as :name: and as reaction values —
-- self-hosted, own storage (data/emoji/), no third-party emoji CDN involved.
CREATE TABLE IF NOT EXISTS custom_emoji (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  image_path   TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_emoji_server_name ON custom_emoji(server_id, name COLLATE NOCASE);

-- Server-uploaded stickers — unlike custom_emoji these are sent as their own thing attached to a
-- message (messages.sticker_id), not typed inline as text, and can't be used as a reaction.
CREATE TABLE IF NOT EXISTS stickers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  image_path   TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stickers_server_name ON stickers(server_id, name COLLATE NOCASE);

-- Soundboard clips — played as a button press into the current voice channel for everyone
-- actually in that call (see server/socket/index.js's voice_soundboard_play), not mixed into
-- anyone's own outgoing mic stream (this app's voice is a peer-to-peer mesh, no central mixer).
CREATE TABLE IF NOT EXISTS sounds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  emoji        TEXT NOT NULL DEFAULT '',
  audio_path   TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sounds_server_name ON sounds(server_id, name COLLATE NOCASE);

-- Incoming webhooks: an external service POSTs to /api/webhooks/:id/:token (no login, no session —
-- the token itself is the credential) to post a message into `channel_id` under this webhook's own
-- name/avatar. Posted messages carry author_id = the reserved system user (see db/index.js
-- WEBHOOK_SYSTEM_USERNAME) so messages.author_id's NOT NULL constraint needs no schema change;
-- messages.webhook_id (below) is what actually identifies which webhook posted it for rendering.
CREATE TABLE IF NOT EXISTS webhooks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  avatar_path  TEXT,
  token        TEXT NOT NULL UNIQUE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks(channel_id);

-- Scheduled events — server-wide, not tied to any one text channel. Either channel_id (a voice
-- or stage channel) or location (freeform "external" text) is set, matching Discord's own
-- either/or model; validated at the route level, not enforceable as a plain CHECK given SQLite's
-- limited expression support inside one.
CREATE TABLE IF NOT EXISTS scheduled_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id   INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  start_time   TEXT NOT NULL,
  end_time     TEXT,
  status       TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|cancelled
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_events_server ON scheduled_events(server_id, start_time);

CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id     INTEGER NOT NULL REFERENCES scheduled_events(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  topic        TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT 'public', -- public|private|announcement|readonly|voice|forum|stage
  position     INTEGER NOT NULL DEFAULT 0,
  icon_path    TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);

-- Explicit per-role channel overrides (used for 'private' channel visibility)
CREATE TABLE IF NOT EXISTS channel_role_overrides (
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  allow       INTEGER NOT NULL DEFAULT 0, -- bitflags allowed
  deny        INTEGER NOT NULL DEFAULT 0, -- bitflags denied
  PRIMARY KEY (channel_id, role_id)
);

-- Same shape as channel_role_overrides but per-user, applied on top of role overrides. Lets a
-- single person be granted access to one private channel (e.g. via a channel invite) without
-- creating a role just for them.
CREATE TABLE IF NOT EXISTS channel_user_overrides (
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  allow       INTEGER NOT NULL DEFAULT 0,
  deny        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);

-- Invite codes scoped to one channel (as opposed to servers.invite_code, which is server-wide).
-- Redeeming one adds the user to the server if needed and grants VIEW_CHANNEL on this channel
-- specifically via channel_user_overrides.
CREATE TABLE IF NOT EXISTS channel_invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  max_uses    INTEGER,             -- NULL = unlimited
  uses        INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,                -- NULL = never
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_channel_invites_channel ON channel_invites(channel_id);

-- Membership screening: rules text plus optional questions whose answers hand out roles. While a
-- server has screening on, a member whose server_members.screened_at is NULL is "pending": they can
-- read what their roles let them see but cannot post, react, join voice or anything else until they accept.
CREATE TABLE IF NOT EXISTS onboarding_questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  multi      INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_onboarding_questions_server ON onboarding_questions(server_id);
CREATE TABLE IF NOT EXISTS onboarding_options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES onboarding_questions(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  role_id     INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_onboarding_options_question ON onboarding_options(question_id);

-- UnifiedPush: addresses a phone's push distributor (for example a self-hosted ntfy) gave the app. The
-- server only ever POSTs a tiny "wake up" body there; the app then fetches the real notifications itself.
CREATE TABLE IF NOT EXISTS push_endpoints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  failures    INTEGER NOT NULL DEFAULT 0,
  last_ok_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, endpoint)
);

-- Server templates: a frozen copy of a server's structure (roles, categories, channels, per-role channel
-- overrides) that anyone holding the code can start a new server from. The snapshot is JSON and is
-- validated again every time it is used.
CREATE TABLE IF NOT EXISTS server_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  source_server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  snapshot    TEXT NOT NULL,
  uses        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_server_templates_source ON server_templates(source_server_id);

-- Messages written now and sent later. The worker sends each one as its author at send_at, checking
-- permissions, timeouts and AutoMod again at that moment; a refused one stays visible as 'failed'.
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('channel', 'thread', 'dm')),
  scope_id    INTEGER NOT NULL,
  content     TEXT NOT NULL,
  reply_to_message_id INTEGER,
  send_at     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'failed')),
  error       TEXT,
  failed_at   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(status, send_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_messages(user_id);

-- Reaction roles: reacting to a (channel) message with an emoji gives a role, removing the reaction takes
-- it away again. With exclusive = 1 picking one emoji of the message drops the other roles of that message.
CREATE TABLE IF NOT EXISTS reaction_roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  exclusive   INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (message_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reaction_roles_server ON reaction_roles(server_id);

-- AutoMod: per-server rules that check a message before it is stored. A hit blocks the message and
-- may also time the author out; every hit is logged (the log is trimmed per server).
CREATE TABLE IF NOT EXISTS automod_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('keywords', 'links', 'mentions', 'spam', 'caps')),
  enabled          INTEGER NOT NULL DEFAULT 1,
  config           TEXT NOT NULL DEFAULT '{}',
  action           TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block', 'timeout')),
  timeout_minutes  INTEGER NOT NULL DEFAULT 10,
  exempt_roles     TEXT NOT NULL DEFAULT '[]',
  exempt_channels  TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_automod_rules_server ON automod_rules(server_id);

CREATE TABLE IF NOT EXISTS automod_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  rule_id     INTEGER REFERENCES automod_rules(id) ON DELETE SET NULL,
  rule_name   TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  channel_id  INTEGER,
  action      TEXT NOT NULL,
  excerpt     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_automod_log_server ON automod_log(server_id, id);

-- Extra server-wide invite links on top of servers.invite_code (which stays as the permanent default
-- link): each has its own optional expiry and use limit and can be revoked on its own.
CREATE TABLE IF NOT EXISTS server_invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  max_uses    INTEGER,             -- NULL = unlimited
  uses        INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,                -- NULL = never
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_server_invites_server ON server_invites(server_id);

-- A sub-conversation scoped to a channel: either spawned off one existing message (parent_message_id
-- set — Discord's "Create Thread" on a message) or a forum post (parent_message_id NULL, channel.type
-- = 'forum', title required). Its own messages live in the `messages` table like any other scope,
-- with scope_type = 'thread' and scope_id = threads.id — permission to view/post is inherited from
-- the parent channel (see lib/messages.js), there is no separate thread-membership concept.
CREATE TABLE IF NOT EXISTS threads (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id         INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  parent_message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  title              TEXT NOT NULL,
  created_by         INTEGER NOT NULL REFERENCES users(id),
  archived           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id);

-- Personal Notes (channels.type = 'notes'): one private stream per (channel, user). The server only
-- ever holds ciphertext — the client encrypts with a key derived from the owner's Passport seed
-- (web/js/e2ee/notes.js), so neither the DB nor any admin can read it. Deliberately NOT stored in
-- `messages`: no FTS indexing, notifications, pins, reactions, webhooks, or prune-by-scope paths
-- can ever see these rows.
CREATE TABLE IF NOT EXISTS note_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nonce       TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_note_entries_owner ON note_entries(channel_id, user_id, id);

-- Encrypted attachment blobs for notes (iv || AES-GCM ciphertext, produced client-side; name/type/size
-- live inside the encrypted note payload). note_id is NULL until the note referencing the upload is saved.
CREATE TABLE IF NOT EXISTS note_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id     INTEGER REFERENCES note_entries(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_note_files_note ON note_files(note_id);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type    TEXT NOT NULL,   -- 'channel' | 'dm'
  scope_id      INTEGER NOT NULL, -- channels.id or dm_channels.id
  author_id     INTEGER NOT NULL REFERENCES users(id),
  content       TEXT NOT NULL DEFAULT '',
  event_type    TEXT,            -- null for normal messages; else member_join|member_leave|member_kick|member_ban
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at     TEXT,
  deleted_at    TEXT,
  sticker_id    INTEGER REFERENCES stickers(id) ON DELETE SET NULL,
  webhook_id    INTEGER REFERENCES webhooks(id) ON DELETE SET NULL,
  is_encrypted  INTEGER NOT NULL DEFAULT 0  -- content is then a v1 E2EE envelope, never plaintext
);
CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages(scope_type, scope_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  voice_ms     INTEGER              -- length of a recorded voice message; NULL for ordinary files
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- Ciphertext blobs attached to encrypted 1:1 DM messages. blob_id is a client-chosen random id that
-- is also bound into the file's AEAD; name, type, size and key live only inside the ratchet-encrypted
-- message. message_id is NULL until the message referencing the upload is sent.
CREATE TABLE IF NOT EXISTS dm_e2ee_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  blob_id     TEXT NOT NULL UNIQUE,
  dm_id       INTEGER NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_dm_e2ee_files_message ON dm_e2ee_files(message_id);
CREATE INDEX IF NOT EXISTS idx_dm_e2ee_files_dm ON dm_e2ee_files(dm_id);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);

CREATE TABLE IF NOT EXISTS server_bans (
  server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL DEFAULT '',
  banned_by  INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (server_id, user_id)
);

-- Global site-wide staff ranks (Owner/Admin/Moderator/... fully editable), separate
-- bitflag namespace from per-server roles. Assigned via user_site_roles.
CREATE TABLE IF NOT EXISTS site_roles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  color        TEXT NOT NULL DEFAULT '#f04747',
  permissions  INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS user_site_roles (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id  INTEGER NOT NULL REFERENCES site_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- User reports, feeding the admin-side moderation queue (MANAGE_REPORTS site permission).
-- reporter_id is nullable-on-delete rather than cascaded: a report should outlive the reporter's
-- account (moderation history, and stops a bad-faith account from erasing its own report trail by
-- self-deleting) — same reasoning as banned_by-style audit columns elsewhere. reported_user_id
-- and message_id DO cascade: a report about a user/message that no longer exists has nothing left
-- to moderate.
CREATE TABLE IF NOT EXISTS reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id       INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  reason           TEXT NOT NULL,   -- 'spam' | 'harassment' | 'other'
  details          TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'dismissed'
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at      TEXT,
  resolved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  plaintext_evidence TEXT           -- reporter-supplied decrypted text, only for E2EE messages
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user ON reports(reported_user_id);

-- Data-pruning jobs (server/lib/prune.js): a bulk-delete of message history before a cutoff date,
-- optionally deferred by a grace period so participants see the heads-up notice before it runs.
-- Immediate prunes never get a row here (nothing to defer) — this only tracks scheduled ones.
CREATE TABLE IF NOT EXISTS pending_prunes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_kind         TEXT NOT NULL,   -- 'channels' | 'dm'
  scope_ids          TEXT NOT NULL,   -- JSON array: channel ids (channels) or [dm_channel_id] (dm)
  server_id          INTEGER REFERENCES servers(id) ON DELETE CASCADE, -- set for 'channels' scope only
  cutoff_at          TEXT NOT NULL,
  purge_attachments  INTEGER NOT NULL DEFAULT 0,
  requested_by       INTEGER NOT NULL REFERENCES users(id),
  execute_at         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending', -- pending|done
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_prunes_due ON pending_prunes(status, execute_at);

-- Structured, admin-facing per-server audit trail (channel/role/category/member moderation
-- actions). actor_id is nullable-on-delete, same reasoning as reports.reporter_id: the log entry
-- should outlive the actor's account.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  details     TEXT,  -- JSON blob, shape depends on `action`
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log(server_id, id DESC);

-- Per-user, per-scope notification preference. No row = the default for that scope type
-- (see lib/notifications.js): "mentions" for channels, "all" for DMs.
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type  TEXT NOT NULL,   -- 'channel' | 'dm'
  scope_id    INTEGER NOT NULL,
  pref        TEXT NOT NULL,   -- 'all' | 'mentions' | 'mute'
  PRIMARY KEY (user_id, scope_type, scope_id)
);

-- Per-user, per-server preferences behind the server-icon context menu. notif_level NULL = no
-- server-wide choice (channels keep their own default); muted_until is an ISO timestamp, in the
-- far future for "until I turn it back on". allow_dms = 0 stops members of this server who share
-- no other server with you (and are not friends) from opening a DM.
CREATE TABLE IF NOT EXISTS server_prefs (
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id           INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  notif_level         TEXT,
  muted_until         TEXT,
  hide_muted_channels INTEGER NOT NULL DEFAULT 0,
  show_all_channels   INTEGER NOT NULL DEFAULT 1,
  allow_dms           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, server_id)
);

-- Private, per-viewer data about another user: a note, a nickname shown only to the viewer, and
-- the "ignore" flag (their messages are hidden for the viewer and stop notifying them; unlike a
-- block the other side can still talk to them).
CREATE TABLE IF NOT EXISTS user_annotations (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note      TEXT,
  nickname  TEXT,
  ignored   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, target_id)
);

-- Per-user view of a DM conversation. hidden = "closed" from the list until a new message arrives.
CREATE TABLE IF NOT EXISTS dm_prefs (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dm_id    INTEGER NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  pinned   INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  hidden   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, dm_id)
);

CREATE TABLE IF NOT EXISTS message_bookmarks (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS message_reminders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  remind_at    TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON message_reminders(delivered_at, remind_at);

-- Per-user last-read pointer, one row per (user, scope). No row = everything in that scope
-- counts as unread. Powers the unread indicators (server rail, channel/DM list) and the "Seen"
-- label on DMs; scope_type/scope_id mirrors notification_prefs.
CREATE TABLE IF NOT EXISTS read_state (
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type            TEXT NOT NULL,   -- 'channel' | 'dm'
  scope_id              INTEGER NOT NULL,
  last_read_message_id  INTEGER NOT NULL,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, scope_type, scope_id)
);

-- Durable copy of every notify-worthy event already computed by notifyChannelMessage/
-- notifyDmMessage (server/lib/notifications.js) — same mute/mentions filtering, just also
-- persisted here instead of only pushed live over WS, so a client with no open WebSocket (e.g.
-- an Android background poller) can catch up via a cheap `id > since` cursor query instead of
-- reconstructing unread state itself. Pruned to the newest N rows per user on insert.
CREATE TABLE IF NOT EXISTS notifications_outbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type    TEXT NOT NULL,   -- 'channel' | 'dm'
  scope_id      INTEGER NOT NULL,
  server_id     INTEGER,
  server_name   TEXT,
  channel_name  TEXT,
  message_json  TEXT NOT NULL,
  mentioned     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_outbox_user ON notifications_outbox (user_id, id);

-- Full-text search over message content. External-content FTS5 table (messages stays the
-- source of truth; this just indexes it) kept in sync via triggers below, so every insert/edit/
-- delete through the normal messages table automatically updates the index too.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A poll is a normal message (its `content` holds the question) with its options and votes
-- normalized here rather than jammed into message content — same pattern as attachments.
CREATE TABLE IF NOT EXISTS polls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  multi_select INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS poll_options (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id  INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  label    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (option_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_user ON poll_votes(poll_id, user_id);

CREATE TABLE IF NOT EXISTS federation_peers (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  domain                 TEXT NOT NULL UNIQUE,
  public_url             TEXT NOT NULL,
  their_pubkey           TEXT NOT NULL,
  their_cert_fingerprint TEXT,
  display_name           TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending | active | revoked
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at           TEXT
);

-- Ledger only: which servers owned by a paired peer a LOCAL user joined. No remote content is
-- ever stored here; the owning instance stays the single source of truth and is proxied live.
CREATE TABLE IF NOT EXISTS remote_memberships (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id          INTEGER NOT NULL REFERENCES federation_peers(id) ON DELETE CASCADE,
  remote_server_id INTEGER NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  icon_path        TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, peer_id, remote_server_id)
);
CREATE INDEX IF NOT EXISTS idx_remote_memberships_peer_server ON remote_memberships(peer_id, remote_server_id);

CREATE TABLE IF NOT EXISTS federation_invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS federation_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_id         INTEGER NOT NULL REFERENCES federation_peers(id) ON DELETE CASCADE,
  event_id        TEXT NOT NULL,
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | dead
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_federation_outbox_peer ON federation_outbox(peer_id, status, next_attempt_at);

CREATE TABLE IF NOT EXISTS federation_inbox_seen (
  peer_id  INTEGER NOT NULL REFERENCES federation_peers(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (peer_id, event_id)
);

CREATE TABLE IF NOT EXISTS federation_admin_sessions (
  token      TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS federation_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  details     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_federation_audit_log_created ON federation_audit_log(created_at DESC);

-- Installed translation languages for the client UI (admin-managed; see server/lib/languages.js
-- and server/routes/adminLanguages.js). `en` is the built-in fallback base every other language
-- merges over at runtime and can never be disabled or deleted.
CREATE TABLE IF NOT EXISTS languages (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  builtin      INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- AI bots. A bot is a real users row (users.is_bot = 1) plus one bots row binding it to a home
-- server and to a site-wide provider. scope/owner_server_id on providers are reserved for
-- server-tier providers (not built yet): v1 only creates scope = 'site'.
CREATE TABLE IF NOT EXISTS ai_providers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind                TEXT NOT NULL CHECK (kind IN ('ollama', 'openai')),
  base_url            TEXT NOT NULL,
  api_key_enc         TEXT,
  models              TEXT NOT NULL DEFAULT '[]',
  timeout_s           INTEGER NOT NULL DEFAULT 120,
  concurrency         INTEGER NOT NULL DEFAULT 1,
  server_admin_usable INTEGER NOT NULL DEFAULT 0,
  enabled             INTEGER NOT NULL DEFAULT 1,
  scope               TEXT NOT NULL DEFAULT 'site' CHECK (scope IN ('site', 'server')),
  owner_server_id     INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS bots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  provider_id      INTEGER REFERENCES ai_providers(id) ON DELETE RESTRICT, -- NULL = no AI, an API/webhook-only bot
  model            TEXT,
  persona          TEXT NOT NULL DEFAULT '',
  mention_enabled  INTEGER NOT NULL DEFAULT 1,
  dm_enabled       INTEGER NOT NULL DEFAULT 0,
  context_messages INTEGER NOT NULL DEFAULT 12,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Bot API: only the SHA-256 of the token is stored; the token itself is shown once.
  api_token_hash   TEXT UNIQUE,
  api_token_prefix TEXT,
  api_token_at     TEXT,
  -- Outgoing webhook: signed JSON events pushed to an external tool (n8n, a script).
  webhook_enabled       INTEGER NOT NULL DEFAULT 0,
  webhook_url           TEXT,
  webhook_secret_enc    TEXT,
  webhook_scope         TEXT NOT NULL DEFAULT 'mention', -- mention | all
  webhook_allow_private INTEGER NOT NULL DEFAULT 0,      -- only a site admin may point it at a private address
  webhook_last_status   TEXT,
  webhook_last_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_bots_server ON bots(server_id);

-- Message authors can never be removed (messages.author_id is NOT NULL), so a removed bot's
-- account stays behind, disabled. A trigger keeps every deletion path (bot delete, server delete
-- cascade) identical.
CREATE TRIGGER IF NOT EXISTS trg_bots_disable_user AFTER DELETE ON bots
BEGIN
  UPDATE users SET is_disabled = 1 WHERE id = OLD.user_id;
END;

-- Slash commands a bot registers; users pick them in the composer.
CREATE TABLE IF NOT EXISTS bot_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  options     TEXT NOT NULL DEFAULT '[]', -- JSON [{name, description, type, required}]
  UNIQUE (bot_id, name)
);

-- One row per command invocation; the random id is what the bot answers to (valid 15 minutes, 5 answers).
CREATE TABLE IF NOT EXISTS bot_interactions (
  id          TEXT PRIMARY KEY,
  bot_id      INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type  TEXT NOT NULL,
  scope_id    INTEGER NOT NULL,
  command     TEXT NOT NULL,
  responses   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_bot_interactions_created ON bot_interactions(created_at);

-- Security Center: manual and automatic IP bans, subscribed blocklists, and an event trail.
CREATE TABLE IF NOT EXISTS ip_bans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry      TEXT NOT NULL UNIQUE,            -- single IP, CIDR, or "a-b" range
  reason     TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'manual',  -- manual | auto
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS ip_blocklists (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  url              TEXT NOT NULL UNIQUE,
  enabled          INTEGER NOT NULL DEFAULT 1,
  refresh_hours    INTEGER NOT NULL DEFAULT 24,
  entries          TEXT NOT NULL DEFAULT '',  -- newline-separated, already validated
  entry_count      INTEGER NOT NULL DEFAULT 0,
  last_fetched_at  TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS security_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  type   TEXT NOT NULL,
  ip     TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_events_ts ON security_events(ts);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(type, ts);

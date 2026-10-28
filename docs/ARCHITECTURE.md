# Architecture

## Layout

```
server/            Node.js/Express + ws — the entire backend
  index.js         app wiring: middleware, route mounts, HTTP/HTTPS server, rate limiters
  db/
    index.js       opens data/dismesh.db, runs schema.sql, applies additive column migrations
    schema.sql     full table/index/trigger definitions
  routes/          one file per resource (auth, users, servers, messages, admin, ...)
  socket/
    index.js       WS connection handler — parses incoming client messages, dispatches
    hub.js         outbound broadcast helpers (broadcastToChannel/ToDm/ToServer/ToFriends, ...)
    voice.js       in-memory voice-room participant registry
  lib/              shared business logic: permissions, channel/scope access checks, search,
                    presence, sessions, TOTP, theme sanitization, moderation, webhooks,
                    certificates, uploads, notifications outbox, data pruning, ...
  middleware/       auth (attachUser/requireAuth), rate limiting
  test/             node:test suite (npm test)
web/                browser client — plain HTML/CSS/JS, ES modules, no build step, no bundler
  index.html        single entry point, SPA-style client-side routing
  js/
    api.js          thin fetch wrapper — one function per REST endpoint
    ws.js           WebSocket client: connect/reconnect-with-backoff/send, emits onto bus.js
    state.js        in-memory client state + mutator functions, emits change events onto bus.js
    bus.js          tiny pub/sub event bus tying api.js/ws.js/state.js to the view layer
    views/          one file per UI area (shell, sidebar, chat, voice, admin, userSettings, ...)
  css/               plain CSS, no preprocessor
electron/           desktop shell
  main.js           BrowserWindow + tray + cert pinning + IPC handlers
  trayIcon.js       draws the tray icon/badge PNG (base + per-presence colors are user-customizable)
  preload.js        contextBridge-exposed API surface for the renderer (window.dismeshClient)
  renderer/          first-run "connect to a server" screen (loaded before any server is configured)
android/            Android WebView shell: MainActivity (WebView, back, keyboard, file chooser), SetupActivity
                    (server address + certificate trust), Net/PinnedTls (pin-aware HTTPS), Downloads,
                    NotificationPoller + PollControl/PollWorker/PollService (local notifications),
                    AndroidBridge (window.MeshCrowdAndroid)
scripts/
  build-portable.js  bundles node.exe + vendored node_modules + source into dist/dismesh-portable/
runtime/             bundled Node runtime (node.exe) preferred by the start scripts
data/                created on first run: dismesh.db, config.json, certs/, and per-upload-type folders
```

## Data model

SQLite via Node's built-in `node:sqlite` (`server/db/index.js`) — **zero native npm addons**,
which is why moving the server to a different machine/architecture needs no rebuild step. Schema
lives entirely in `server/db/schema.sql`; new columns added to an existing table across versions
go through an additive-migration list in `db/index.js` (`PRAGMA table_info` check + `ALTER TABLE`,
safe to run against an already-populated database).

Core tables and how they relate:

- `users` — one row per account. `status` is the user's chosen presence *preference*, never
  mutated by connect/disconnect (see [Presence](#presence) below). `theme` is a JSON blob
  (sanitized shape, see `server/lib/theme.js`). A reserved row (`WEBHOOK_SYSTEM_USER_ID`, username
  `__webhook__`) is bootstrapped at startup as the author of record for webhook-posted messages —
  every `FROM users` query elsewhere in the codebase that could accidentally surface it as a real
  registrant (first-user-becomes-owner check, admin user list, friend lookups) explicitly excludes
  it.
- `sessions` — opaque session tokens, one row per login, individually revocable.
- `friendships` — one row per pair (`user_a < user_b`, `pairKey()` in `server/lib/friends.js`
  normalizes the order), `status` ('pending'/'accepted'/'blocked') + `requested_by` records who
  initiated (so only the blocker can lift their own block).
- `servers` / `server_members` / `roles` / `member_roles` — a server, its members, its roles, and
  the many-to-many member↔role assignment. `roles.is_default` marks the `@everyone` role every
  member implicitly holds. `server_members.name_color` is an optional per-member name color that
  overrides the member's role color.
- `channels` / `channel_categories` / `channel_role_overrides` / `channel_user_overrides` — see
  [Permission engine](#permission-engine) below for how these combine.
- `dm_channels` — direct message conversations (1:1 or group). Columns `e2ee_enabled` and `e2ee_enabled_at`
  track when encryption was activated (one-way: never reset to 0). Once enabled, all new messages must use
  the E2EE envelope format.
- `messages` — one table for **channel, DM, and thread** messages alike, disambiguated by
  `scope_type` + `scope_id`. `is_encrypted` marks E2EE envelope messages (plaintext content is an opaque
  JSON envelope). `webhook_id` links a webhook-posted message back to its webhook; `event_type` marks
  system messages (member joined, channel renamed, etc. — generated by `server/lib/systemMessages.js`);
  `reply_to_message_id` and `forwarded_from_message_id` self-reference this same table.
- `threads` — `channel_id` + `parent_message_id` (null for a forum post); a thread's own messages
  are ordinary rows in `messages` with `scope_type='thread'`. Threads can have custom icons (`icon_path`).
- `note_entries`, `note_files` — personal encrypted journals for notes channels (type `notes`).
  `note_entries` stores per-user ciphertext (nonce + XChaCha20-Poly1305 blob) keyed by (channel_id, user_id);
  `note_files` stores encrypted attachment blobs (client-side encrypted, server stores as-is). Each user's
  notes are completely isolated and opaque to the server/other users.
- `attachments`, `message_reactions` — child rows keyed to a message. Encrypted DM attachments are never
  included in E2EE messages (encryption is message-only in phase 2).
- `custom_emoji`, `stickers`, `sounds` — per-server asset libraries.
- `webhooks` — per-channel, `token` is the bearer credential embedded in the post URL.
- `scheduled_events` / `event_rsvps`.
- `server_bans` — separate from `server_members` so a ban survives the member row being deleted.
- `site_roles` / `user_site_roles` — the site-wide staff-rank system, structurally identical to
  `roles`/`member_roles` but scoped instance-wide rather than per-server.
- `reports`, `audit_log` — moderation trail.
- `notification_prefs`, `read_state` — per-user, per-scope.
- `notifications_outbox` — a durable copy of every notification already pushed live over WS
  (same mute/mentions filtering), trimmed to the newest 200 per user on insert. Lets a client with
  no open WebSocket (the Android background poller) catch up with an `id > since` cursor instead
  of reconstructing unread state.
- `pending_prunes` — data-prune jobs deferred by the 24-hour notice period; drained by a worker
  in `server/lib/prune.js` that runs every minute. Immediate prunes never create a row.
- `polls` / `poll_options` / `poll_votes` — a poll is always attached 1:1 to a `messages` row.
  Polls cannot be created in encrypted DMs or notes channels.
- `federation_peers`, `remote_memberships`, `federation_invites`, `federation_outbox`, `federation_inbox_seen`,
  `federation_admin_sessions`, `federation_audit_log` — federation state and relay infrastructure.
  `federation_peers` tracks peer instances (status: pending/active/revoked, direction: inbound/outbound).
  `remote_memberships` is a ledger of local users who have joined remote servers (no content stored, proxied live).
  `federation_outbox` queues events for delivery with retry (pending/delivered/dead status).
  See [Federation](#federation-design) below.
- `meta` — small key/value table for runtime-editable site-wide settings: `session_ttl_days`,
  `max_upload_mb`, `allowed_attachment_extensions` (`server/lib/siteSettings.js`).
- Per-user JSON columns on `users` for personal preferences, each sanitized on write: `theme` (includes
  optional gradient colors `gradFrom`, `gradTo`, and angle `gradAngle`), `server_layout` (server-rail folders),
  `ui_prefs` (resizable panel widths).

Search (`server/lib/search.js`) is a SQLite FTS5 virtual table over `messages.content`, kept in
sync via `INSERT`/`UPDATE`/`DELETE` triggers defined in `schema.sql` — no application-level
reindexing step, every write path stays searchable automatically.

## Permission engine

Two structurally-similar but independent systems:

1. **Per-server permissions** (`server/lib/channelAccess.js`) resolve in this order for a given
   `(channel, userId)`:
   1. Server owner → full permission bits (`OWNER_PERMISSIONS`), short-circuits everything else.
   2. Aggregate (bitwise OR) the permission bits of every role the member holds, including the
      implicit `@everyone` role (`getMemberPermissionBits`).
   3. If that aggregate already includes `ADMINISTRATOR`, stop — it bypasses per-channel overrides
      entirely.
   4. Apply **per-role channel overrides** (`channel_role_overrides`), in ascending role
      `position` order, so a higher-ranked role's override wins last if two roles disagree.
   5. Apply the **per-user channel override** (`channel_user_overrides`) on top — this is how a
      redeemed channel invite grants access a role alone wouldn't.
   6. Apply channel-type rules: a `private` channel strips `VIEW_CHANNEL` unless something above
      explicitly granted it (or the member is mod+); `announcement`/`readonly` strip
      `SEND_MESSAGES` unless mod+; `stage` strips `SEND_MESSAGES` unconditionally (no text chat in
      a stage channel, matching the client never rendering a composer for one).

   Every route that touches a channel calls into this same resolver (`canAccessChannel` /
   `getChannelPermissionBits`) — there is exactly one place permission logic lives, not a
   parallel copy per route.

2. **Site-wide staff permissions** (`server/lib/siteAuth.js`) work the same way at the instance
   level: aggregate bits across a user's `site_roles`, `SITE_ADMINISTRATOR` short-circuits, no
   per-resource overrides layer (the admin panel doesn't have a concept of per-item ACLs).

**Anti-escalation invariant, enforced server-side in both systems:** a role/rank can never be
granted a permission bit the granter doesn't already hold themselves — checked everywhere a
role's `permissions` field is set or a role is assigned to someone, not just in the UI. This
closes the "moderator grants themselves ADMINISTRATOR" class of bug.

Full bitflag values: [API.md#permission-bitflags](API.md#permission-bitflags).

## Realtime layer

One `ws` connection per logged-in client (`server/socket/index.js`), authenticated by the same
session cookie as HTTP. Inbound messages are a small, explicit `if (msg.type === '...')` dispatch
— see [API.md](API.md#websocket-protocol-wsshostportws) for the full message catalog.

Outbound push always goes through `server/socket/hub.js`, which is the single place that decides
*who* receives a given event:

- `broadcastToChannel(channel, payload, requiredFlag)` — every currently-online member who still
  passes `canAccessChannel(channel, userId, requiredFlag)` right now (not a cached membership
  list) gets it. This is what keeps a private channel's `message_create`/`channel_update`/etc.
  from ever reaching someone who can't view it.
- `broadcastToServer(serverId, payload)` — everyone in the server, no per-channel filtering; only
  used for payloads that carry no channel-specific secret (member/role/server-metadata changes).
- `broadcastToDm(dmChannelId, payload)` — only that DM's members. This is the mechanism that keeps
  a private DM/group voice call's `voice_state` from ever reaching a shared-server member list —
  the message is never sent to anyone outside the DM in the first place, so there's no client-side
  filtering to get wrong.
- `broadcastPresence(userId)` — computed recipient set: accepted friends ∪ everyone who shares any
  server with this user.
- `broadcastToFriends(userId, payload)` — friends only, narrower than presence (used for
  "a friend of mine is doing X" events like joining voice).
- `notifyUserIds(userIds, payload)` — an explicit id list, used when the affected membership row
  is already gone by the time the broadcast fires (kick/ban/delete remove the row *then* notify,
  so querying live membership would miss the person who needs to hear about it).

On the client (`web/js/ws.js`), reconnection uses exponential backoff (1s → ×1.6 each attempt,
capped at 15s) and re-establishes automatically; `web/js/views/shell.js` shows a "lost connection,
reconnecting…" banner and disables the composer for the duration, without discarding any
already-loaded state.

### Presence

`users.status` is the user's chosen preference and is **never** mutated by connect/disconnect —
it survives a reconnect unchanged. What's actually shown to a *viewer* additionally depends on
whether the user currently has any open WebSocket connection at all (tracked separately in
`server/lib/presence.js`):

```
effectiveStatus(user, viewerIsSelf):
  if not online (no live connection)      -> "offline"
  if status == "invisible" and not self   -> "offline"
  else                                     -> status
```

So `invisible` is indistinguishable from truly offline to everyone but the user themselves — and a
preference of "online" set before going offline doesn't come back stale on the next connect.

## Voice & video: WebRTC mesh

No media server. Every participant in a voice/stage/DM-call room opens a direct
`RTCPeerConnection` to every other participant; the existing WebSocket connection carries all
signaling (`voice_join`/`voice_leave`/`voice_signal`), so there's no separate signaling
infrastructure to run. `server/socket/voice.js` is a small in-memory `Map<roomKey, Set<userId>>`
registry — `roomKey` is the numeric channel id for a server voice/stage channel, or a namespaced
`dm:<dmChannelId>` string for a private call, which is what keeps the two kinds of room from ever
colliding or leaking into each other. Every `voice_join`/`voice_leave`/`voice_signal` is
permission-checked the same way any other channel action is (`VIEW_CHANNEL` for a server channel,
DM membership for a call) before it's allowed to touch the registry or relay a signal.

**Moderator force-mute.** With no mixer, the server can't actually silence anyone's outgoing
audio. `voice.js` keeps an in-memory per-room `forceMuted` set; a `voice_force_mute` from a
`MODERATE_MEMBERS` holder adds the target and re-broadcasts `voice_state` with `mutedByMod: true`
on that participant. The target's own client sees the flag, mutes its microphone track, and
disables its unmute control. This is the same trust model as other chat apps' server-mute. The set is
dropped when the room empties, so it never carries over into a later session.

Camera and screen-share tracks are added to the same peer connections as separate transceivers —
each renders as its own tile client-side (`web/js/views/voice.js`), matching how other chat apps shows a
participant's camera and their screen share as two distinct tiles rather than one.

Opus is not a project dependency — it's compiled into Chromium/Electron's WebRTC stack already
(browsers default to it for audio); `RTCRtpSender.setCodecPreferences` is used defensively to
reinforce the preference rather than to add codec support that wasn't already there.

STUN/TURN is opt-in. Signaling always rides the WebSocket; only the media needs it. A fresh install
connects only peers who can reach each other directly (the same LAN) and opens no extra port.
Operators have two ways to help peers across NAT: external servers in `iceServers`, and the
**built-in STUN/TURN server** in `server/lib/turn/` (`turn` in `data/config.json`, off by default).

The built-in server is plain Node (`dgram` + `net`, no dependency): `stun.js` is the RFC 5389 codec,
`server.js` the RFC 5766 relay (Allocate, Refresh, CreatePermission, ChannelBind, Send/Data,
ChannelData; clients over UDP or TCP, relay over UDP, IPv4 only), `credentials.js` the TURN REST
scheme (username `<expiry>:<label>`, password `base64(HMAC-SHA1(secret, username))`, so credentials
are stateless and self-expiring), `manager.js` the lifecycle (start, live reload from Admin > Calls,
status, self-test) and the ICE list. Signed-in users fetch their list from `GET /api/voice/ice`;
`web/js/views/voice.js` caches it until shortly before it expires. The relay is hardened: only
authenticated requests allocate, per-user and global limits, a per-allocation bandwidth cap, and
relaying to private/loopback/link-local/CGNAT and multicast addresses is refused unless
`allowPrivatePeers` is set. When a client is on a private network the relayed address advertised to it is the
server's LAN address, otherwise `externalIp`. `scripts/turn-e2e.mjs` proves it with real Chrome peers forced
to relay (UDP and `--tcp`).

## Passport (portable identity)

**Seed and key derivation.** The client generates a 32-byte seed (libsodium `randombytes_buf`) and
derives everything from it with `crypto_kdf_derive_from_key` (32-byte subkeys); the Passport is
fully reproducible from the seed. Code: `web/js/e2ee/crypto.mjs`.

| Subkey id | KDF context | Use |
|---|---|---|
| 1 | `mcpsign1` | Ed25519 signing key pair (`crypto_sign_seed_keypair`). Its public key is the Passport identity. |
| 2 | `mcpdh001` | X25519 key pair (`crypto_box_seed_keypair`), the E2EE public key stored in `users.e2ee_public_key`. |
| 3 | `mcpsnap1` | Symmetric key reserved for encrypted snapshots in the Passport file. |
| 4 | `mcpnote1` | XChaCha20 key for per-channel encrypted notes (derived with channel ID as well). |

**Passport ID.** `mc1` + lowercase RFC 4648 base32 (no padding) of the 32-byte Ed25519 public key =
55 characters, `^mc1[a-z2-7]{52}$`. The UI shows a short form (`mc1-xxxx-xxxx-xxxx-xxxx`) for display only.

**Challenge message.** `POST /api/passport/challenge` returns a random 32-byte hex nonce and the
`issuedAt` timestamp (single use, 60 s TTL, held in memory). The client signs the UTF-8 string
`meshcrowd-passport-v1|<purpose>|<origin>|<nonce>|<issuedAt>` with Ed25519 (detached).
`purpose` (`register`/`login`/`recover`/`attach`) stops a proof for one action being replayed for another;
`origin` stops replay against another server. The server rebuilds the message from its own view of
the origin (`req.protocol` + `Host`) and trusts it only if it is allow-listed
(`server/lib/passportOrigin.js`): origins derived from `publicHost` + `port`/`httpsPort`, the
`passportOrigins` list, and loopback hosts on any port. Behind a reverse proxy `trustProxy` must be
set so `req.protocol` is the public scheme. The nonce is consumed before anything else is checked, and
unknown IDs are verified against a dummy key so every failure costs the same.

**Where the seed lives.**
1. *Device cache*: `localStorage.dismesh_passport_seed` (`{userId, seed}`), written after any login, cleared on logout, and only used if the seed's public key matches the account's `passport_id`.
2. *Server-side wrapped blob*: table `e2ee_key_backups` (`encrypted_key`, `salt`, `nonce`), the seed encrypted under a key derived from the login password (secretbox). Re-wrapped on password change and recovery. Gives password login on a new browser. **Legacy accounts**: Argon2id of the password with the row's own random salt; the server sees the password at sign-in, so a malicious or compromised operator could in principle unwrap the seed. **Split accounts**: the browser-only `wrapKey` (next section), `salt` holds the literal tag `split:v1`.
3. *`.mcpass` file*: JSON `{format: "meshcrowd-passport", v: 1, id, kdf: {alg: "argon2id13", opslimit, memlimit, salt}, nonce, ciphertext}`, secretbox over `{seed, createdAt, snapshot}` under a passphrase (NFKC-normalised, at least 12 chars). The reader refuses unknown versions, a KDF cost above 2x MODERATE (512 MiB / 8 ops) before running Argon2, and a file whose plaintext `id` does not match the seed.

### Split sign-in (`authKey` and `wrapKey`)

Design: `docs/superpowers/specs/2026-10-01-split-password-design.md`. For split accounts the browser
derives two independent keys from the password and the server never receives the password. All
parameters are constants of the client (protocol version 1); the server never supplies cost parameters,
so it cannot downgrade the KDF. Code: `deriveAuthKeys` in `web/js/e2ee/crypto.mjs`.

| Value | Derivation | Leaves the browser? |
|---|---|---|
| `authSalt` | 16 random bytes chosen by the client that sets the credential (fresh on every credential change) | Yes, stored in `users.auth_salt` (public) |
| `master` | `crypto_pwhash(32, NFKC(password), authSalt, OPSLIMIT_INTERACTIVE, MEMLIMIT_INTERACTIVE, ARGON2ID13)` (64 MiB, 2 passes; about 150 ms in Node, about 330 ms in headless Chromium) | Never, zeroed after use |
| `authKey` | `crypto_kdf_derive_from_key(32, 1, 'mcauth01', master)`, canonical base64 (44 chars) | Yes, to this server only |
| `wrapKey` | `crypto_kdf_derive_from_key(32, 2, 'mcwrap01', master)` | **Never** |
| split backup | `crypto_secretbox_easy(seed, randomNonce, wrapKey)`, stored with `salt = 'split:v1'` | Ciphertext only |

`authKey` and `wrapKey` are independent subkeys of `master`, so a server holding `authKey` cannot compute
`wrapKey` or the password except by guessing the password offline (one Argon2id evaluation per guess). The
`.mcpass` file stays at Argon2id MODERATE because it is offline-attackable by anyone who finds it.

Server side (`server/lib/splitAuth.js`): `users.auth_mode` (`'password'` default, or `'split'`),
`users.auth_salt` (NULL for legacy accounts). `users.password_hash` changes meaning by mode: bcrypt(password)
for legacy, bcrypt(`authKey`) for split (cost 12 for both, so verification takes the same time). The upgrade
**overwrites** the legacy hash: keeping bcrypt(password) would leave a verifier the operator could brute-force
at bcrypt cost and then derive `wrapKey` from. `meta.login_params_secret` (32 random bytes) keys the fake salt
`HMAC-SHA256(secret, "mc-login-salt|" + lowercase(username))[0:16]` that `GET /api/auth/login-params` returns
for unknown names. Legacy and split accounts coexist: the native Android app signs in with
`{username, password}` and keeps working for every legacy account, which is every account it creates; a
legacy account becomes split only by an explicit user action (Strengthen sign-in, or Forgot-password recovery),
after which Android apps older than 3.0 can no longer sign in until it implements the same derivation.

**Trust assumption.** Whoever serves the web client is trusted to serve it honestly: a malicious operator
can ship JavaScript that sends the password or the seed home. Split sign-in protects against passive
logging, later compromise of logs or the database, and honest-operator mistakes; it does not protect
against an operator who targets a user with modified code (pinned or signed clients are future work). The
operator can also test password guesses offline against `authKey` and the salt, and `authKey` is a
password-equivalent on this one server, so TLS stays mandatory.

## E2EE DM design

**Phase 2** (current): opt-in encryption for 1:1 DMs between two local users on the same instance. Encrypted
DMs cannot include federated users. Attachments, link previews, reactions, pins, replies, and message edits
are unsupported in encrypted conversations in this phase.

**Envelope format** (`web/js/e2ee/dmCrypto.js`, `server/lib/e2eeEnvelope.js`): plaintext is encrypted with
XChaCha20-Poly1305 under a symmetric key derived from each participant's Passport seed. The server stores the
envelope (JSON: `{v, chainIndex, nonce, ciphertext}`) as-is in `messages.content` with `is_encrypted=1`, never
accessing the plaintext.

**Ratcheting** (`web/js/e2ee/ratchet.mjs`): a per-conversation symmetric key evolves via HKDF-SHA256 after each
sent message (sender's local state only, per chain direction — no shared state). The `chainIndex` field
prevents out-of-order delivery (server enforces monotonic increment per sender within each conversation). A
unique `nonce` per message prevents ciphertext reuse even if the same plaintext is sent twice.

**Safety numbers and key pinning** (`web/js/e2ee/safety.mjs`, `web/js/e2ee/trust.mjs`): the client
locally computes and displays a "safety number" (SHA-256 hash of each peer's Passport public key + a
constant string per direction). Key pinning detects key changes: if a peer's key ever differs from what was
pinned on first message, the UI warns the user and blocks further encryption until acknowledged. No
key-agreement handshake happens: keys are pre-shared via each user's Passport before any DM message is sent.

**Limitations and future work**: ratchet state is device-local (lost on logout), so rekeying happens on each
login. Transport-layer forward secrecy (X3DH / double ratchet) is deferred to a later phase. Encrypted
DMs cannot be forwarded or quoted (the server cannot extract plaintext for context). Link previews are
fetched client-side (`POST /api/link-preview`) and sealed in the client's own ciphertext. Reports on
encrypted messages allow an optional `plaintext_evidence` field (reporter decrypts and supplies it).

## Themes with gradient background

Per-user themes (stored in `users.theme` JSON) now support:
- `gradFrom` and `gradTo`: hex colors (`#rrggbb` or empty for off)
- `gradAngle`: 0–360 degrees (default 135)

When both colors are set, the CSS variable `--bg-gradient` is computed as a linear gradient and made available
to the UI for smooth overlays. The validator (`server/lib/theme.js` `sanitizeTheme`) rejects invalid hex and
non-integer angles, falling back to defaults. The gradient is client-rendered only; the server stores and
relays the color values, never computing CSS.

## Federation design

Enabled via `federation.enabled` in `config.json` (default false). Allows paired instances to relay DM
messages and expose public remote servers for joining.

**Peer pairing state machine** (`server/routes/federationApi.js`, `server/routes/federationAdmin.js`):
- State: `pending` (awaiting peer response), `active` (handshake complete), `revoked` (disabled by either side)
- Direction: `inbound` (peer initiated) or `outbound` (we initiated)
- Operations: `accept`/`reject` (during `pending`), `revoke` (anytime); each broadcasts a WS event
  (`peer_accept`, `peer_reject`, `peer_revoke`)
- Separate **Federation admin session** (table `federation_admin_sessions`, separate from site admin) decouples
  relay permissions from site ownership

**Remote servers**: a user can `POST /api/servers/join-remote` to join a public server on a paired peer.
Content is proxied live (no local copies). Only **text channels** expose to remote members; voice, stage,
forum, and notes channels are filtered. Site staff cannot read remote content.
Remote members also get, over the same signed `/federation/api/rpc` (`server/lib/remoteChannelRpc.js`, proxied by
`server/routes/remote.js`): the member list (`list_members`: display name, home username/domain, status, avatar
flag only; avatars via `member_avatar`), attachments, and read-only threads (`list_threads`,
`list_thread_messages`). Attachments are stored only by the **owning** instance: the home instance buffers the
upload in memory, base64-forwards it inside `channel_message_create` (8 MB total cap, `REMOTE_ATTACHMENT_MAX_BYTES`;
the owner re-applies its own `ATTACH_FILES`, extension and `maxUploadMb` rules), and serves downloads from its
own authenticated `/api/remote/.../attachments/:id` route via `get_attachment`. The browser never sees a peer URL;
the proxy re-sanitizes the filename, derives the type from it (raster images inline, everything else
`Content-Disposition: attachment`) and sends the same sandbox CSP as local attachments. Owner files above 8 MB
are not fetchable remotely (413).

**Live relay** (`server/lib/federationOutbox.js`, `server/lib/federationRpc.js`): DM messages, edits, deletes,
and reactions replicate to all peers where a participant has a home instance ID. Channel messages fan-out to
peers as `remote_channel_event` WS events. Outbox retries with exponential backoff (limited per-peer, per-event)
and deduplicates via `federation_inbox_seen`. DM attachment size is capped at ~6 MB when federated.

**SSRF/peer-trust hardening** (`server/lib/federationSsrf.js`): federation RPC uses `safeFetch` (HTTPS only,
no redirects, verified certificate fingerprint). DNS is pinned at connect time (re-resolved on retry, not
cached). Peer URLs are validated against a whitelist derived from peer domain + configured origins. Remote user
records cache Passport IDs and signatures for offline verification. All outbound requests to peers are
audit-logged in `federation_audit_log`.

**Server files.** `server/routes/passport.js` (endpoints), `server/lib/passportCrypto.js` (ID, key decoding,
challenge verification, backup shape), `server/lib/passportChallenges.js` (nonce store, per-ID lockout:
5 failures / 15 min), `server/lib/passportOrigin.js` (origin allow-list), `server/lib/accounts.js`
(shared account creation, backup save, uniqueness handling), `server/lib/secondFactor.js` (TOTP/recovery
check shared by login, recover, attach). Schema: `users.passport_id` (unique index),
`users.passport_public_key`, `users.e2ee_public_key`, table `passport_audit`. Client: `web/js/passport/flow.js`,
`web/js/e2ee/identity.js`, the auth view and Settings -> Passport.

## Security model

- **Transport**: HTTPS/WSS by default (`server/lib/certs.js`). Either an auto-generated
  self-signed certificate (the `selfsigned` package — pure JS, no OpenSSL dependency), or an
  operator-supplied PEM pair from `serverCrt`/`serverKey` in `data/config.json` (relative paths
  resolve against the project root, not `DATA_DIR`). A supplied pair is validated with
  `tls.createSecureContext` before the server is created, so a bad/mismatched/weak pair fails
  with a clear error instead of an uncaught crash. The server prints the leaf certificate's
  SHA-256 fingerprint on every boot (`crypto.X509Certificate`, so full-chain files report the
  leaf, matching what clients pin). `useHttps: false` opts into plain HTTP for LAN/dev use.
- **Passwords**: bcrypt, 12 rounds (`bcryptjs`).
- **Sessions**: opaque random tokens looked up server-side (`server/lib/session.js`) — nothing is
  signed or JWT-shaped, so there's no secret to manage and every session is individually
  revocable (used by the admin "disable account" action, which closes live sockets immediately
  too).
- **2FA**: RFC 6238 TOTP implemented directly on `node:crypto` (HMAC-SHA1 + hand-rolled base32),
  no third-party auth library. Recovery codes are generated on enable, shown once, single-use.
- **Uploads**: extension-blocklisted (no executables/HTML/SVG — filenames are sanitized against
  NTFS alternate-data-stream and trailing-dot bypass tricks), plus an optional admin-set
  allowlist. Size is capped twice: multer's limit is fixed at startup from `config.json`'s
  `maxUploadMb`, and `rejectOversizedFiles` enforces the (possibly lower) runtime admin limit
  after upload, deleting the temp files. Multipart file names are re-decoded from latin1 to
  UTF-8 so non-ASCII names survive.
  Served with `Content-Disposition: attachment` and a sandboxed `Content-Security-Policy` header
  on the uploads route, so a served file can never execute as active content in the app's own
  origin even if something slipped past the extension filter.
- **CSP / headers**: `server/index.js` sets `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, and an app-wide `Content-Security-Policy` on every response.
- **Rate limiting**: `server/middleware/rateLimit.js`, applied per-route in `server/index.js` —
  register/login, 2FA verification, friend requests, reports, server-join, message sends, and
  webhook posts are all limited (keyed per-user where the requester is authenticated, per-IP
  otherwise).
- **Electron client**: trust-on-first-use certificate pinning (`electron/main.js`) — the
  fingerprint of a server's cert is remembered after the user explicitly trusts it once, and a
  changed fingerprint on a later connection shows a "certificate changed!" warning dialog rather
  than silently reconnecting. `will-navigate`/`setWindowOpenHandler` are locked down so the main
  window can only ever point at the configured server (or `file:` for local renderer assets);
  anything else opens in the system browser instead of inside the app. The pinning handler only
  runs on a certificate *error*, so a certificate from a publicly trusted CA is accepted normally.
- **Android client**: `Net` builds one trust manager used by the setup check, the notification poller
  and downloads. A chain the device's system store trusts is accepted as is; otherwise the leaf's
  SHA-256 must equal the fingerprint the user confirmed on the setup screen. The WebView accepts a
  certificate error only when it matches the same pin, loads only the configured origin (other links
  open in the system browser), and exposes `MeshCrowdAndroid` to that origin only.
- **Data pruning**: three separately-permissioned entry points (server `PRUNE_CONTENT`, site
  `PRUNE_DATA`, group-DM creator) share one implementation. Every prune posts a visible notice in
  the affected conversation, server-level ones are audit-logged, and the site-wide DM listing
  exposes only sizes and member usernames — never message content.
- **Reverse proxies**: if TLS is terminated upstream instead of by the server's own built-in
  HTTPS, set `app.set('trust proxy', 1)` in `server/index.js` — otherwise session cookies are
  issued without the `Secure` flag.

## Portable packaging

`scripts/build-portable.js` produces `dist/dismesh-portable/`: a bundled copy of `node.exe` under
`runtime/`, all server source, and vendored `node_modules` (needed since the target machine may
have no internet access at all). `start-server.bat`/`.sh` prefer the bundled runtime if present,
falling back to a system `node` otherwise. Because the server has zero native addons, the same
bundle works unmodified on any machine of a matching OS/architecture — no rebuild step.

## Sites (PHP intranet)

| Unit | Responsibility |
| --- | --- |
| `server/lib/siteFiles.js` | safe path resolution, limits, atomic file ops, serve-target resolution |
| `server/lib/siteCsp.js` | origin validation and the Site CSP string |
| `server/lib/siteRewrite.js` | HTML/CSS/`Location` rewriting, loader injection, the loader script |
| `server/lib/phpRuntime.js` | locate PHP, health check, Visual C++ install, sandboxed launch spec |
| `server/lib/siteProcesses.js` | per-Site worker pool lifecycle |
| `server/routes/sites.js` | Site CRUD, settings, file API, runtime status |
| `server/routes/siteProxy.js` | `/site/:id/*` auth, static serving, PHP proxy |
| `web/js/views/site.js`, `siteSettings.js`, `siteEditor.js`, `web/js/siteDoc.js` | Site view, settings, editor, pure document helpers |

**Request flow**: server rail entry -> `views/site.js` mounts an iframe on `/site/:id/` -> the `/site`
router authenticates the session and Site membership, resolves the file inside the Site folder ->
static files are served by Express (HTML/CSS rewritten), `.php` goes to a worker -> the response is
rewritten and given the Site CSP.

**Process lifecycle**: `php -S` serves one request at a time and Windows has no multi-worker mode, so
each Site has a pool of up to `sites.maxWorkers` workers. The first request starts one worker; when
every worker is busy and the pool has room, one more starts for that request (never more than the
limit, even for a burst of simultaneous first requests); with a full pool a request queues on the
least busy worker. Extra workers stop after 60 s idle, the last one after 10 minutes, and all of them
on shutdown or Site delete. A worker that dies unexpectedly is restarted with exponential backoff;
five crashes within a minute answer 503 until a file in the Site changes or the server restarts. PHP
state is per worker, so pages must not rely on in-process memory between requests; files on disk are
shared.

**Security model**: the trust boundary is "Site editor equals server admin" (PHP runs on the host,
same-origin JS runs in viewers' sessions). Mitigations: loopback-only workers, `open_basedir` pinned
to the Site folder (path values quoted and expanded to their long names, because php.ini reads an
unquoted `~` as an operator), `disable_functions`, `allow_url_fopen=0`, a scrubbed child environment
(`PATH`, `SystemRoot`, `TEMP`, `TMP` only), auth cookie and `Authorization` stripped before
forwarding, `Set-Cookie` dropped, a per-Site CSP with explicit origins, an iframe sandbox without
`allow-top-navigation`, traversal/symlink/junction checks, size and count limits, and an audit log.
Residual risk: a page can read other files in its own Site folder and make outbound requests only
through functions not in `disable_functions`.

## AI bots

| Unit | Responsibility |
| --- | --- |
| `server/lib/ai/secretBox.js` | AES-256-GCM encryption of provider API keys, key file `data/ai.key` |
| `server/lib/ai/http.js` | URL validation, hardened request (no redirects, size caps, pinned DNS for non-site providers) |
| `server/lib/ai/providers.js` | Ollama NDJSON and OpenAI SSE adapters: `chat`, `listModels` |
| `server/lib/ai/providerStore.js` | provider validation and CRUD |
| `server/lib/ai/botStore.js` | bot accounts: create, update, delete, avatar |
| `server/lib/ai/context.js` | builds the prompt from persona and recent history |
| `server/lib/ai/sanitize.js` | neutralizes mentions and raw HTML in model output |
| `server/lib/ai/queue.js` | per-provider FIFO with a concurrency limit |
| `server/lib/ai/dispatcher.js` | decides who is addressed, gates, queues, streams the reply |
| `server/routes/adminAi.js`, `server/routes/serverBots.js` | site and per-server admin APIs |
| `server/lib/bots/tokens.js` | bot token (`mcb_...`, SHA-256 stored) and webhook secret generation |
| `server/lib/bots/events.js` | the one hook the message routes call: webhook targets, then the AI dispatcher |
| `server/lib/bots/webhooks.js` | signed delivery, per-bot ordered queue, retries, last-delivery status |
| `server/lib/bots/post.js` | posting, editing and deleting as a bot through the normal permission/broadcast/notify path |
| `server/routes/botApi.js`, `server/routes/botCredentialRoutes.js` | the token-authenticated `/api/bot` API and the token/secret/test endpoints |

**Request flow**: a message is stored by the channel, thread or DM route -> `maybeRespond` finds the
addressed bots (mention, reply, or 1:1 DM) -> gates (provider enabled, author not timed out, cooldown,
queue room) -> the provider call streams tokens -> the reply message is inserted on the first token,
edited about once a second, then finalized and the asker notified.

**Bot API and webhooks**: `bots.provider_id` and `model` are nullable (no AI = API/webhook bot); the
token hash, webhook URL, encrypted signing secret, scope and last status live on the `bots` row. After
a message is stored the routes call `events.onMessageCreated`, which enqueues a signed delivery for each
webhook bot addressed (mention, reply, DM, or scope `all`) and then runs the AI dispatcher, so the two
jobs are independent. Bot-authored messages never trigger either. `/api/bot` authenticates by token
hash lookup and is rate limited per bot.

**Trust tiers**: providers and bots carry `scope` (`site` or `server`) and `owner_server_id`. v1 only
creates site-tier providers; the fields exist so server-admin-owned providers (with stricter network
rules and no private addresses) can be added without a migration.

**Security model**: private addresses are allowed only for site-tier providers; redirects are never
followed; request, line and body sizes are capped; API keys are encrypted at rest and never returned;
model output is untrusted (mentions neutralized, HTML defused where raw HTML is on, length capped, no
tools); bots never read E2EE DMs, group DMs or Notes channels and see only what their role can view.

## UnifiedPush

Server: `lib/pushEndpoints.js` (`push_endpoints` table, validation, SSRF-guarded POST through the same hardened
client the AI providers use, per-user 5 s coalescing, failure counting) hooked into `recordOutbox`, plus
`routes/push.js`. Android: `PushControl` (distributor choice, register/unregister, server calls),
`PushReceiverService` (the connector's `PushService`: new endpoint goes to the server, a push triggers one
`NotificationPoller.poll`), bridge methods `pushDistributors/pushEnable/pushDisable`, and the You tab sheet.

## Noise suppression

`web/js/noiseSuppression.js`: `FrameBuffer` re-slices Web Audio blocks into RNNoise's 480-sample frames (one frame of
delay, no gaps) and `createDenoiser(audioCtx)` wraps the WebAssembly module in a ScriptProcessorNode. `views/voice.js`
splices it between the microphone source and the gain node when `voicePrefs.noiseSuppression` is on, creating the
AudioContext at 48 kHz; the speaking indicator and voice activation still read the raw microphone.

## Insights

`server/lib/insights.js` runs a handful of aggregate queries over `messages` (indexed by `created_at`) and
`server_members`, zero-fills the day series, and caches each (server, range) for a minute;
`routes/insights.js` is the Manage Server endpoint. The web tab draws inline SVG bars, no chart library.

## Server templates

`server/lib/serverTemplates.js` builds a JSON snapshot (`buildSnapshot`), re-validates every field when it is
used (`validateSnapshot`) and applies it in one transaction (`instantiate`: server, @everyone, roles,
categories, channels, overrides). Roles and categories are referenced by index inside the snapshot, never by
database id, so a snapshot is portable. `routes/serverTemplates.js` exports the server-scoped router and the
code router.

## Voice messages

`web/js/voiceMessage.js` holds the recorder (`VoiceRecorder`, `openRecorderBar`) and the player markup and
delegation shared by the desktop and phone UIs. The server side is `lib/voiceMessages.js`
(`parseVoiceUpload`) called by the channel, thread and DM message routes before the insert;
`attachments.voice_ms` marks a voice attachment and `serializeMessage` exposes it as `voiceMs`.

## Scheduled messages

`server/lib/scheduledMessages.js` plus `routes/scheduled.js` (`/api/scheduled`). A 10 s worker (`startWorker`
from `index.js`, like the reminder worker) claims due rows with a compare-and-set to `sending`, re-runs the
access checks (`canSendToScope`, AutoMod), then inserts, broadcasts, relays to federation peers for channel
messages, fetches the link preview, notifies, and calls `onMessageCreated` so bots and webhooks see it like any
other message. The row is deleted on success and kept as `failed` otherwise.

## Reaction roles

`server/lib/reactionRoles.js` (CRUD plus `onReactionAdded`/`onReactionRemoved`) and
`server/routes/reactionRoles.js`. The reaction routes in `routes/messages.js` call the two hooks after
writing or deleting the reaction row; a mapping is keyed by `(message_id, emoji)` and cascades away with
its message or role. Grants reuse `isSelfAssignableRole` from `lib/onboarding.js`, so the same power mask
guards both features.

## Onboarding

`server/lib/onboarding.js` stores the rules and questions and performs the acceptance;
`server/routes/onboarding.js` is the API. "Pending" is computed by `isPendingMember` in
`lib/channelAccess.js` and applied at the end of both `getMemberPermissionBits` and
`getChannelPermissionBits` (so no role or override can raise a pending member above view access); the
voice-join socket handler checks it too. The same power mask (`POWER_BITS`) decides which roles may
be handed out by self-service features.

## AutoMod

`server/lib/automod.js` holds the rule CRUD and the matcher; `server/routes/automod.js` is the
Manage Server API. The channel and thread message routes and the message edit route call
`automod.evaluate({ channel, user, content, track })` after the permission checks and before the insert;
it returns null or the verdict that becomes a `403`. Rules and the hit log live in `automod_rules` and
`automod_log`. Keyword patterns are built from escaped text (the only wildcard is a bounded
`[letters/digits/_]*`), so no user-supplied regular expression ever runs. Flood and duplicate
detection keep a short per-member history in memory only.

## Mobile UI (/m/)

A second, phone-first front-end lives in `web/m/` and is served at `/m/`. It shares all logic modules with the desktop client by importing them in place (`web/js/api.js`, `ws.js`, `state.js`, `bus.js`, `i18n.js`, `permissions.js`, `utils.js`, `theme.js`, `e2ee/`, and `views/auth.js` for sign-in) and replaces only the views.

- **Routing.** `server/lib/uiRouting.js` handles `GET /` and `/index.html` before the static middleware. Android user agents and the future APK WebView token (`MeshCrowdAndroid/`) are redirected to `/m/`; Electron is always desktop; a `ui` cookie (`desktop` or `mobile`, set by visiting `/?ui=desktop` or `/?ui=mobile`) overrides the user agent. The mobile You tab links to `/?ui=desktop`.
- **CSP.** `buildCsp` hashes the inline importmap of `web/index.html`; `web/m/index.html` carries a byte-identical importmap, enforced by a test in `csp.test.js`.
- **Structure.** `web/m/main.js` boots (`api.me` -> i18n -> auth screen on 401 -> `data.js` load + websocket wiring -> `router.js`). The router keeps a screen stack, mapped to the history API so the hardware back button pops one screen (and closes an open sheet first). Sheets (`components/bottomSheet.js`) own no history entries.
- **Pure logic** (nav stack, message window merging, DM preview, search history, info-item extraction) is in `web/m/lib/*.mjs` with `*.test.mjs` unit tests.
- **Sizing.** Fluid layout (`clamp()`, `%`, `dvh`, safe-area insets, 44px tap targets, 720px content cap), portrait and landscape. `server/tools/mobileMatrix.mjs` checks for horizontal overflow at 7 phone/tablet sizes in both orientations at 100% and 200% text scale.
- **Live testing.** `server/tools/mobileLive.mjs <shotsDir> <flow>` drives ChromePortable with an Android user agent against an isolated server (`DISMESH_DATA_DIR`, port 8099).
- **Android hook.** The You tab feature-detects `window.MeshCrowdAndroid` (`getSettings`, `setPollMinutes`, `setFastMode`, `changeServer`, `openBatterySettings`) provided by the APK shell; the shell asks `window.__mcBack()` on every back press and opens `#open=dm:<id>[:msg]`, `#open=channel:<server>:<channel>[:msg]`, `#open=thread:...` links from notification taps.

## Slash commands, age gate, verification levels, role icons

- **Slash commands.** `lib/bots/commands.js` validates and stores a bot's command list (`bot_commands`), lists the commands a
  server's members can use (bots with an enabled webhook), converts typed options and tracks interactions (`bot_interactions`: a
  random id, 15 minutes, 5 answers). `routes/botCommands.js` is the member side (list, invoke), `routes/botApi.js` the bot side
  (register, respond). An invocation is a signed `command` webhook through the existing queue in `lib/bots/webhooks.js`. A normal
  answer goes through `postAsBot` and sets `messages.interaction_command/interaction_user_id` (serialized as `interaction`); an
  ephemeral one is a websocket event to one user only and has no row anywhere. Clients parse input with `web/js/slashCommands.js`
  (shared by desktop and `/m/`).
- **Age gate.** `lib/ageGate.js`: `channels.nsfw` plus `users.nsfw_ack_at`. `nsfwBlock` guards the channel and thread message routes
  and the two search routes; bots are exempt. Clients show `web/js/ageGate.js` when a load answers `code: "nsfw"`.
- **Verification level.** `lib/verification.js` (`servers.verification_level`, rules by account age from `users.created_at` and
  membership age from `server_members.joined_at`), checked next to the timeout and slowmode checks when posting.
- **Role icons.** `roles.icon_emoji` / `roles.icon_path` (uploads in `data/roleicons`), shown through `web/js/roleIcon.js`.

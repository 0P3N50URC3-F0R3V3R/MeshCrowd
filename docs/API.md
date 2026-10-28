# API Reference

Base: the server runs HTTPS on `data/config.json`'s `httpsPort` (default `8443`; self-signed
cert, or your own via `serverCrt`/`serverKey`) unless `useHttps` is `false`, in which case it's
plain HTTP on `port` (default `8080`).
All JSON endpoints live under `/api/*`. Auth is a session cookie (`dismesh_session`, httpOnly, set
automatically by register/login responses) — browser `fetch` calls must use
`credentials: 'include'` if the request isn't same-origin. Static uploads are served at
`/uploads/avatars/*`, `/uploads/attachments/*`, `/uploads/servericons/*`, `/uploads/channelicons/*`,
`/uploads/banners/*`, `/uploads/cards/*`, `/uploads/emoji/*`, `/uploads/stickers/*`,
`/uploads/sounds/*`, `/uploads/webhookicons/*`. Realtime: `wss://<host>:<httpsPort>/ws` — auth is
the same cookie, sent automatically same-origin.

Every error response is `{"error": "message"}` with a 4xx/5xx status. Endpoints below are grouped
by route file; permission requirements are noted per-endpoint.

## Auth (`server/routes/auth.js`, mounted at `/api/auth`)

| Method & path | Body | Notes |
|---|---|---|
| `GET /login-params?username=` | — (no auth, rate-limited 30/min per IP) | First step of a web sign-in. `{v: 1, mode: 'password', salt: null}` for a legacy account, `{v: 1, mode: 'split', salt}` (base64 of 16 bytes) for a strengthened one. An unknown name (and the reserved `__webhook__` account) answers `mode: 'split'` with a deterministic fake salt (HMAC under a server secret, case-insensitive), so it looks like a split account and fails like a wrong password. Always `Cache-Control: no-store`. 400 if `username` is missing, repeated (array), empty or over 64 chars. See [Split sign-in](#split-sign-in-authkey). |
| `POST /register` | legacy `{username, password, email, displayName?}` **or** split `{username, authKey, authSalt, email, displayName?}` | `username`: 3-32 chars, `[a-zA-Z0-9_.]`. Legacy: `password` 8+ chars (the Android app). Split: `authKey`/`authSalt` derived in the browser, creates a split account without a Passport (the web client uses this only when `/api/passport/register` is unavailable because the server does not recognise its own address). Sending both shapes is 400. **The first account ever registered becomes the server Owner** (all site permissions). Returns `{user}` and sets the session cookie. |
| `POST /login` | legacy `{username, password}` **or** split `{username, authKey}` | Returns `{user}`, or `{requiresTotp: true, pendingToken}` if the account has 2FA enabled — follow up with `/login/2fa`. A split account never accepts a plaintext `password`, and a legacy account never accepts an `authKey`: both give `401`. A plaintext attempt on a split or unknown name gets `401 {"error": "invalid credentials. If you strengthened your sign-in, use the web app or an updated app."}` (what Android apps older than 3.0 shows after its account is strengthened); every other failure is `401 invalid credentials`. Each path does exactly one bcrypt comparison, so unknown, legacy and split names take the same time. |
| `POST /login/2fa` | `{pendingToken, code}` | Second step of login when 2FA is enabled. `code` is a 6-digit TOTP code or an unused recovery code. A wrong code doesn't burn `pendingToken` (rate-limited instead); it expires after 5 minutes. |
| `POST /2fa/setup` | — (authenticated) | `{secret, otpauthUrl, qrDataUrl}` — generates and stores a *pending* secret, not yet enabled. |
| `POST /2fa/enable` | `{code}` | Confirms the code against the pending secret from `/setup`, turns 2FA on. Returns `{ok, recoveryCodes}` — 8 single-use codes, shown once. |
| `POST /2fa/disable` | `{code}` | `code` is a TOTP code or a recovery code. |
| `POST /change-password` | legacy `{currentPassword, newPassword, backup?}` **or** split `{currentAuthKey, newAuthKey, newAuthSalt, backup?}` | Authenticated. 401 `current password is incorrect` on a wrong current credential; legacy `newPassword` 8+ chars; split keys must be canonical base64 of 32 bytes (`authKey`) and 16 bytes (`authSalt`), else 400. The client derives `currentAuthKey` with the salt from `login-params` and the new pair with a **fresh** salt. For an account with a Passport, `backup` (the seed re-wrapped under the new password, or under the new `wrapKey` for a split account, tagged `salt: 'split:v1'`; same shape as in the Passport section below) is **required** and saved atomically with the hash, otherwise the cached seed could never be unwrapped at the next login. The backup tag must match the account mode. Other sessions and their sockets are ended; the calling session stays. Returns `{ok}`. Rate-limited (10/min). |
| `POST /upgrade-credentials` | `{currentPassword, authKey, authSalt, backup?, code?}` | Authenticated, rate-limited (10/min per IP). Turns a legacy account into a split one ("Strengthen sign-in"). `currentPassword` is checked against the legacy hash; only if it is right is `code` (TOTP or recovery code, required when 2FA is on) checked, so a wrong password never burns a recovery code. `backup` (tag `split:v1`) is required for an account with a Passport and refused for one without. In one transaction the legacy bcrypt(password) is **overwritten** with bcrypt(`authKey`), `auth_mode` becomes `split`, the backup is replaced and every other session is deleted; sockets are closed. 409 `sign-in is already strengthened`, 400 on malformed keys or a wrong backup tag, 401 `invalid credentials` (`requiresTotp` when a code is missing), 429 after 5 failures in 15 minutes. Returns `{user}` with `authMode: 'split'`. Afterwards the plaintext `/login` is refused for the account (so Android apps older than 3.0 cannot sign in). The new password must differ from the old one (enforced by the web client: the server saw the old one at every legacy sign-in). |
| `POST /logout` | — | `{ok}` |
| `GET /me` | — | `{user}` (401 if not logged in) |

### Split sign-in (`authKey`)

New web accounts never send their password. The browser derives two keys from it with Argon2id
(constants fixed in the client, see [ARCHITECTURE.md](ARCHITECTURE.md#split-sign-in-authkey-and-wrapkey)):
`authKey` (sent, the sign-in secret; the server stores bcrypt of it) and `wrapKey` (never sent; wraps the
Passport seed backup). `authKey` is the canonical base64 of 32 bytes (44 chars), `authSalt` the canonical
base64 of 16 bytes. **`authKey` is a password-equivalent for this server**: whoever captures it can sign in
here, so these endpoints must only be used over TLS. The server cannot see the password, so the
8-character minimum is enforced by the client only for split accounts.
`user.authMode` (`'password'` or `'split'`, own account only) says which sign-in an account uses.

`user` shape: `{id, username, passportId, displayName, avatarPath, bannerColor, bannerPath, cardColor,
cardPath, status, customStatusText, customStatusEmoji, isSiteAdmin, bio, email?, dmPrivacy?,
profilePrivacy?, discoverable?, totpEnabled?, notifySoundMode?, authMode?}` — the `?` fields are only present
when viewing yourself.

## Passport (`server/routes/passport.js`, mounted at `/api/passport`)

Portable identity: an Ed25519 key pair derived from a 32-byte seed the client holds (see
[ARCHITECTURE.md](ARCHITECTURE.md#passport-portable-identity)). The server only ever sees public
keys, a seed blob wrapped under a key derived from the user's password (`backup`), and signed proofs. All endpoints
are rate-limited (30/min per IP), audited in `passport_audit`, and answer every proof failure with
the same `401 {"error":"invalid passport proof"}`.

**Proof** = `{nonce, issuedAt, signature}`: take a challenge from `/challenge`, sign
`meshcrowd-passport-v1|<purpose>|<origin>|<nonce>|<issuedAt>` with the Passport signing key and send the
base64 signature. `purpose` is `register`, `login`, `recover` or `attach`; `origin` is the server origin
the browser used (`location.origin`). A nonce is single-use (consumed first, on every proof endpoint,
whatever else is wrong) and valid for 60 s. The origin must be allow-listed, see
[README Configuration](../README.md#passport-origins) (`publicHost`, `passportOrigins`, loopback hosts).

**Backup** = `{encryptedKey, salt, nonce}` (base64 strings, each up to 4096 chars): the seed wrapped with
a key derived from the login password (Argon2id + secretbox). For **legacy** accounts the key comes from the password itself, which the server sees at sign-in, so a malicious or compromised operator could in principle unwrap the seed. For **split** accounts the key is the browser-only `wrapKey`, the backup is tagged `salt: 'split:v1'` (the Argon2 salt is `users.auth_salt`) and the server never sees the password or `wrapKey`. The server enforces that a split account only stores a `split:v1` backup and a legacy account never does.

| Method & path | Body | Notes |
|---|---|---|
| `POST /challenge` | `{}` | Returns `{nonce, issuedAt, origin}`. 400 `unrecognised server address` if the request's origin is not allow-listed. |
| `POST /register` | `{username, email, authKey, authSalt, displayName?, passportPublicKey, e2eePublicKey, backup, nonce, issuedAt, signature}` | Creates a **split** account bound to the Passport (purpose `register`); `backup` must be `split:v1`. A `password` field or a legacy-tagged backup is 400. Public keys are canonical base64 of 32 bytes. 201 `{user}` + session cookie. 409 `{error, username}` if this Passport already has an account on this server (one account per Passport per server); 409 if username/email is taken; 401 on a bad proof. |
| `POST /login` | `{passportId, nonce, issuedAt, signature}` | Purpose `login`. `passportId` matches `^mc1[a-z2-7]{52}$`. Returns `{user}` + cookie, or `{requiresTotp: true, pendingToken}` for a 2FA account (finish with `/api/auth/login/2fa`). 403 for a disabled account. |
| `POST /recover` | `{passportId, newAuthKey, newAuthSalt, backup, code?, nonce, issuedAt, signature}` | "Forgot password": purpose `recover`. Shape checks (400) run before the proof, so a malformed body does not burn the challenge. Sets the new split credential, stores the `split:v1` `backup`, ends all sessions and sockets, and returns `{user}` with a fresh cookie. **A legacy account is converted to split** (an explicit user action; the recover screen warns that older Android versions can no longer sign in). For a 2FA account `code` (TOTP or recovery code) is also required: 401 `{requiresTotp: true}` without it. |
| `POST /attach` | `{passportPublicKey, e2eePublicKey, backup, currentPassword \| currentAuthKey, code?, nonce, issuedAt, signature}` | Authenticated. Binds a new Passport to an existing account that has none (e.g. one created by the Android app); purpose `attach`. Legacy account: `currentPassword` and a legacy-wrapped `backup`. Split account without a Passport (created through the web fallback): `currentAuthKey` and a `split:v1` `backup`. The backup tag must match the account mode. Needs the current credential, and the 2FA `code` when 2FA is on, so a stolen session alone cannot add a recovery path. The proof is evaluated (and its nonce consumed) before the credential check; a recovery code is consumed only when the credential was right. 409 if the account already has a Passport or the Passport is used by another account here. Returns `{user}`. |

**Lockout:** failed proofs are counted per Passport ID (and per user for `attach`): 5 failures within
15 minutes lock that ID for 15 minutes (`429 too many attempts, try again later`). Failures while locked
do not extend the lock; a success clears the counter. Password login (`/api/auth/login`) is not affected. `upgrade-credentials` failures use a separate per-user tracker (`upgrade:<userId>`, same 5 / 15 min rule) and write the audit actions `upgrade`, `upgrade_locked` and `admin_reset`.

## Users (`server/routes/users.js`, mounted at `/api/users`)

| Method & path | Body | Notes |
|---|---|---|
| `PATCH /me` | `{displayName?, bio?, dmPrivacy?('everyone'\|'friends'\|'none'), profilePrivacy?('everyone'\|'friends'), discoverable?}` | `{user}` |
| `GET` / `PUT /me/server-layout` | `{layout}` on PUT | Persists the client's server-rail folder/ordering layout (opaque JSON to the server). |
| `GET` / `PUT /me/theme` | `{theme: {brand, bgRail, bgSidebar, bgPrimary, bgFloating, textPrimary, textSecondary, font}}` on PUT | Per-user UI theme (colors are `#rrggbb` or empty string for "app default"; `font` is one of a fixed whitelist). Sanitized server-side — invalid values fall back to defaults, never stored raw. See `server/lib/theme.js`. |
| `GET` / `PUT /me/ui-prefs` | `{sidebarWidth?, membersWidth?}` on PUT | `{uiPrefs}` — resizable panel widths in px, each clamped to 180-400; unknown keys are dropped. PUT merges with what's stored. |
| `POST /me/folder-icon` | multipart `icon` | Uploads an icon for a server-rail folder; returns `{iconPath}` (the client embeds it into the folder object it PUTs to `/me/server-layout`). |
| `POST /me/avatar` | multipart `avatar` (png/jpg/gif/webp, max 5MB) | `{avatarPath}` |
| `POST` / `DELETE /me/banner` | multipart `banner` on POST | Profile-card banner image. |
| `POST` / `DELETE /me/card` | multipart `card` on POST | Profile-card background image. |
| `PUT /me/status` | `{status?('online'\|'idle'\|'dnd'\|'invisible'), customStatusText?, customStatusEmoji?, notifySoundMode?('auto'\|'always'\|'never')}` | `{ok}`, broadcasts `presence` over WS. `status` is your *preference*; whether you show as online at all also depends on live WS connection state — see [ARCHITECTURE.md](ARCHITECTURE.md#presence). |
| `GET /search?q=` | — | `{users}` — matches discoverable users by username/display name (excludes users who opted out via `discoverable: false`, and anyone who has blocked/been blocked by you). |
| `GET /:id` | — | `{user}` — includes `mutualServers: [{id, name}]` when viewing someone else. |

## Friends (`server/routes/friends.js`, mounted at `/api/friends`)

| Method & path | Body | Notes |
|---|---|---|
| `GET /` | — | `{friends: [{status, direction, user}], pending: [...], blocked: [...]}` |
| `POST /request` | `{username}` | `{ok}`, pushes WS `friend_request` to the target. A block is indistinguishable from "user not found" (never confirms to the sender that they've been blocked). |
| `POST /:userId/accept` | — | `{ok}`, pushes WS `friend_accept`. |
| `POST /:userId/block` | — | `{ok}` |
| `DELETE /:userId` | — | Remove / decline / cancel a request, or lift a block you placed (only the party who blocked can unblock). |
| `GET /activity/voice` | — | `{activity}` — which of your friends are currently in a voice channel, and where (initial snapshot; live updates arrive over WS as `friend_voice`). |

## Servers (guilds) (`server/routes/servers.js`, mounted at `/api/servers`)

| Method & path | Body | Notes |
|---|---|---|
| `POST /` | `{name, description?, visibility?('private'\|'public'), autoJoin?}` | `{server}` — creates an `@everyone` role and a `#general` channel automatically. `autoJoin` (public servers only): every new site account joins automatically. |
| `GET /` | — | `{servers}` — servers you're a member of. |
| `POST /join` | `{inviteCode}` | `{server}` |
| `GET /discover?q=` | — | `{servers}` — publicly-visible servers, searchable. |
| `POST /:id/join-public` | — | Join a public server directly (no invite code needed). |
| `POST /:id/invite-direct` | `{userId}` | Needs `CREATE_INVITE`. Grants immediate membership to `userId` — the "Invite to Server" action from a profile card. |
| `POST /channel-invites/:code/join` | — | Redeem a *channel-scoped* invite (different code namespace from the server-wide `inviteCode`) — joins the server if needed and grants `VIEW_CHANNEL` on that one channel via a per-user override. |
| `GET /:id` | — | `{server, channels, categories, roles, members, welcomeChannels, customEmoji, stickers, sounds}` — `channels` pre-filtered to ones you can `VIEW_CHANNEL`, each with `overrides: [{role_id, allow, deny}]` and `icon_path`. `members[i] = {nickname, roleIds, timeout_until, user}`. `server.invite_code` is `null` unless you hold `CREATE_INVITE`. |
| `GET /:id/search?q=&channelId=&limit=&fields=` | — | Search scoped to channels (and their threads) you can view; omit `channelId` to search the whole server. `fields` — see [Search](#search). |
| `GET /:id/voice-activity` | — | Who's currently in which voice channel on this server. |
| `PATCH /:id` | `{name?, description?, visibility?, autoJoin?}` | Needs `MANAGE_SERVER`. |
| `POST` / `PATCH` / `DELETE /:id/welcome-channels[/:wcId]` | `{channelId, description?}` | Needs `MANAGE_SERVER`. Configures the server's welcome screen. |
| `POST /:id/icon` | multipart `icon` | Needs `MANAGE_SERVER`. |
| `POST` / `DELETE /:id/emoji[/:emojiId]` | `{name}` + multipart `image` on POST | Needs `MANAGE_SERVER`. Custom server emoji. |
| `POST` / `DELETE /:id/stickers[/:stickerId]` | `{name, description?}` + multipart `image` on POST | Needs `MANAGE_SERVER`. |
| `POST` / `DELETE /:id/sounds[/:soundId]` | `{name, emoji?}` + multipart `audio` on POST | Needs `MANAGE_SERVER`. Server soundboard. |
| `GET` / `POST` / `PATCH` / `DELETE /:id/events[/:eventId]` | `{name, description?, location?, channelId?, startTime, endTime?}` | Create/edit needs `MANAGE_SERVER`; anyone can list. Scheduled events. |
| `PUT` / `DELETE /:id/events/:eventId/rsvp` | — | Any member can RSVP/un-RSVP. |
| `DELETE /:id` | — | Owner only. |
| `POST /:id/leave` | — | |
| `POST /:id/invite/regenerate` | — | Needs `MANAGE_SERVER`. Rotates the one server-wide invite code (invalidates the old one for everyone). Returns `{inviteCode}`. |
| `POST` / `PATCH` / `DELETE /:id/categories[/:categoryId]` | `{name, position?}` | Needs `MANAGE_CHANNELS`. Channel categories/folders in the sidebar. |
| `POST /:id/channels` | `{name, type, topic?, categoryId?}` | Needs `MANAGE_CHANNELS`. `type` is one of the channel types below. |
| `PATCH` / `DELETE /:id/channels/:channelId` | `{name?, type?, topic?, position?, categoryId?}` (create also takes `voiceQuality?`) | Needs `MANAGE_CHANNELS`. `voiceQuality` is `mobile\|low\|medium\|high\|hd` (voice/stage channels; default `medium`; create only; `PATCH` with it returns 400 - recreate the channel to change quality). |
| `POST /:id/channels/:channelId/icon` | multipart `icon` | Needs `MANAGE_CHANNELS`. `{iconPath}`. |
| `GET` / `POST` / `POST .../icon` / `POST .../regenerate` / `DELETE /:id/channels/:channelId/webhooks[/:webhookId...]` | `{name}` | Needs `MANAGE_CHANNELS`. Incoming webhooks — see [Webhooks](#webhooks) below for how to post through one. |
| `PUT /:id/channels/:channelId/slowmode` | `{seconds}` | Needs `MODERATE_MEMBERS`. |
| `PUT /:id/channels/:channelId/overrides/:roleId` | `{allow, deny}` (bitflags) | Needs `MANAGE_CHANNELS`. Required to make a `private` channel visible to a non-mod role: send `{allow: 1}` (the `VIEW_CHANNEL` bit). |
| `POST` / `PATCH` / `DELETE /:id/roles[/:roleId]` | `{name, color?, permissions?, position?}` | Needs `MANAGE_ROLES`. Cannot delete `@everyone`. A role can never be granted permission bits the granter doesn't already hold themselves (prevents privilege escalation). |
| `PUT` / `DELETE /:id/members/:userId/roles/:roleId` | — | Needs `MANAGE_ROLES`. Assign/unassign a role. |
| `PATCH /:id/members/:userId/nickname` | `{nickname}` (omit/null to clear) | Self needs `CHANGE_NICKNAME`; changing someone else needs `MANAGE_NICKNAMES`. |
| `PATCH /:id/members/:userId/color` | `{color}` — `#rrggbb`, or `null` to clear | Needs `MANAGE_NICKNAMES`. Per-member name color that overrides their highest colored role. Audit-logged; broadcasts `member_role_update`. |
| `POST /:id/members/:userId/kick` | — | Needs `KICK_MEMBERS`. |
| `POST` / `DELETE /:id/members/:userId/ban` / `/:id/bans/:userId` | `{reason?}` on ban | Needs `BAN_MEMBERS`. |
| `PUT` / `DELETE /:id/members/:userId/timeout` | `{minutes}` on PUT | Needs `MODERATE_MEMBERS`. Timed-out members can view but not post/react. |
| `GET /:id/audit-log?before=` | — | Needs `VIEW_AUDIT_LOG`. Paginated log of moderation/settings actions. |
| `GET /:id/prune/channels` | — | Needs `PRUNE_CONTENT`. `{channels}` — this server's channels, for the prune picker. |
| `POST /:id/prune/preview` | `{channelIds: [...], cutoff, purgeAttachments?}` | Needs `PRUNE_CONTENT`. `{messageCount, attachmentCount, attachmentBytes}` — what an execute with the same body would remove. All channels must belong to this server. |
| `POST /:id/prune/execute` | same as preview + `notify?('immediate'\|'grace')` | Needs `PRUNE_CONTENT`. See [Data pruning](#data-pruning). |

### Channel types (server-enforced, not just UI)

| `type` | Behavior |
|---|---|
| `public` | Default text channel — visibility/posting governed by role permissions. |
| `private` | `VIEW_CHANNEL` denied unless the member's role has an explicit `allow` override (or a per-user override, or they hold `MANAGE_CHANNELS`/`MANAGE_MESSAGES`/`ADMINISTRATOR`). |
| `announcement` / `readonly` | Everyone with `VIEW_CHANNEL` can read; `SEND_MESSAGES` is stripped unless the member holds `MANAGE_CHANNELS`/`MANAGE_MESSAGES`/`ADMINISTRATOR` ("mod+ only" posting). |
| `voice` | No text messages — join/leave/signal entirely over WS (see [Voice protocol](#voice--stage-protocol-over-ws)). `VIEW_CHANNEL` is the only permission that gates joining. |
| `stage` | A voice room with a Speaker/Audience split — audience members can't transmit audio until invited to speak or they raise a hand and a speaker/moderator invites them. |
| `forum` | No top-level messages — its content is entirely threads (posts). See [Threads](#threads-serverroutesthreadsjs-mounted-at-apiservers-idchannels-channelidthreads). |
| `notes` | Per-member encrypted journal. Private to each member; the server stores only ciphertext. See [Notes channels](#notes-channels-apiserversidchannelschannelIdnotes) below. |

## Messages (`server/routes/channelMessages.js`, `dms.js`, `messages.js`)

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/servers/:id/channels/:channelId/messages?before=&limit=&around=` | — | `{messages}`, oldest-first within the page. Needs `VIEW_CHANNEL`. |
| `POST /api/servers/:id/channels/:channelId/messages` | multipart or JSON: `content`, optional `files` (up to 5, field name `files`), optional `replyToMessageId`, `stickerId` | Needs `SEND_MESSAGES` (and not timed out). `{message}`, also pushed live over WS to everyone with `VIEW_CHANNEL` as `message_create`. |
| `GET /api/dms` | — | `{dms: [{id, isGroup, name, createdBy, e2eeEnabled, e2eeEligible, members, lastMessage, readStates}]}` — `e2eeEnabled` is true if encryption is active; `e2eeEligible` is true if both parties are local (1:1 only). |
| `POST /api/dms` | `{userId}` | `{dmId}` — opens or reuses a 1:1 DM; blocked by the target's `dmPrivacy`/block settings. |
| `POST /api/dms/:dmId/encryption/enable` | — | 1:1 DM only, both parties must be local, encryption not already enabled. Sets `dm_channels.e2ee_enabled` and broadcasts a system event. Once enabled, all messages must use the E2EE envelope format (see below). Returns `{ok}`. |
| `POST /api/dms/group` | `{userIds: [...], name?}` | `{dmId}` — capped at 10 members, every member's block/privacy re-checked. |
| `GET /api/dms/:dmId/messages?before=&limit=` / `POST (same shape as channel messages)` | | In an encrypted DM the POST is JSON `{content: <envelope>, replyToMessageId?, fileIds?}`; multipart uploads are 400. `fileIds` (max 5) must be your own unsent blobs in this DM and are attached to the new message. |
| `GET /api/dms/:dmId/search?q=&limit=&fields=` | — | `{messages}` |
| `POST /api/dms/:dmId/e2ee-files/:blobId` | raw `application/octet-stream` body | Encrypted 1:1 DM only (400 otherwise), members only (403). `blobId` is 32 lowercase hex chars chosen by the client (it is bound into the file's AEAD). Body is `iv (12) \|\| AES-GCM ciphertext`, at least 28 bytes and at most the site upload limit + 28 (413). At most 10 unsent uploads per member per DM (429); a reused `blobId` is 409. Returns 201 `{file: {id, size}}`. |
| `GET /api/dms/:dmId/e2ee-files/:blobId` | — | Members only. The ciphertext as `application/octet-stream`, `Content-Disposition: attachment`, `no-store`. A blob is only found through the DM it was uploaded to (404 elsewhere), and an unsent one only by its uploader. |
| `DELETE /api/dms/:dmId/e2ee-files/:blobId` | — | Withdraws your own unsent upload. Sent blobs are removed with their message. |
| `DELETE /api/dms/:dmId/members/me` | — | Leave a DM or group DM. If you were the last member, the conversation and its attachments are deleted. |
| `DELETE /api/dms/:dmId` | — | Group creator only (never a 1:1 DM). Deletes the group for every member; they receive WS `dm_delete`. |
| `POST /api/dms/:dmId/prune/preview` | `{cutoff, purgeAttachments?}` | Group creator only. Same response as the server prune preview. |
| `POST /api/dms/:dmId/prune/execute` | `{cutoff, purgeAttachments?}` | Group creator only. Runs immediately. |
| `PATCH /api/messages/:id` | `{content}` | Author only. |
| `DELETE /api/messages/:id` | — | Author, or `MANAGE_MESSAGES` (resolved via the channel, or the thread's parent channel). Attachments are unlinked from disk on delete. |
| `POST /api/messages/:id/forward` | `{scopeType, scopeId}` | Forward a message into another channel/DM/thread you can post in. |
| `PUT` / `DELETE /api/messages/:id/reactions/:emoji` | — | Add/remove your own reaction. |
| `PUT` / `DELETE /api/messages/:id/pin` | — | Needs `MANAGE_MESSAGES` (or channel default per `server/lib/permissions.js`). |
| `GET /api/messages/pins?scopeType=&scopeId=` | — | `{messages}` — a scope's pinned messages, listed newest-pinned-first. |

All three message POST endpoints (channel/DM/thread) accept `replyToMessageId` (must belong to the
same scope) to quote-reply, and `stickerId` to send a server sticker.

`message` shape: `{id, scopeType('channel'|'dm'|'thread'), scopeId, author, isWebhook, content,
isEncrypted, eventType, createdAt, editedAt, attachments: [{id, url, fileName, mimeType, sizeBytes}], reactions:
[{emoji, userIds}], replyTo, pinnedAt, pinnedBy, embed, poll, forwardedFrom, sticker}`.
`isEncrypted` is true only for encrypted DMs (see [E2EE envelope](#e2ee-envelope) below).
`eventType` is non-null for system messages (member joined, channel renamed, etc.) generated by
`server/lib/systemMessages.js`.

### Polls (`server/routes/polls.js`, mounted at `/api/polls`)

| Method & path | Body | Notes |
|---|---|---|
| `POST /` | `{scopeType('channel'\|'thread'\|'dm'), scopeId, question, options: [2-10 strings], multiSelect?}` | Posts a poll as a regular message (`{message}`). |
| `PUT` / `DELETE /:pollId/vote/:optionId` | — | Cast/retract a vote. |

### Threads (`server/routes/threads.js`, mounted at `/api/servers/:id/channels/:channelId/threads`)

Forum posts, or a "Create Thread" spun off an existing channel message.

| Method & path | Body | Notes |
|---|---|---|
| `GET /` | — | `{threads: [{id, channelId, parentMessageId, title, createdBy, archived, createdAt, messageCount, lastMessageAt}]}`, newest-activity-first. |
| `POST /` | `{title, content, parentMessageId?}` | Needs `SEND_MESSAGES` on the parent channel. `{thread, message}` — `content` becomes the thread's opening message; omit `parentMessageId` for a forum post, set it to spin a thread off an existing channel message. |
| `PATCH /:threadId` | `{title?, archived?}` | Thread creator or `MANAGE_CHANNELS`. |
| `DELETE /:threadId` | — | Thread creator or `MANAGE_CHANNELS`. Deletes the thread, all its messages, and broadcasts `thread_delete` over WS. Audit-logged. |
| `GET /:threadId` / `GET /:threadId/messages?before=&limit=&around=` | — | |
| `POST /:threadId/messages` | (same shape as channel messages) | 403 if the thread is archived. |

A thread has no permissions of its own — view/post/moderate is entirely inherited from the parent
channel's permissions.

### Channel invites (`server/routes/channelInvites.js`, mounted at `/api/servers/:id/channels/:channelId/invites`)

Separate from the server-wide `invite_code` — grants access to one specific channel, gated on
`MANAGE_CHANNELS` (managing invites is treated as channel management, not the lighter
`CREATE_INVITE`).

| Method & path | Body | Notes |
|---|---|---|
| `GET /` | — | `{invites: [{id, code, maxUses, uses, expiresAt, createdAt}]}` |
| `POST /` | `{maxUses?, expiresInHours?}` | `{invite}` |
| `POST /direct` | `{userId}` | Immediately grants that user `VIEW_CHANNEL` (joins the server too, if needed) — no code exchange. |
| `DELETE /:inviteId` | — | Revoke. |

Redeem a code (from `/api/servers/channel-invites/:code/join`, listed above under Servers) — a
404 if invalid, 410 if expired or at its use limit.

## Notes channels (`server/routes/notes.js`, mounted at `/api/servers/:id/channels/:channelId/notes`)

Personal encrypted journals (channel type `notes`). The server stores only encrypted blobs; the client 
holds the decryption key derived from the user's Passport seed. All operations are per-user only.

| Method & path | Body | Notes |
|---|---|---|
| `GET /?before=&limit=` | — | `{notes: [{id, nonce, ciphertext, createdAt, editedAt, files: [{id, size}]}]}`, newest-first. `nonce` and `ciphertext` are base64, max 40 KB. |
| `POST /` | `{nonce, ciphertext, fileIds?: []}` | Creates a note. `nonce` is base64, max 64 chars; `ciphertext` max 40 KB, base64. `fileIds` (optional) links previously-uploaded files. Returns `{note}`. |
| `PATCH /:noteId` | `{nonce?, ciphertext?, fileIds?}` | Update nonce/ciphertext and/or file list. Omitted fields are unchanged. |
| `DELETE /:noteId` | — | Deletes the note and its attached files. |
| `POST /files` | Raw binary body (iv \|\| ciphertext) | Uploads an encrypted attachment blob (client-side encrypted; server stores as-is). Max size per instance config + 1 MB. Returns `{file: {id, size}}`. |
| `GET /files/:fileId` | — | Returns the encrypted blob. 404 if file not found or not owned by the caller. |
| `DELETE /files/:fileId` | — | Deletes an unsaved file upload. 404 if already attached to a note. |
| `POST /trim` | `{before: <date string>}` | Admin only (requires `PRUNE_CONTENT` or `MANAGE_CHANNELS`). Deletes all notes in this channel older than `before`, without reading them. Returns `{deleted: <count>}` and audit-logs the action. |

**Quotas** (per member, per channel): max 5,000 notes, max 1 GB total file size. Unsaved uploads capped at 10.

## Link preview (`server/routes/linkPreview.js`, mounted at `/api/link-preview`)

| Method & path | Body | Notes |
|---|---|---|
| `POST /` | `{url}` | Authenticated. Fetches and returns a link preview for a URL (title, description, image, etc.). Used by encrypted DM clients, where the server never sees plaintext message content and thus cannot generate previews itself. Returns `{embed}` (or null on fetch failure). URL must be HTTP(S), max 2048 chars. Returns 400 for invalid URL. |

### Webhooks

Managed under `/api/servers/:id/channels/:channelId/webhooks` (see the Servers table above:
create/list/regenerate-token/delete, all `MANAGE_CHANNELS`). Posting *through* a webhook is a
separate, unauthenticated route meant for external services:

`POST /api/webhooks/:webhookId/:token` — `{content}` (JSON or form) — posts as the reserved
system account into the webhook's channel. Authenticated only by the token in the URL, not a
session cookie. Rate-limited by IP like other unauthenticated endpoints.

## Search

- `GET /api/search?q=&serverId=&limit=` — global/"Activity panel" search. Scoped server-side to
  one server (every channel and thread in it you can view) — `serverId` is required. Never
  searches DMs or other servers. Results carry `channelName`.
- `GET /api/servers/:id/search?q=&channelId=&limit=&fields=` — same engine, channel-scoped
  variant used by the docked search panel (with a "search entire server" toggle in the UI).
- `GET /api/dms/:dmId/search?q=&limit=&fields=` — DM-scoped.

`fields` is a comma-separated list of what `q` is matched against, OR'd together (default
`text`):

| Value | Matches |
|---|---|
| `text` | Message content (SQLite FTS5) |
| `usernames` | Author's username or display name |
| `attachments` | Attachment file names (substring, so `.pdf` finds PDFs) |
| `channelNames` | Every message in a channel/thread whose *name* matches (server search only) |

Text search uses SQLite FTS5 (`server/lib/search.js`), kept in sync with the `messages` table via
triggers, so every insert/edit/delete stays indexed automatically.

## Data pruning

Bulk-delete of message history before a `cutoff` date (any `Date`-parseable string, e.g.
`"2026-01-01"`). Implemented in `server/lib/prune.js`; three entry points with different
permissions: server-level (`/api/servers/:id/prune/*`, `PRUNE_CONTENT`), site-level
(`/api/admin/prune/*`, `PRUNE_DATA`), and group-DM creator (`/api/dms/:dmId/prune/*`).

- Pruning a channel also prunes every thread in it.
- `purgeAttachments: false` (default): messages that carry attachments are skipped entirely;
  `true`: they're deleted and their files are unlinked from disk.
- `notify: 'immediate'` (default) posts a notice into each affected conversation and deletes right
  away → `{status: 'done', ...counts}`. `notify: 'grace'` posts the notice now and schedules the
  delete 24 hours later → `{status: 'scheduled', executeAt, ...counts}`. A background worker
  checks for due prunes every minute.
- Server-level and site-level channel prunes are written to the server's audit log
  (`data_prune` / `data_prune_scheduled`).

## Reports & moderation

- `POST /api/reports` (authenticated) — `{reportedUserId, reason('spam'|'harassment'|'other'),
  details?, messageId?}` — file a report about another user. Anyone can file one about anyone,
  no shared server/DM required.
- Admin queue: see [Admin](#admin-site-wide-serverroutesadminjs-mounted-at-apiadmin) below.

## Notification prefs & read state

- `GET /api/notification-prefs` / `PUT /api/notification-prefs/:scopeType/:scopeId` — per-channel/
  DM notification override (mute, mentions-only, everything).
- `GET /api/read-state` / `PUT /api/read-state/:scopeType/:scopeId` — your read-pointer per scope,
  used for unread badges and the "Seen" tag.
- `GET /api/notifications/poll?since=<id>` — catch-up for clients with no open WebSocket (the
  Android background checker). Returns `{notifications, latestId}`: every stored notification
  newer than `since`, oldest first, max 50 per call. Each is `{id, scopeType, scopeId, serverId,
  serverName, channelName, message, mentioned, createdAt}`. Store `latestId` and send it as
  `since` next time; it advances even when the page is empty. Only the newest 200 per user are
  kept, and the same mute/mentions preferences as live notifications apply.

## Admin (site-wide) (`server/routes/admin.js`, mounted at `/api/admin`)

The whole router requires `requireAuth` + site permission `VIEW_ADMIN_PANEL` just to reach any
route in it; individual routes then layer a more specific permission on top.

| Method & path | Permission | Body/Notes |
|---|---|---|
| `GET` / `PATCH /settings` | (VIEW_ADMIN_PANEL) / `SITE_ADMINISTRATOR` | `{sessionTtlDays?, maxUploadMb?, allowedAttachmentExtensions?}` — session lifetime in days (0 or less = indefinite); runtime upload cap in MB (positive; the effective limit never exceeds `config.json`'s `maxUploadMb`); extension allowlist as an array like `[".png", ".pdf"]` (`[]` = no allowlist, only the built-in blocklist applies). Both methods return all three current values. |
| `GET /stats` | (VIEW_ADMIN_PANEL) | `{users, servers, messages}` instance-wide counts. |
| `GET /users` | `MANAGE_USERS` | `{users: [...{isDisabled, siteRoleIds, authMode}]}` |
| `PATCH /users/:id` | `MANAGE_USERS` | `{isDisabled?, displayName?, email?, bio?, password? \| authKey?+authSalt?}` — editing/disabling any account. Disabling revokes all sessions and closes live sockets immediately. A password reset depends on the target's `authMode` (`GET /users` rows carry it): legacy target `{password}` as before (`authKey`/`authSalt` is 400); split target `{authKey, authSalt}`, derived in the admin's browser from the new password with a **fresh** salt (`password` is 400, so the server never sees it). The mode is kept, all the user's sessions are revoked, sockets closed, and `admin_reset` is written to the audit table. The Passport backup stays and becomes unreadable under the new credential; the user restores it with the `.mcpass` file (Settings -> Passport). |
| `POST /users/:id/avatar` | `MANAGE_USERS` | multipart `avatar` — set another user's avatar. |
| `GET` / `DELETE /servers[/:id]` | `MANAGE_ANY_SERVER` | Site-wide server listing/deletion, independent of membership. |
| `GET` / `POST` / `DELETE /servers/:id/stickers[/:stickerId]` | `MANAGE_ANY_SERVER` | Manage any server's stickers regardless of membership. |
| `GET` / `POST` / `DELETE /servers/:id/sounds[/:soundId]` | `MANAGE_ANY_SERVER` | Same, for the soundboard. |
| `GET` / `PATCH /reports[/:id]` | `MANAGE_REPORTS` | `GET ?status=open\|resolved\|dismissed` (default `open`). `PATCH {status: 'resolved'|'dismissed'}`. |
| `GET` / `POST` / `PATCH` / `DELETE /site-roles[/:id]` | (VIEW_ADMIN_PANEL) / `MANAGE_SITE_ROLES` | `{name, color?, permissions?, position?}` — the staff-rank system. |
| `PUT` / `DELETE /users/:id/site-roles/:roleId` | `MANAGE_SITE_ROLES` | Assign/unassign a staff rank. |
| `GET /prune/servers` | `PRUNE_DATA` | `{servers}` — every server on the instance, for the prune picker. |
| `GET /prune/servers/:id/channels` | `PRUNE_DATA` | That server's channels. |
| `GET /prune/dms` | `PRUNE_DATA` | DMs/groups sorted by total size (messages + attachments). Shows member usernames only, never content. |
| `POST /prune/preview` | `PRUNE_DATA` | `{scopeKind: 'channels', channelIds: [...]}` or `{scopeKind: 'dm', dmChannelId}`, plus `cutoff`, `purgeAttachments?`. Channels must all belong to one server. |
| `POST /prune/execute` | `PRUNE_DATA` | Same body + `notify?('immediate'\|'grace')`. See [Data pruning](#data-pruning). |

### Permission bitflags

`PERMISSIONS` (per-server role bits, `server/lib/permissions.js`):

```
VIEW_CHANNEL=1, SEND_MESSAGES=2, MANAGE_MESSAGES=4, MANAGE_CHANNELS=8, MANAGE_ROLES=16,
MANAGE_SERVER=32, KICK_MEMBERS=64, BAN_MEMBERS=128, CREATE_INVITE=256, CHANGE_NICKNAME=512,
MANAGE_NICKNAMES=1024, ATTACH_FILES=2048, ADMINISTRATOR=4096, VIEW_AUDIT_LOG=8192,
MODERATE_MEMBERS=16384, PRUNE_CONTENT=32768
```

`SITE_PERMISSIONS` (site-wide staff bits):

```
VIEW_ADMIN_PANEL=1, MANAGE_USERS=2, MANAGE_SITE_ROLES=4, DELETE_ANY_MESSAGE=8,
MANAGE_ANY_SERVER=16, SITE_ADMINISTRATOR=32, MANAGE_REPORTS=64, PRUNE_DATA=128
```

`ADMINISTRATOR`/`SITE_ADMINISTRATOR` bypass all other checks in their scope. A role/rank can never
be granted a bit the granter doesn't already hold — this is enforced server-side everywhere
permissions are set or a role is assigned, not just in the UI.

**Frontend rule:** show the "Admin" nav entry/panel only when `user.isSiteAdmin === true`; hide it
entirely otherwise (not just disable it).

## Federation (optional, when `federation.enabled: true` in config.json)

Cross-instance relay of DMs and access to remote public servers. All endpoints require per-peer 
cryptographic verification (signature-based RPC). Remote server content is proxied live (not cached).

### Federation Admin (`server/routes/federationAdmin.js`, mounted at `/federation/admin`)

Separate credential from site admin (set via first-launch or reset by site admin). All routes 
(except `status`) require the federation admin session cookie.

| Method & path | Body | Notes |
|---|---|---|
| `GET /status` | — | `{configured, authenticated}` — public, shows whether federation admin is set up. |
| `POST /setup` | `{password}` | First-launch only (or after reset). Site admin or loopback trusted IP. Sets password (min 12 chars). Returns `{ok}` + sets session cookie. |
| `POST /login` | `{password}` | Sets session cookie on correct password. 401 on wrong password. |
| `POST /logout` | — | Clears session. |
| `POST /invites` | — | Creates a single-use invite (valid 30 minutes) for another instance to redeem. Returns `{token, url, fullUrl}`. |
| `GET /peers` | — | `{peers: [{id, domain, displayName, status, direction, lastSeenAt, createdAt}]}` — list of peer instances. |
| `POST /peers/:id/accept` | — | Accept an inbound pairing request. Sets status to `active`. |
| `POST /peers/:id/reject` | — | Reject an inbound pairing request (status `pending` → `revoked`). |
| `DELETE /peers/:id` | — | Revoke a peer (any status). Also sends a signed `peer_revoke` so the other side drops trust too. |
| `POST /redeem-invite` | `{invite, target?}` | Federation admin: paste another instance's invite link (or a bare token plus `target` URL). Performs the handshake and stores the peer as `pending` / `outbound` until the other side accepts. 502 if the other instance is unreachable or identifies itself inconsistently. |

**Rate limits** (per IP): 10/min login, 20/min redeem-invite, 600/min RPC. **Auth**: federation admin session cookie (`dismesh_federation_admin`, separate from site sessions).

### Federation API (`server/routes/federationApi.js`, mounted at `/federation/api`)

Unauthenticated endpoints for peer-to-peer handshakes, inbox (message relay), and RPC calls. All payloads 
are signed with Ed25519; `verifyFederationRequest` middleware validates the signature.

| Method & path | Body | Notes |
|---|---|---|
| `POST /handshake` | `{token, domain, publicUrl, pubkey, signature}` | A peer redeeming an invite. `domain` must equal the host of `publicUrl`, must not be this instance, and must not already belong to a peer with a different key. The invite is single-use. Creates a `pending` inbound peer and returns `{ok, domain, pubkey}`. |
| `POST /inbox` | Signed payload (type + data) | Receives relayed events (peer_accept, peer_reject, peer_revoke, user_update, friend_request, dm_message_create, dm_message_edit, dm_message_delete, dm_message_reaction, channel_message, channel_message_edit, channel_message_delete, channel_message_reaction). Signature verified before processing. |
| `POST /rpc` | Signed envelope `{event_id, type, origin_domain, created_at, payload, signature}` | Active peers only. Synchronous: replies `{ok, ...}` or `{ok:false, status, error}`. Types: `server_info`, `list_messages`, `channel_message_create`, `channel_message_edit`, `channel_message_delete`, `channel_reaction_add`, `channel_reaction_remove`, `leave_server`. The peer only asserts the user's identity; permissions are evaluated here from this instance's own member/role/override rows. Mutating types are replay-protected by `event_id`. |
| `POST /redeem-invite` | Signed envelope with `payload: {code, remoteId, username, displayName}` | Active peers only. A peer's user redeems a server invite code on this instance; returns `{ok, server, channels}` filtered to what that user can view. |
| `GET /servers` | Signed query `domain, timestamp, signature` | `{servers: [...]}`: public servers on this instance, for the peer's discovery. |
| `GET /ping` | Signed query `domain, timestamp, signature` | Reachability check for active peers. Returns `{ok}`. |

**Rate limits** (per IP): 120/min inbox, 10/min handshake, 600/min RPC. Requests carry 
Ed25519 signatures: POST bodies are signed envelopes, GETs sign `domain` and `timestamp` in the query (5-minute window). Outbound calls to peers use HTTPS only, refuse redirects and validate the resolved address at connect time.

### Remote Servers (`server/routes/remote.js`, mounted at `/api/remote`)

Authenticated endpoints for a user to interact with servers they've joined on peer instances. 
Content is proxied live via RPC; no local copies.

| Method & path | Body | Notes |
|---|---|---|
| `GET /servers` | — | `{servers: [{peerId, serverId, name, iconPath, domain, reachable}]}` — remote servers the user is a member of. |
| `GET /:peerId/:serverId` | — | `{server}` — server details (name, channels, roles, members). Only text channels exposed; voice/stage/forum/notes filtered. |
| `GET /:peerId/:serverId/channels/:channelId/messages?before=&limit=` | — | Paginated messages from a remote text channel. |
| `POST /:peerId/:serverId/channels/:channelId/messages` | `{content, files?, replyToMessageId?}` | Post a message to a remote channel (relayed via RPC). Author is the local user. |
| `PATCH /:peerId/:serverId/messages/:messageId` | `{content}` | Edit a message you authored. |
| `DELETE /:peerId/:serverId/messages/:messageId` | — | Delete a message you authored. |
| `PUT /:peerId/:serverId/messages/:messageId/reactions/:emoji` | — | Add a reaction. |
| `DELETE /:peerId/:serverId/messages/:messageId/reactions/:emoji` | — | Remove your reaction. |
| `POST /:peerId/:serverId/leave` | — | Leave the remote server (drops local membership ledger). |

**Rate limits** (per user): 600/min GET, 60/min writes (POST/PATCH/DELETE). All calls fan out via RPC 
to the peer; failures (403, 404, 429) are passed through; 502 if peer unreachable.

## Misc

- `GET /api/voice/ice` — signed-in users; `{iceServers, ttlMs, builtIn}`: the operator's external ICE servers plus, when the
  built-in server runs, its STUN url and a TURN entry with a short-lived credential (`username` = `<expiry>:u<userId>`).
  `Cache-Control: no-store`, rate-limited.
- `GET /api/admin/calls`, `PATCH /api/admin/calls`, `POST /api/admin/calls/test`, `POST /api/admin/calls/detect-ip` — site
  administrators. `PATCH` takes `{turn: {enabled, port, tcp, externalIp, advertisedHost, relayPortMin, relayPortMax, realm,
  credentialTtlSeconds, allowPrivatePeers, maxAllocations, maxAllocationsPerUser, maxKbps, rotateSecret}, iceServers: [{urls, username?, credential?}]}`,
  validates, saves to `data/config.json` and restarts the relay live; the response is `{turn, iceServers, publicHost, status}`
  (the secret is never returned). `test` allocates a relay against the running server; `detect-ip` asks a public STUN server.
- `GET /api/invites/:code` — public, rate limited (30/min/IP): `{kind, name, description, iconPath, memberCount, channelName}` for a server, vanity, extra or channel invite code (`memberCount` is `null` for private servers), `404` unknown, `410` expired or used up. Never consumes a use. `GET /i/:code` is the HTML landing page built from the same data.
- `GET /api/config` — `{maxUploadMb, publicHost, iceServers, federationEnabled, downloads}` — `downloads` is `{clientDesktop, clientAndroid, website}` (https:// links from `data/config.json`, `""` when invalid) — public, unauthenticated; `iceServers` lists only
  entries without credentials. Used to
  size client-side upload validation and detect federation support. `maxUploadMb` here is the
  `config.json` hard cap; a lower admin-panel limit is enforced server-side on upload (400 with
  an error message).

## WebSocket protocol (`wss://host:port/ws`)

One connection per client, authenticated by the same session cookie used for HTTP. The server
sends a `pong` reply to `ping` and otherwise pushes events as things happen — there's no
request/response pattern beyond `ping`/`pong` and the voice signaling messages below.

### Client → server

| Message | Notes |
|---|---|
| `{"type":"ping"}` | Server replies `{"type":"pong"}`. Client pings every 25s to keep the connection alive. |
| `{"type":"typing","scopeType":"channel"\|"dm","scopeId":<id>}` | Broadcast to others in that scope; server checks the sender can actually view/send there first. |

### Voice / stage protocol (over WS)

| Message | Notes |
|---|---|
| `{"type":"voice_join","channelId"\|"dmChannelId":<id>}` | Joins a voice room (server channel must be type `voice`/`stage`, or a DM — sender needs `VIEW_CHANNEL` for a server channel, or DM membership). Triggers a `voice_state` broadcast to everyone who can see the room (not just participants, for server channels — but a DM/group call broadcast only reaches that DM's own members, never leaking to a shared server's member list). A DM `voice_join` also notifies the other DM members with `voice_ring`. |
| `{"type":"voice_leave","channelId"\|"dmChannelId":<id>}` | Leaves; triggers `voice_state`. |
| `{"type":"voice_signal","channelId"\|"dmChannelId":<id>,"toUserId":<id>,"signal":{...}}` | Relayed 1:1 to `toUserId` as `voice_signal` (WebRTC SDP offer/answer/ICE candidate) — dropped silently unless both sender and target are currently registered participants of that room. |
| `{"type":"stage_raise_hand","channelId":<id>}` | Audience member signals they want to speak. |
| `{"type":"stage_invite_speaker","channelId":<id>,"userId":<id>}` | A speaker/moderator promotes an audience member to speaker. |
| `{"type":"stage_move_to_audience","channelId":<id>,"userId":<id>}` | Demotes a speaker back to audience. |
| `{"type":"voice_soundboard_play","channelId":<id>,"soundId":<id>}` | Plays a server soundboard clip for everyone in the room. |
| `{"type":"voice_force_mute"\|"voice_force_unmute","channelId":<id>,"userId":<id>}` | "Mute for Everyone". Server voice/stage channels only (never DMs); needs `MODERATE_MEMBERS` and the target must be in the room. Re-broadcasts `voice_state` with `mutedByMod` set for the target, whose own client then stops sending and disables its unmute control. Cleared when the room empties. |

### Server → client (push; all authorization-filtered server-side, client just renders what it gets)

| Event | Payload | Notes |
|---|---|---|
| `presence` | `{user}` | Status/profile changed — reaches friends + shared-server members only. |
| `message_create` / `message_update` | `{message}` | |
| `message_delete` | `{messageId, scopeType, scopeId}` | |
| `channel_create` / `channel_update` | `{channel}` | Permission-filtered per recipient (a private channel's events never reach someone who can't view it). |
| `channel_delete` | `{channelId, serverId}` | |
| `category_create` / `category_update` / `category_delete` | `{category}` / `{categoryId, serverId}` | |
| `role_create` / `role_update` | `{role}` | |
| `role_delete` | `{roleId, serverId}` | |
| `member_join` / `member_leave` / `member_kick` / `member_ban` / `member_role_update` | `{userId, serverId, ...}` | |
| `server_update` / `server_delete` | `{server}` / `{serverId}` | |
| `welcome_channel_add` / `_update` / `_remove` | | |
| `emoji_add` / `emoji_remove`, `sticker_add` / `sticker_remove`, `sound_add` / `sound_remove` | | Server asset library changes. |
| `event_add` / `event_update` / `event_remove` / `event_rsvp_update` | `{event}` | Scheduled events. |
| `friend_request` / `friend_accept` | `{from}` / `{by}` (user) | |
| `friend_voice` | `{userId, channel}` | A friend joined/left a voice channel (activity feed). |
| `dm_create` | `{dm: {id, isGroup, name, members, lastMessage, readStates}}` | You were added to a new DM/group DM. |
| `dm_delete` | `{dmId}` | The group's creator deleted it. |
| `dm_read` | `{dmId, userId, messageId}` | A DM member's read pointer moved — powers the 1:1 "Seen" tag and the group-DM reader-avatar stack. |
| `thread_create` / `thread_update` | `{channelId, thread}` | |
| `thread_delete` | `{channelId, threadId}` | A thread was deleted. |
| `channel_invite_received` | `{server, channelId, channelName, invitedBy}` | |
| `server_invite_received` | `{server, invitedBy}` | Result of `invite-direct`. |
| `notify` | | Generic client-side notification trigger (desktop notification / toast). |
| `typing` | `{scopeType, scopeId, userId}` | Relayed as-is. |
| `voice_state` | `{channelId\|dmChannelId, participants}` | Full current roster of a voice/stage room, pushed on every join/leave/force-mute. For server channels each participant carries `mutedByMod`. |
| `stage_state` | `{channelId, speakers, audience, raisedHands}` | Stage-channel role roster. |
| `voice_signal` | `{channelId\|dmChannelId, fromUserId, signal}` | Relayed WebRTC signaling payload from another participant. |
| `voice_ring` | `{dmChannelId, fromUser}` | A private DM/group call just started. |
| `voice_soundboard_play` | `{channelId, soundId, playedBy}` | Relayed soundboard trigger. |
| `remote_channel_event` | `{peerId, serverId, channelId, message}` | A message was posted to a remote channel a local user is watching (federation only). |
| `peer_accept` / `peer_reject` / `peer_revoke` | `{peerId, status}` | Peer pairing status changed (federation admin UI). |

## E2EE envelope

Encrypted DM messages use an envelope format that wraps plaintext with a ratchet mechanism to 
prevent replay. The server **cannot** open these envelopes — it only validates syntactic correctness.

**Format** (JSON): `{v, chainIndex, nonce, ciphertext}`

- `v`: always `1` (protocol version)
- `chainIndex`: non-negative integer ≤ 2³¹−1, incremented per message sent (ratchet counter)
- `nonce`: base64 (unpadded), exactly 32 chars (24 raw bytes), unique per message
- `ciphertext`: base64 (standard), length ≥ 24 chars (16-byte Poly1305 tag minimum), matches pattern `/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/`

**Validation** (server-side): `isValidEnvelope()` in `server/lib/e2eeEnvelope.js` checks shape and type. The server stores the envelope JSON as-is in `messages.content` (never decrypts). Max envelope size: 32 KB.

**Plaintext payload** (inside the ciphertext): `{text, embed, files?}`. `files` is present only when the message has attachments: `[{id, key, name, type, size}]` where `id` is the blob id, `key` the base64 AES-256-GCM file key, and `name`/`type`/`size` the original file's metadata. Payloads without `files` are the original format, so older messages decrypt unchanged. The blob is `iv || AES-GCM(key, file, aad = "meshcrowd-dm-file|v1|<dmId>|<blobId>")` (see `web/js/e2ee/dmFiles.mjs`); a blob moved to another DM or attachment slot fails authentication.

**Client ratchet** (see `web/js/e2ee/ratchet.mjs`): a symmetric key per conversation, evolving via HKDF after each sent message. The chain index prevents reordering, and a unique nonce per message prevents ciphertext reuse even if the same plaintext is sent twice.

## Sites (PHP intranet)

Mounted at `/api/sites` (`server/routes/sites.js`) and `/site` (`server/routes/siteProxy.js`). All
JSON, session cookie auth. "Editor" means the Site owner or a user with `MANAGE_ANY_SERVER`.

| Method & path | Body / query | Notes |
|---|---|---|
| `POST /api/sites` | `{name, description?}` | Site staff only. Creates a public auto-join Site, adds every active user as a member, writes a starter `index.php`. `201 {server}`. |
| `GET /api/sites/runtime` | | Site staff only. PHP status `{ok, reason?, version?, detail?}`. |
| `GET /api/sites/:id` | | Members. `{server, canEdit, origins}`. |
| `PATCH /api/sites/:id` | `{name?, description?, origins?}` | Editors. `origins` is a list of `https://host[:port]` origins (no wildcard, path, or credentials), canonicalised and de-duplicated, at most 20. Pushes `server_update` to members. |
| `DELETE /api/sites/:id` | | Owner or `MANAGE_ANY_SERVER`. Stops the workers, removes the row and folder, pushes `server_delete`. |
| `GET /api/sites/:id/files` | | Editors. `{files, usage, limits}`. |
| `GET /api/sites/:id/files/content` | `?path=` | Editors. `{binary, content?, size, mtimeMs}`. |
| `PUT /api/sites/:id/files/content` | `?path=&mtime=&force=1`, `application/octet-stream` body | Editors. Atomic write. `409` when `mtime` is stale and `force` is not set; `413` over the limits (2 MB file, 200 files, 50 MB total). |
| `POST /api/sites/:id/files/mkdir` | `{path}` | Editors. |
| `POST /api/sites/:id/files/rename` | `{from, to}` | Editors. `409` if the target exists. |
| `DELETE /api/sites/:id/files` | `?path=` | Editors. |

Paths are validated per component (no dot-files, reserved Windows names, traversal, symlinks or
junctions) and answer `400` when invalid.

**`GET|POST /site/:id/*`** (mounted before the JSON body parser, rate limited to 1200/min per IP):

- `401` (signed out) and `403` (not a member) are plain text, so the iframe shows a message instead
  of a redirect or the app shell; `404` for an unknown Site, a missing folder, or an unsafe path.
  `/site/:id` and directories without a trailing slash redirect (302) to the slashed URL.
- Every response carries `X-Frame-Options: SAMEORIGIN` and a per-Site CSP (`frame-ancestors 'self'`,
  inline script and style allowed, external origins only from `site_csp_origins`).
- `.php` is proxied to one of the Site's `php -S` workers (auth cookie and `Authorization` are
  never forwarded; `Set-Cookie` from PHP is dropped; request bodies up to 1 MB). Everything else is
  served by Express.
- HTML and CSS are rewritten: root-absolute `href|src|action|poster` and `url(/...)` get the
  `/site/:id` prefix, a `Location: /x` redirect is prefixed (`//host` and absolute URLs are left
  alone), and `/site/:id/__site.js` is injected into every HTML page.
- `503` with `Retry-After` when PHP is unavailable or the Site is crash-looping; `502` when the
  worker does not answer.

## AI providers and bots

All JSON, session cookie auth. Provider routes need site `MANAGE_AI` (or `SITE_ADMINISTRATOR`).
API keys are never returned, only `hasKey`.

| Method & path | Body / query | Notes |
|---|---|---|
| `GET /api/admin/ai/providers` | | `{providers}` |
| `POST /api/admin/ai/providers` | `{name, kind, baseUrl, apiKey?, models?, timeoutS?, concurrency?, serverAdminUsable?, enabled?}` | `201 {provider}`; `409` duplicate name |
| `PATCH /api/admin/ai/providers/:id` | same fields, all optional | `apiKey` omitted keeps the key, `""` clears it |
| `DELETE /api/admin/ai/providers/:id` | | `409` while bots use it |
| `POST /api/admin/ai/providers/test` | `{providerId?, kind, baseUrl, apiKey?}` | `{ok, models?, latencyMs, error?}`; reuses the stored key when `providerId` is given and `apiKey` omitted |
| `GET /api/admin/ai/servers` | | chat servers `{id, name}` |
| `GET|POST /api/admin/ai/bots` | `POST`: `{serverId, displayName, providerId, model, persona?, mentionEnabled?, dmEnabled?, contextMessages?}` | any server |
| `PATCH|DELETE /api/admin/ai/bots/:botId` | | |
| `POST /api/admin/ai/bots/:botId/avatar` | multipart `avatar` | png/jpg/gif/webp, 5 MB |
| `GET /api/servers/:id/ai/providers` | | providers offered to server admins: `{id, name, kind, models}` |
| `GET|POST /api/servers/:id/bots` | as above without `serverId` | `MANAGE_BOTS`, or staff `MANAGE_ANY_SERVER` |
| `PATCH|DELETE /api/servers/:id/bots/:botId` | | the bot must belong to this server |
| `POST /api/servers/:id/bots/:botId/avatar` | multipart `avatar` | |

`POST /api/dms` with a bot: `404` when the caller shares no server with it, `403 this bot does not
accept direct messages` when DM mode is off. `POST /api/dms/group` refuses bots with `400`.

## Bot API and outgoing webhooks

A bot (see AI bots) can also be driven from outside: a **token** lets a tool read and post as the
bot, and an **outgoing webhook** pushes signed events to a URL (n8n, a script, any HTTP endpoint).
One bot may do both jobs, and AI is optional: a bot with no provider only reacts through these two.
Both are set up in the bot's editor (Server Settings > Bots or Admin Panel > AI); the token and the
signing secret are shown once and only their hash / encrypted form is stored.

**Bot API** (`Authorization: Bot <token>`, no cookie). A bot sees only its own server, only what its
roles allow, never Notes channels and never encrypted or group DMs. Limits: 120 requests/min and
30 writes/min per bot (`429` with `Retry-After`). `@everyone` and `@here` in bot messages are
defused.

| Method & path | Body / query | Notes |
|---|---|---|
| `GET /api/bot/me` | | `{bot: {id, userId, username, displayName, serverId, serverName, hasAi, dmEnabled, webhook}}` |
| `GET /api/bot/channels` | | channels the bot can view |
| `GET /api/bot/messages` | `scopeType` (`channel`, `thread`, `dm`), `scopeId`, `before?`, `limit?` (1-100) | oldest-first page |
| `POST /api/bot/messages` | `{scopeType, scopeId, content, replyToMessageId?}` | `201 {message}`; content up to 4000 characters; a DM needs the bot's DM mode on |
| `PATCH /api/bot/messages/:id` | `{content}` | only the bot's own messages |
| `DELETE /api/bot/messages/:id` | | only the bot's own messages |

Management (same permissions as the bot itself: `MANAGE_BOTS`, or site `MANAGE_AI` / `MANAGE_ANY_SERVER`):

| Method & path | Notes |
|---|---|
| `POST|DELETE /api/servers/:id/bots/:botId/token` (admin: `/api/admin/ai/bots/:botId/token`) | issue or regenerate (`201 {token, bot}`, old token stops working) or revoke |
| `POST /api/servers/:id/bots/:botId/webhook/secret` | create or rotate the signing secret (`201 {secret, bot}`) |
| `POST /api/servers/:id/bots/:botId/webhook/test` | one un-retried `ping` event, `{ok, status, error}` |
| `PATCH /api/servers/:id/bots/:botId` | also takes `webhookUrl`, `webhookScope` (`mention` or `all`), `webhookEnabled`; `providerId: null` removes the AI |

**Webhook delivery.** `POST` with a JSON body, headers `X-MeshCrowd-Event` (`message_create` or `ping`),
`X-MeshCrowd-Delivery` (unique id), `X-MeshCrowd-Timestamp` (unix seconds) and
`X-MeshCrowd-Signature: sha256=<hex>`, the HMAC-SHA256 of `"<timestamp>.<raw body>"` keyed with the
signing secret. Reject deliveries whose timestamp is more than a few minutes old.

```js
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
```

```json
{ "type": "message_create", "trigger": "mention",
  "bot": { "id": 4, "userId": 12, "username": "relay_bot" },
  "server": { "id": 2, "name": "Hooks" }, "channel": { "id": 7, "name": "general", "type": "public" },
  "threadId": null, "dmId": null,
  "message": { "id": 91, "content": "@relay_bot summarise this", "createdAt": "2026-10-17T11:41:02.000Z",
               "author": { "id": 3, "username": "anna", "displayName": "Anna", "isBot": false },
               "replyToMessageId": null, "attachments": [] } }
```

`trigger` is `mention` (an @mention of the bot or a reply to one of its messages), `dm` (a 1:1 DM with
the bot, DM mode on) or `message` (scope `all`: every message in channels the bot can view). Messages
written by bots never trigger a delivery, and Notes channels, group and encrypted DMs are never sent.
Events for one bot are delivered in order; a 5xx, 429, 408 or network error is retried (3 attempts in
total, about 0 s / 5 s / 30 s), other 4xx answers are not; at most 50 events wait per bot. The URL may
carry a path and query but no credentials, redirects are not followed, and a private address
(localhost, LAN) is allowed only when a site admin saved the URL.

**n8n recipe**: add a *Webhook* trigger node (POST) and paste its production URL into the bot; verify
the signature in a Code node if you want to; answer with an *HTTP Request* node: `POST
https://your-host/api/bot/messages`, header `Authorization: Bot <token>`, JSON body `{"scopeType":
"channel", "scopeId": {{ $json.body.channel.id }}, "content": "...", "replyToMessageId":
{{ $json.body.message.id }}}` (for a thread use `scopeType: "thread"` with `scopeId` = the event's `threadId`, for a DM
`scopeType: "dm"` with `scopeId` = its `dmId`).

## Server invites and vanity links

Extra server-wide invite links (the permanent `servers.invite_code` keeps working). Session auth; the
caller must be a member with `CREATE_INVITE` or `MANAGE_SERVER`.

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/servers/:id/invites` | | `{invites, vanityCode, canManage}`: your own invites, or all of them with `MANAGE_SERVER` |
| `POST /api/servers/:id/invites` | `{maxUses?, expiresInSeconds?}` | `201 {invite}`; `maxUses` 1-1000, lifetime 60 s to 90 days, both optional (unlimited / never); at most 25 active per member and 100 per server |
| `DELETE /api/servers/:id/invites/:inviteId` | | the creator or `MANAGE_SERVER` |
| `PUT /api/servers/:id/invites/vanity` | `{code}` or `{code: null}` | `MANAGE_SERVER`; 3-32 chars of `a-z 0-9 -`, case-folded, reserved and taken names refused (`400`/`409`) |

`POST /api/servers/join` accepts any of the permanent code, the vanity name (case-insensitive) or one of
these invites. An expired or used-up invite answers `410`. A use is counted only when a new member
actually joins, and the update is guarded so concurrent joins cannot exceed `maxUses`. Audit actions:
`invite_create`, `invite_revoke`, `vanity_set`.

## AutoMod

Per-server rules checked before a message is stored. Session auth, `MANAGE_SERVER`.

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/servers/:id/automod` | | `{rules, log}` (the 50 latest hits) |
| `GET /api/servers/:id/automod/log` | `before?`, `limit?` (1-200) | older hits |
| `POST /api/servers/:id/automod/rules` | `{name, kind, config, action?, timeoutMinutes?, exemptRoles?, exemptChannels?}` | `201 {rule}`; at most 25 rules |
| `PATCH /api/servers/:id/automod/rules/:ruleId` | any of the above except `kind`, plus `enabled` | |
| `DELETE /api/servers/:id/automod/rules/:ruleId` | | |

`kind` and `config`: `keywords` `{words[] (max 200, \`*\` wildcard), wholeWord}`, `links`
`{mode: block_all|allowlist|blocklist, domains[]}`, `mentions` `{max}` (people and roles count one each,
@everyone and @here always exceed it), `spam` `{maxMessages, windowSeconds, duplicates}`, `caps`
`{minLetters, maxPercent}`. `action` is `block` or `timeout` (block and time the author out for
`timeoutMinutes`, 1-40320).

A message that hits a rule is refused with `403 {error: "Your message was blocked by AutoMod (<rule>).",
automod: true}` on channel and thread posts and on edits, and is never stored. The server owner and
anyone with Manage Messages (or Administrator) in the channel are never filtered; a rule can also
exempt roles and channels. Edits are checked but do not count toward the flood and duplicate limits.
Hits are logged per server (the latest 500 are kept). Audit actions: `automod_rule_create`,
`automod_rule_update`, `automod_rule_delete`.

## Onboarding (membership screening)

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/servers/:id/onboarding` | | any member: `{enabled, pending, canManage}` plus `rules` and `questions` (without role wiring) when screening is on; with Manage Server a full `config` |
| `PUT /api/servers/:id/onboarding` | `{enabled, rules, questions: [{title, multi, options: [{label, roleId?}]}]}` | `MANAGE_SERVER`. Rules up to 4000 characters (required to enable), up to 5 questions with 1-10 options each. A `roleId` must be a non-default role of this server with no moderation or management power (`400` otherwise) |
| `POST /api/servers/:id/onboarding/accept` | `{answers: {<questionId>: [<optionId>]}}` | the member accepts; the chosen options' roles are granted (re-checked against the power mask); single-choice questions take one answer; `{ok, roleIds}`. Harmless when not pending |

`GET /api/servers/:id` carries `onboarding: {rules, questions}` only while the caller is pending, else
`null`. A **pending** member is one who joined while `servers.screening_enabled = 1` and has no
`server_members.screened_at`. Their effective permissions are `VIEW_CHANNEL` only in every channel (overrides
cannot add more), they cannot join voice, and owners and bots are never pending. Turning screening on stamps
all existing members as screened. Audit action: `onboarding_update`.

## Reaction roles

Session auth, `MANAGE_ROLES`.

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/servers/:id/reaction-roles` | | `{reactionRoles: [{id, channelId, channelName, messageId, messagePreview, emoji, roleId, roleName, exclusive}]}` |
| `POST /api/servers/:id/reaction-roles` | `{channelId, messageId, emoji, roleId, exclusive?}` | `201 {reactionRole}`; the message must be a channel message of this server; one role per emoji and message; at most 20 per message and 100 per server; the role must not be the default role and must carry no moderation or management power (`400`); the emoji is also placed on the message |
| `DELETE /api/servers/:id/reaction-roles/:id` | | members keep roles they already have |

`PUT /api/messages/:id/reactions/:emoji` now grants the mapped role and `DELETE` removes it again (the
emoji string must match exactly). With `exclusive`, choosing one emoji of the message removes the
member's roles and reactions for the message's other emoji. Pending members (see Onboarding) get `403`
when reacting, and the power check is repeated at grant time. Audit actions: `reaction_role_create`,
`reaction_role_delete`.

## Scheduled messages

Messages written now and sent later, as the signed-in user. Session auth.

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/scheduled` | | your scheduled messages, soonest first: `{id, scopeType, scopeId, where, content, replyToMessageId, sendAt, status (pending|failed), error}` |
| `POST /api/scheduled` | `{scopeType: channel|thread|dm, scopeId, content, sendAt, replyToMessageId?}` | `201 {scheduled}`; `sendAt` between one minute and one year ahead; at most 50 waiting per user; not for Notes channels, forum top level, end-to-end encrypted DMs or DMs with contacts on another instance |
| `PATCH /api/scheduled/:id` | `{content?, sendAt?}` | only while pending |
| `DELETE /api/scheduled/:id` | | cancels a pending one or dismisses a failed one |

A worker checks every 10 seconds. At send time the message is posted through the normal path as its
author after **checking again**: membership and permissions, timeouts, pending-member status and AutoMod. A
refused message is kept as `failed` with the reason for 7 days. A message that has been overdue for more
than 7 days (the server was off) is not sent, and one that was mid-send when the process stopped is retried
on the next start.

## Voice messages

A voice message is an ordinary message with one audio attachment and the clip length. Send it with the
normal multipart message endpoints (channel, thread and unencrypted DM): field `files` = the recording
(`audio/webm`, `audio/ogg`, `audio/mp4`, mpeg, wav or aac, up to 8 MB) and field
`voiceDurationMs` = its length in milliseconds (500 to 300000). Exactly one file is required when
`voiceDurationMs` is present, otherwise the upload is refused with `400` and the file is deleted again. The
stored attachment carries `voiceMs` (`null` for every other file) and a codec-free `mimeType`. Text may be
sent along. Voice messages are not available in end-to-end encrypted DMs.

## Server templates

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/servers/:id/templates` | | `MANAGE_SERVER`: `{templates: [{id, code, name, description, uses, createdAt, updatedAt, summary: {roles, categories, channels: [{name, type}]}}]}` |
| `POST /api/servers/:id/templates` | `{name, description?}` | `201 {template}`, a snapshot of the server now; at most 5 per server |
| `POST /api/servers/:id/templates/:templateId/sync` | | refreshes the snapshot from the server |
| `DELETE /api/servers/:id/templates/:templateId` | | the code stops working |
| `GET /api/templates/:code` | | any signed-in user holding the code: the same shape without `code` |
| `POST /api/templates/:code/use` | `{name?, description?}` | `201 {server}`: a new private server owned by the caller |

A snapshot holds the rules text, the `@everyone` permissions, roles (name, colour, permission bits, position),
categories, channels (name, type, topic, position, category, slowmode, voice quality) and each channel's
per-role overrides. Notes channels are skipped, and members, messages, emoji, stickers, sounds, bots, invites
and onboarding questions are never copied. The snapshot is validated again on every use (unknown channel types,
bad references, oversized lists and out-of-range numbers are refused, permission bits are masked to the known
ones, nothing is half-applied). A template survives its source server being deleted. Audit actions:
`template_create`, `template_sync`, `template_delete`.

## Server insights

`GET /api/servers/:id/insights?days=7|14|30|90` (default 30; `MANAGE_SERVER`) returns `{insights}`:
`members` (`total` without bots, `online`, `joinedLast7`, `joinedInRange`, `joinedByDay`), `messages` (`total`,
`byDay`, `byHour` = 24 values, all UTC and zero-filled), `activeMembers` (`last7`, `inRange`), `topChannels` and
`topMembers` (8 each). Only plain, unencrypted channel and thread messages by people are counted (no DMs, bots,
webhooks or system events). Results are cached for a minute per server and range.

## Push endpoints (UnifiedPush)

Session auth. The Android app registers the address its UnifiedPush distributor (for example ntfy) gave it.

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/push` | | your endpoints: `{endpoints: [{id, endpoint, label, failures, lastOkAt, createdAt}]}` |
| `PUT /api/push/endpoint` | `{endpoint, label?}` | registers or refreshes (resets the failure count); http(s) URL without credentials, at most 5 per account |
| `DELETE /api/push/endpoint` | `{endpoint}` | `{ok, removed}` |

Whenever a notification is recorded for a user, the server POSTs the fixed body `{"t":"wake"}` to each of their
endpoints (bursts are merged into one wake-up per 5 seconds). It never carries message content: the app wakes
up and fetches `/api/notifications/poll` with its own session. An endpoint that answers 404 or 410 is removed
at once, and one that fails 5 times in a row is dropped. Addresses on private networks are refused unless
`pushAllowPrivateEndpoints` is `true` in `config.json` (needed for a ntfy on your LAN).

## Slash commands for bots

A bot with a working webhook can publish slash commands. Members see them in the composer's `/` list next to
the built-in ones, in server channels (not in threads or DMs).

Bot side (`Authorization: Bot <token>`):

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/bot/commands` | | the bot's current commands |
| `PUT /api/bot/commands` | `{commands: [{name, description?, options?: [{name, description?, type?, required?}]}]}` | replaces the whole list; at most 25 commands with 10 options each; names are `a-z 0-9 _ -`, up to 32 characters; `type` is `string` (default), `integer` or `boolean`; required options come first |
| `POST /api/bot/interactions/:id/respond` | `{content, ephemeral?}` | answers one use of a command; `201 {message}`, or `201 {ephemeral: true, id}` when `ephemeral` is true |

An interaction id is valid for 15 minutes and takes at most 5 answers. A normal answer is posted as the bot and carries
`interaction: {command, user}` so clients show "X used /command". An **ephemeral** answer is sent only to the member who ran
the command over their websocket (`{type: "ephemeral_message", message: {id, scopeType, scopeId, content, command, bot, createdAt}}`)
and is never stored: it is gone after a reload or once dismissed.

Member side (session auth, server member):

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/servers/:id/commands` | | `{commands: [{botId, botUserId, botName, botUsername, name, description, options}]}`, only bots with an enabled webhook |
| `POST /api/servers/:id/commands/invoke` | `{channelId, botId, command, options?}` | needs permission to send in that channel; options are checked and converted by type; `202 {interactionId, expiresAt}`; 10 uses per 10 seconds |

The bot's webhook receives an event with `type: "command"` (header `X-MeshCrowd-Event: command`, same signature as other events):

```json
{
  "type": "command",
  "bot": {"id": 3, "userId": 41, "username": "cmdbot"},
  "server": {"id": 1, "name": "S5"},
  "channel": {"id": 7, "name": "general", "type": "public"},
  "user": {"id": 5, "username": "mem", "displayName": "Mem"},
  "command": "roll",
  "options": {"sides": 20, "note": "boss fight"},
  "interaction": {"id": "9f2c...", "expiresAt": "2026-10-19T12:00:00.000Z"}
}
```

## Age-restricted channels

`POST /api/servers/:id/channels` and `PATCH /api/servers/:id/channels/:channelId` accept `nsfw` (boolean; not for voice, stage or
Notes channels). The channel object carries `nsfw` (0 or 1). Until an account has confirmed once, reading or posting in such a
channel answers `403 {error, code: "nsfw"}`, and its messages are left out of search. `POST /api/users/me/age-confirmation`
records the confirmation on the account (`{ok: true}`). It is a click-through: nothing is verified. Bot accounts are exempt.

## Verification level

`PATCH /api/servers/:id` accepts `verificationLevel` (Manage Server): `0` none, `1` account at least 5 minutes old, `2` also a
member for 10 minutes, `3` account at least 7 days old and a member for 10 minutes. Posting while short of the level answers
`403 {error, code: "verification", retryAfterMs}`. The owner, bots and anyone holding a role other than @everyone are exempt.
The server object carries `verification_level`.

## Role icons

`PATCH /api/servers/:id/roles/:roleId` accepts `iconEmoji` (a single emoji, or `""` to clear). `POST /api/servers/:id/roles/:roleId/icon`
(multipart field `icon`, PNG/JPEG/GIF/WebP up to 5 MB) sets an image, and `DELETE` on the same path clears either kind. An image
replaces the emoji and the other way round. Role objects carry `icon_emoji` and `icon_path`; @everyone cannot have an icon. Clients
show the icon of a member's highest-position role that has one next to their name.

# Feature Guide

A walkthrough of everything MeshCrowd does, organized by area. Each section links back to the
relevant code and, where useful, to [API.md](API.md) for the wire-level detail.

## Accounts & authentication

- Register with username/email/password (username: 3-32 chars, letters/digits/`_`/`.`; password:
  8+ chars). **The very first account ever registered on a fresh instance becomes the Owner** —
  full site-admin permissions, automatically.
- TOTP-based two-factor authentication: scan a QR code (or enter the secret) into any
  authenticator app, confirm a code to enable, get 8 single-use recovery codes shown once.
  Implemented directly on `node:crypto` (`server/lib/totp.js`) — no third-party auth library.
- Sessions are opaque server-side tokens in an httpOnly cookie, individually revocable (e.g. by an
  admin disabling an account). Session lifetime is configurable site-wide from the admin panel
  (`sessionTtlDays`, 1 to indefinite).
- Per-account privacy controls: who can DM you (`everyone`/`friends`/`none`), who can view your
  profile (`everyone`/`friends`), and whether you show up in the user-search directory at all
  (`discoverable`, default on — opt out any time).

## Passport (portable identity)

- Every account has a **Passport**: a key pair derived from a random 32-byte seed generated in the
  browser. Its public ID (`mc1...`, shown short as `mc1-abcd-efgh-ijkl-mnop`) identifies you; the
  seed never leaves your devices unencrypted. The server stores only the public keys and a copy of
  the seed wrapped with a key derived from your login password (see **Strengthened sign-in** below
  for who can read that copy).
- **Strengthened sign-in** (all new web accounts): your browser turns the password into two keys.
  One is sent to the server as the sign-in secret, the other never leaves the browser and wraps the
  seed backup. The server never sees the password of such an account, so a log or database leak
  does not hand over the password or the seed. The password still has to be strong: whoever holds
  the sign-in key can try guesses offline. The page you load is trusted code: a server operator
  who deliberately serves modified JavaScript could still capture a password, so only use servers
  you trust. Android apps older than 3.0 cannot sign in to a strengthened account until it is updated.
- **Strengthen sign-in for older accounts**: accounts made by the Android app (or before this
  feature) keep the old password sign-in. Settings -> Passport -> "Strengthen sign-in" (for accounts
  whose Passport key is on this device) asks for the current password and a **new** password
  (typed twice, plus an authenticator code if 2FA is on), warns about the Android app, then
  switches the account and signs your other devices out. The new password must differ from the
  old one, because the server saw the old one at earlier sign-ins.
- **Restore from file** (Settings -> Passport, shown when this device has no Passport key): pick the
  `.mcpass` file and its passphrase, and optionally your current password to rewrite the server
  backup. This is the way back after an admin reset your password, which makes the server backup
  unreadable by design.
- Registering creates a Passport automatically. Accounts made by the Android app get one the next
  time they log in on the web client. An account with 2FA creates its Passport from
  Settings -> Passport -> "Create Passport" (password plus authenticator code).
- **Export**: Settings -> Passport -> "Export file" saves a `.mcpass` file encrypted with a passphrase
  of at least 12 characters (Argon2id MODERATE). Keep it safe: it is your recovery path and your
  key to other servers.
- **Sign in with a file**: login screen -> "Sign in with a Passport file" (file plus passphrase).
  A 2FA account then gets the usual code prompt.
- **Forgot password**: login screen -> "Forgot password?" - choose the file and a new password.
  This sets a new strengthened-sign-in password (an older account is converted; the screen warns
  about the Android app), re-wraps the seed backup, and signs every other session out.
- **Use an existing Passport on another server**: Register -> "Use an existing Passport". The new
  account gets the same Passport ID. **One account per Passport per server**: a second attempt is
  refused with a message naming the existing account.
- **Change password** (Settings -> Passport) re-wraps the seed backup with the new password. An
  admin password reset cannot do that (the server never has the seed), so the admin panel warns
  that the user must recover with the Passport file afterwards. For a strengthened account the admin
  panel derives the key in the admin's browser (it says so), so the server still never sees that
  password; the user then signs in, sees the restore section, and restores from the file.
- Proofs are signed for the origin the browser used, so a proof for one server is useless on another.
  Servers behind a domain or LAN address need `publicHost` / `passportOrigins`, and behind a reverse
  proxy `trustProxy` (see the README Configuration table).
- Repeated failed proofs for one Passport ID lock that ID for 15 minutes.
## Federation

Servers can pair with peer instances to relay DM messages/edits/deletes/reactions and allow
users to join public remote servers and see live chat. **Federation is off by default**
(`federation.enabled`: false in `config.json`). A stand-alone server opens no federation route
or worker; Passport sign-in works regardless of the flag.

**Peer pairing state machine**: instances exchange cryptographic keys and complete a handshake.
- Pairing states: `pending` (awaiting the peer's response), `active` (handshake complete, live),
  `revoked` (deliberately disabled by either side).
- Direction: `inbound` (peer initiated the request) or `outbound` (we initiated).
- Operations: `accept` / `reject` (during `pending`), `revoke` (at any time). Events broadcast
  over WS as `peer_accept` / `peer_reject` / `peer_revoke`.
- Separate **Federation admin session** and credential (not site admin): decouples DM relay
  permissions from the instance owner.

**Remote servers**: a user can join a public server hosted on a paired peer, and participate in
text channels live. Content is proxied from the peer (no local copies), and federation relays
all channel messages. Only **text channels** (not voice, stage, forum, or notes) are exposed to
remote members. Site staff cannot read remote content — it stays on the originating server.

**Live relay**: DM messages, edits, deletes, and reactions replicate to all peers where a
participant is a member (never a local-only path). Channel messages post to all remote peers'
channels as events. Outbox housekeeping and a live-event retry limit (per-peer, per-event)
prevent infinite loops.

**SSRF/peer-trust hardening**: federation endpoints pin DNS at connect time (re-resolving
on retry), use `safeFetch` (HTTPS only, no redirects), and verify each peer's certificate
fingerprint. DM attachments are size-capped for federated conversations. Remote user records
cache Passport IDs and signatures for offline verification.

## Profile & presence

- Avatar, banner image, profile-card background, bio, display name.
- Presence states: **online**, **idle**, **dnd** (do not disturb), **invisible**. `invisible`
  shows as fully offline to everyone but yourself — your actual connection state never changes,
  only what others see (`server/lib/publicUser.js`).
- Custom status: an emoji + short text, settable from the quick status menu (click your own
  avatar in the bottom-left bar) or from full Settings.
- Notification-sound rules follow your presence by default — **online/idle** chime,
  **dnd/invisible** stay silent — with a personal override (`notifySoundMode`:
  `auto`/`always`/`never`) if you want different behavior (`web/js/state.js`
  `shouldPlayNotifySound`).
- Member lists group online members by their highest colored role, with a separate "Offline"
  group at the bottom — classic-style (`web/js/views/memberList.js`). A member's name is drawn in
  their per-member color override if a moderator set one, otherwise their highest colored role.

## Personalization: themes

Per-user only — never affects what anyone else sees. Set your own background/panel/text colors,
a font from a small whitelist (`server/lib/theme.js` `FONT_KEYS`), and an optional gradient
background, with:
- A validator that rejects anything that isn't a real `#rrggbb` hex, falling back to the app
  default rather than ever storing something that could render unreadably.
- Several premade presets (light, dark, classic, and a few colored variants) to start from.
- A shareable generated theme value other users can paste in to copy your look.
- Stored server-side per user (`users.theme`), fetched/set via `GET`/`PUT /api/users/me/theme`.
- Custom themes recolor buttons and form fields too, not just backgrounds and text.
- **Gradient backgrounds**: optional `gradFrom` and `gradTo` colors (both `#rrggbb` or empty) and
  `gradAngle` (0–360 degrees, default 135). The CSS variable `--bg-gradient` is set when both colors
  are present, and can be applied in the UI for a smooth directional gradient overlay.

## Layout

- The channel sidebar and the right-hand panel (member list / pinned / search / threads) each
  have a drag handle on their inner edge. Widths are clamped to 180-400px and saved per account
  (`users.ui_prefs`, `GET`/`PUT /api/users/me/ui-prefs`), so they follow you to other devices.
- **Start view**: `landingView` (`home` or `lastLocation`) in the same `ui_prefs` decides what the desktop UI shows at launch.
- **Unread line**: opening a channel or DM with unread messages draws a red divider (date + "New" badge) above the first message from someone else after your read pointer, and jumps there. The pointer is snapshotted at open, so the line stays while the chat is open and is gone after the next open. Four prefs in `ui_prefs` (Settings > Appearance, shared by desktop and phone UI): `unreadLine` (`on`/`off`), `unreadJump` (`firstUnread`/`bottom`), `unreadContext` (0-50 messages kept above the line) and `initialMessages` (20-100 loaded on open). Only the loaded page is searched, so with more unread messages than `initialMessages` the line sits at the top of the page. Threads have no read pointer and no line (`web/js/unreadLine.mjs`).
- The right-hand panel slot holds one thing at a time: member list, pinned messages, search, or
  the Threads list. Their header buttons toggle between them, and the member list has its own
  close (X) button.

## Servers, channels & organization

- Create a server (auto-provisions an `@everyone` role and a `#general` channel), or join one via
  invite code, or discover and join a public server directly.
- **8 channel types**: `public`/`private` text, `announcement` and `readonly` (mod-gated
  posting), `voice`, `stage` (voice with a Speaker/Audience split), `forum` (a channel whose
  content is entirely threaded posts, not a flat message log), and `notes` (per-member encrypted
  personal journal — see **Notes channels** below).
- Categories (folders) group channels in the sidebar, collapsible. Channels can be dragged
  between categories (or out of any category), and the categories themselves can be dragged to
  reorder them.
- Per-channel access: role-level overrides and per-user overrides (`allow`/`deny` bitflags) layer
  on top of a member's base role permissions — this is how a `private` channel becomes visible to
  only specific roles/people, and how a channel invite grants one person access without a role
  change.
- Channel icons, topics, slowmode (seconds between messages per user).
- Voice quality per voice/stage channel (Mobile 8 kHz/12 kbps, Low 16/24, Medium 24/48, High 48/96, HD 48 stereo/192), chosen at creation and fixed afterwards (delete and recreate to change); applied via Opus fmtp + sender max bitrate.
- A configurable welcome screen (per server) that highlights a few channels for new members.
- Server-rail folders: users can group their own joined servers into personal folders/order,
  stored per-user (`users.server_layout`) — doesn't affect anyone else's view.

## Roles & permissions

Two independent, fully-editable (not hardcoded) permission systems:

1. **Per-server roles** — bitflags (`VIEW_CHANNEL`, `SEND_MESSAGES`,
   `MANAGE_CHANNELS`, `KICK_MEMBERS`, `BAN_MEMBERS`, `MODERATE_MEMBERS`, `VIEW_AUDIT_LOG`,
   `ADMINISTRATOR`, `PRUNE_CONTENT`, and more — full list in
   [API.md](API.md#permission-bitflags)). Create/rename/recolor/reorder roles, assign to members,
   edit the permission grid via checkboxes. Members with `MANAGE_NICKNAMES` can also give an
   individual member a name color that overrides their role color (`server_members.name_color`).
2. **Site-wide staff ranks** — a separate bit set (`VIEW_ADMIN_PANEL`, `MANAGE_USERS`,
   `MANAGE_REPORTS`, `MANAGE_SITE_ROLES`, `MANAGE_ANY_SERVER`, `SITE_ADMINISTRATOR`,
   `DELETE_ANY_MESSAGE`, `PRUNE_DATA`) gating the in-site admin panel, independent of any
   server's own roles.

A hard rule enforced server-side in both systems: **you can never grant a permission bit you don't
already hold yourself** — closes a self-privilege-escalation path (e.g. a moderator granting
themselves `ADMINISTRATOR`).

## Messaging

- Text messages with Unicode emoji, up to 5 file attachments per message, edit, delete
  (hard-deleted — no "message deleted" placeholder clutter, and attachments are unlinked from
  disk), reply-quote, forward to another channel/DM/thread, pin (docked in a right-side panel,
  classic-style — not a floating popover — listing every pinned post with click-to-jump).
- Reactions: any Unicode emoji, including reacting to your own message.
- Polls: 2-10 options, single- or multi-select, embedded as a message.
- Custom server emoji and stickers (uploaded per-server, used like built-ins).
- A soundboard per server — short audio clips anyone can trigger, played live to everyone in a
  voice channel.
- `@mention` and `#channel` autocomplete while typing, same interaction pattern as slash commands.
- Slash-style commands in the composer (e.g. `/thread <name>` to spin a thread off the current
  conversation) — see the in-app `/help` command for the full list.
- Inline image/video attachment previews are size-capped (not full original resolution) with a
  click-through lightbox that has a working download button. File attachments download inside
  the app instead of opening the system browser.
- Each still image in the upload tray has a resize preset (Original / Large 1920px / Medium
  1280px / Small 800px), applied in the browser by canvas re-encoding just before sending. GIFs
  are never resized, since that would flatten the animation.
- Animated GIFs get a play/pause button. Pausing freezes the current frame; playing restarts the
  GIF from the beginning (an `<img>` can't resume mid-animation).
- Non-ASCII attachment file names (e.g. `café.png`, `日本語.pdf`) are preserved correctly.
- Upload limits: size is capped by the admin panel's runtime setting (never above
  `maxUploadMb` in `config.json`); executables/HTML/SVG are always blocked; admins can
  additionally restrict uploads to an extension allowlist (`server/lib/uploads.js`).
- A forwarded message shows where it came from; clicking the source jumps to the original.
- Pinned-message and search previews show polls and attachments, not just text.
- A visible Send button in the composer alongside Enter-to-send.
- A red "lost connection, reconnecting…" banner appears if the WebSocket drops; the composer
  disables, already-loaded messages stay visible, and everything clears/re-enables automatically
  on reconnect.

## Threads & forum channels

- **Create Thread** off any message in a normal channel spins up a side discussion, inheriting the
  parent channel's permissions (no separate thread-membership system).
- **Forum channels** are dedicated to threaded posts — "New Post" takes a title + opening message
  and creates a thread directly; there's no flat top-level message log in a forum channel.
- A **Threads** button in the channel (and thread) header opens a panel listing every thread in
  the channel — title, message count, last activity, archived state — newest activity first.
  Click one to open it (`web/js/views/threadsPanel.js`).
- Forum channels list posts as **cards**: author, a 200-character preview of the opening message, the first image as a thumbnail, reaction count and top emoji (`shapeThread` in `server/routes/threads.js`), plus search (title and preview), sort by recent activity or newest, and a **Closed** badge for archived posts that only moderators can write in. At 820 px and wider the chosen post opens in a split pane beside the list; narrower it opens full screen.
- **Thread delete** (`DELETE /api/servers/:id/channels/:channelId/threads/:threadId`) — thread creator or
  `MANAGE_CHANNELS` permission. Removes the thread, all its messages, and audit-logs the action. Broadcasts
  `thread_delete` over WebSocket to everyone who can view the parent channel.

## Search

- Search is docked in the right-hand panel (`web/js/views/search.js`), toggled from the header
  like pinned messages.
- Checkboxes choose what the query matches, OR'd together: **Text** (message content, the
  default), **Usernames** (author username or display name), **Channel Names** (every message in
  a channel/thread whose name matches — server search only), and **Attachments** (file names,
  which also covers searching by extension, e.g. `.pdf`). Sent as `?fields=` on the search APIs.
- Per-server search (Activity panel, or the channel search with a "search entire server" toggle)
  is scoped to the **current server only** — it never reaches into other servers you're a member
  of — and results show which channel each hit came from.
- DM search is scoped to that one DM/group DM.
- Text matching is SQLite FTS5, kept live-in-sync with every message insert/edit/delete via
  database triggers (`server/lib/search.js`).

## Friends & direct messages

- Friend request / accept / decline / remove / block, with a discoverable-by-search directory
  (opt-out per user) in addition to exact-username requests.
- 1:1 DMs and group DMs (up to 10 members); DM privacy (`everyone`/`friends`/`none`) and blocks
  are enforced on every send, not just at creation time.
- **End-to-end encrypted 1:1 DMs** (opt-in): both parties must be local users on the same instance
  (no federation). Once enabled (`POST /api/dms/:dmId/encryption/enable`), all future messages are
  encrypted with XChaCha20-Poly1305; client-side state tracks a message ratchet per conversation
  to prevent replay. Messages carry an E2EE envelope with a chain index, nonce, and ciphertext; the
  server never sees plaintext content. **Safety numbers and key pinning** prevent man-in-the-middle
  by detecting key changes, with a warning when a peer's key is first encountered or changes.
  What **cannot** be done in encrypted DMs: forwarding, replies quoted in the UI, edit notifications,
  link preview generation on the server (the client fetches previews separately), reactions, pins,
  reports with quoted plaintext (though a reporter can optionally supply decrypted evidence).
  Limitations: no ratchet persistence across device logout (new message keys every login), and
  encrypted DMs cannot include federated members.
- **Encrypted DM attachments**: up to 5 files per message, each up to the site upload limit. The
  client encrypts every file with its own random AES-256-GCM key (DM id and a random blob id bound
  in as AAD) and uploads only the ciphertext; the file name, type, size and key travel inside the
  ratchet-encrypted message, so the server sees an opaque blob of a given size and nothing else.
  The admin extension allowlist cannot apply here because the server never learns the name.
  Images (PNG, JPEG, GIF, WebP up to 16 MB) preview inline from a local `blob:` URL; everything
  else downloads and is decrypted on click, always handed to the browser as an opaque download.
  Blobs are stored under `data/attachments/e2ee/` (never served by the static `/uploads` route) and
  are deleted with their message, by DM prune (counted as attachments), and when the DM is wiped;
  uploads never attached to a message are swept at startup after a day.
- DM lifecycle: anyone can leave a DM. When the last member leaves, the conversation and its
  attachments are deleted for good. A group DM's **creator** can also delete the whole group for
  everyone, or prune its history before a date (see [Data pruning](#data-pruning)). A 1:1 DM has
  no creator role, so leaving is its only option.
- "Invite to Server" directly from a user's profile card — pick from servers you're in that they
  aren't, grants membership immediately (no code exchange).
- A user's profile card shows their presence/status, username, bio, mutual-server count, and — on
  a server — their rank there; a "..." menu offers full profile, invite-to-server, friend-request,
  ignore/block, and report.

## Voice, video & screen sharing

- **Server voice channels**: join/leave, live participant tiles, mute, per-participant volume
  slider, speaking indicator (a ring around the avatar plus a live volume strip under it),
  input-device picker (`navigator.mediaDevices.enumerateDevices`).
- **Mute for Everyone**: members with `MODERATE_MEMBERS` get this control on other people's
  tiles in server voice/stage channels. The target's client is told to stop sending audio and
  its own unmute button is disabled until a moderator lifts it; a badge marks the tile for
  everyone. With no media server, this works by instructing the target's client — the same way
  other chat apps' server-mute works. The mute is cleared when the room empties.
- **Fullscreen**: any camera or screen-share tile has a maximize button (native Fullscreen API,
  name label stays visible).
- **Stage channels**: the same voice room, but split into Speakers (can transmit audio) and
  Audience (muted until invited) — raise-hand, invite-to-speak, move-to-audience.
- **Camera** and **screen sharing** work in any voice/stage room and in DM calls; each is its own
  tile (your camera feed and your screen share render as two separate video tiles, matching how
  other chat apps shows them).
- **Private DM/group voice calls** — invite-only by construction (you must already be a DM
  member); a DM call **never** appears on the public member-list "in a call" indicator or anywhere
  outside that DM's own members, even to someone who shares a server with a call participant
  (verified both by code path and live cross-user testing — see `server/socket/index.js`
  `broadcastDmVoiceState`, which is scoped server-side to DM members only).
- A user actively in a **public** voice channel gets a small live/headphone indicator next to
  their name in the member list.
- Everything is a peer-to-peer **WebRTC mesh** — every participant connects directly to every
  other participant, signaled over the same WebSocket connection used for everything else. No
  media server. Opus audio codec comes from the browser/Electron's built-in WebRTC stack, not a
  separate dependency. Works out of the box on a LAN; for participants who can't reach each other
  directly (different networks/NAT), turn on the **built-in STUN/TURN server** (Admin Panel > Calls,
  or `setup-turn.bat` / `setup-turn.sh`, which also opens the firewall) or list external servers in
  `iceServers`. Off by default; only the call media ever uses it.

## Notifications

- Desktop notifications (browser `Notification` API on web; native notifications via Electron).
- Unread badges: per-channel (sidebar), per-server (server rail), and — in the Electron app — a
  **tray icon badge** colored by your presence with the unread count (capped display at "99+").
  The badge tracks channels you're a member of even while you're looking at something else
  entirely (not just the server currently open) — see `web/js/state.js` `noteChannelMessage`.
- Per-channel/DM notification overrides: mute entirely, mentions-only, or everything — default is
  mentions-only for channels, everything for DMs, overridable any time.
- Sound behavior follows presence + your personal override, as described under Profile & presence
  above.
- TLS handshake failures from scanners and bots are not logged by default; set `MESHCROWD_TLS_DEBUG=1` to log one line per failure (`server/index.js`).
- Every notification that would be pushed live is also stored in a per-user outbox (newest 200
  kept), so a client without an open WebSocket — the Android background checker — can catch up
  with `GET /api/notifications/poll?since=<id>` (`server/lib/notifications.js`).

## Scheduled events

Per-server events with a name, description, optional location and linked channel, start/end time,
and RSVP ("interested") tracking, broadcast live to the server as they're created/updated/RSVP'd.

## Notes channels

A per-member encrypted personal journal (channel type `notes`). Each member gets their own private
stream: the server stores only client-side encrypted ciphertext in the `note_entries` table
(nonce + XChaCha20-Poly1305 ciphertext), keyed per (channel, user). The key is derived from the
owner's Passport seed, so neither the database nor any admin can read the plaintext.

- **Quotas per member, per channel**: max 5,000 notes, max 1 GB of attached encrypted files.
- **Attachments**: encrypted blobs uploaded client-side (`note_files` table stores only sizes).
- **Admin trimming** (`POST /api/servers/:id/channels/:channelId/notes/trim`): requires
`PRUNE_CONTENT` or `MANAGE_CHANNELS`. Deletes notes older than a cutoff date without ever reading
them — returns only a count of deleted rows and audit-logs the action.
- **Deliberately excluded**: no FTS indexing (messages table is never used), no notifications,
pins, reactions, webhooks, forwarding, or prune-by-scope paths. Notes channels do not appear in
search, and messages/threads/polls cannot be posted into them.

Clients fetch notes with pagination (`GET` returns notes newest-first, supports `before`/`limit`).
Edit/delete/file management all work client-side only.

## Notes channels

A per-member encrypted personal journal (channel type `notes`). Each member gets their own private
stream: the server stores only client-side encrypted ciphertext in the `note_entries` table
(nonce + XChaCha20-Poly1305 ciphertext), keyed per (channel, user). The key is derived from the
owner's Passport seed, so neither the database nor any admin can read the plaintext.

- **Quotas per member, per channel**: max 5,000 notes, max 1 GB of attached encrypted files.
- **Attachments**: encrypted blobs uploaded client-side (`note_files` table stores only sizes).
- **Admin trimming** (`POST /api/servers/:id/channels/:channelId/notes/trim`): requires
  `PRUNE_CONTENT` or `MANAGE_CHANNELS`. Deletes notes older than a cutoff date without ever reading
  them — returns only a count of deleted rows and audit-logs the action.
- **Deliberately excluded**: no FTS indexing (messages table is never used), no notifications,
  pins, reactions, webhooks, forwarding, or prune-by-scope paths. Notes channels do not appear in
  search, and messages/threads/polls cannot be posted into them.

Clients fetch notes with pagination (`GET` returns notes newest-first, supports `before`/`limit`).
Edit/delete/file management all work client-side only.

## Webhooks

Per-channel incoming webhooks: generate a URL + token, have an external service (CI, a script, a
third-party integration) `POST {content}` to it, and the message appears in the channel attributed
to a reserved system account. No session/login involved — auth is the token in the URL.
Webhooks never post to notes channels, announcement/readonly channels, or threads/forums outside
their channel.
Webhooks never post to notes channels, announcement/readonly channels, or threads/forums outside
their channel.

## Moderation & reports

- Kick, ban/unban, timeout (temporarily blocks posting/reacting without removing the member) — all
  gated by the corresponding role permission.
- A full audit log per server (`VIEW_AUDIT_LOG`) records moderation and settings changes.
- Anyone can file a report against another user (reason + optional detail + optional linked
  message); site staff with `MANAGE_REPORTS` see an open-queue in the admin panel and can resolve
  or dismiss each one.

## Data pruning

Bulk-deletes message history older than a cutoff date, to free disk space or enforce a retention
policy (`server/lib/prune.js`). Three levels, each with its own permission:

| Who | Permission | Scope | Where |
|---|---|---|---|
| Server moderators | `PRUNE_CONTENT` (server role) | Chosen channels of their own server, plus those channels' threads | Server Settings |
| Site admins | `PRUNE_DATA` (site rank) | Any server's channels, or any DM/group DM | Admin panel |
| Group DM creator | (being the creator) | Their own group DM | Group DM menu |

How it works:
- **Preview first**: you see how many messages, attachments, and bytes would be removed.
- **Attachments**: if "delete attachments" is unchecked, messages that carry attachments are kept
  entirely; only attachment-free messages are removed. If checked, attachment files are deleted
  from disk too.
- **Timing**: *immediate*, or a *24-hour notice period* (stored in `pending_prunes`, run by a
  background worker that checks every minute).
- A system notice is always posted into each affected conversation, and server-level prunes are
  written to the audit log.
- The admin DM list is sorted by size and shows only member usernames — never message content.

## Admin panel

Visible only when `user.isSiteAdmin === true` (hidden entirely otherwise, not just disabled).
Requires the `VIEW_ADMIN_PANEL` site permission to open at all; individual sections require more
specific site permissions on top of that:

- **Stats** — instance-wide user/server/message counts.
- **Attachment settings** — the runtime upload size limit (can only go *below* `maxUploadMb` in
  `config.json`) and an optional file-extension allowlist. Stored in the database, no restart
  needed.
- **Data pruning** — instance-wide pruning, described above (`PRUNE_DATA`).
- **Users** — list, edit, disable/enable any account (disabling immediately revokes sessions and
  closes live connections), set another user's avatar.
- **Reports** — the moderation queue described above.
- **Site roles** — create/edit/assign staff ranks.
- **Servers** — list/delete any server on the instance, and manage any server's stickers/sounds
  regardless of your own membership (for content moderation without needing to join). Discover
  servers list shows server icons.
- **Settings** — site-wide session TTL (how long a login stays valid), 1 day to indefinite.
- **Federation** (when enabled) — see Passport & Federation sections below.

## Security Center (Admin Panel)

Admin Panel -> **Security Center** (site administrators). Everything runs on the server itself; no third-party captcha or reputation service is contacted.

- **Captcha** on sign-in and sign-up, drawn locally as a distorted picture (the answer is never in the response). When to show it: *never*, *after N failed attempts* from the same address within a window, or *always*. Kinds: random characters (digits, letters or both, 3-10 long, optionally without look-alikes 0/O/1/I), words from a built-in English and/or Hungarian dictionary or your own list (edited inline, 1-3 words, accents are folded), or a simple sum. Three distortion levels, adjustable lifetime, and a live preview that shows the answer. A captcha is single use: a wrong guess burns it.
- **Flood protection**: per-address request flood, repeated rate-limit violations (signed-out clients) and failed sign-ins each trigger a temporary automatic ban. Modes: protect, detect only, or off. A burst of automatic bans switches on **under attack mode**, which forces a captcha on every sign-in and sign-up (also switchable by hand).
- **IP bans**: single addresses, ranges (`a-b`) and CIDR networks, IPv4 and IPv6, permanent or timed, bulk import, search. Banned addresses get `403 Access denied` on HTTP and WebSocket. You cannot ban your own address.
- **Blocklists**: subscribe to public https lists (Spamhaus DROP, Tor exit nodes and FireHOL level 1 are one click) or any URL. Fetched with the same SSRF-hardened client federation uses, refreshed on a schedule, capped at 50,000 entries per list; a failed refresh keeps the previous copy.
- **Allowlist**: addresses that are never banned or limited (127.0.0.1 and ::1 by default). It beats every ban and blocklist.
- **Bot traps**: a hidden honeypot field and a minimum-fill-time check on the forms, plus a per-address sign-up cap.
- **IP check** shows what the server knows about an address, and the **event log** keeps the last 30 days of bans, captcha failures and detections.

Behind a reverse proxy set `trustProxy` in `config.json`, otherwise every visitor shares the proxy's address. API clients that sign in without the web UI must send `captchaId` and `captchaAnswer` (from `POST /api/auth/captcha`) whenever `GET /api/auth/captcha/status?kind=login` says `required`. Federation endpoints are not counted for flood detection but a banned address is still refused.

## TLS certificates

HTTPS is on by default (`server/lib/certs.js`):
- **Self-signed** (default): generated on first boot for `publicHost`, `localhost` and
  `127.0.0.1`, stored in `data/certs/`, valid 10 years.
- **Your own**: set `serverCrt` and `serverKey` in `data/config.json` to PEM files (absolute or
  relative to the project root; full-chain files supported). The pair is validated at startup —
  a missing file, bad PEM, mismatched key or weak key stops the server with a clear `[certs]`
  error. Files are read once, so restart after renewing.
- The leaf certificate's SHA-256 fingerprint is logged on every start, matching what the
  Electron/Android trust dialogs show.

## Clients: web, Electron and Android

The web client (`web/`) is the primary experience — plain HTML/CSS/JS, no build step, works in any
modern browser, nothing to install. The Electron client (`electron/`) loads the exact same UI
against a server URL you configure on first launch, and additionally provides:

- A system tray icon with a live presence-colored, unread-count badge. The base icon color and
  the badge color per presence state are customizable in **Settings → Desktop App → Tray Icon**
  (stored in the local `dismesh-client-config.json`, not on the server). Tray menu is translated
  into the user's selected language.
- Native desktop notifications, close-to-tray, start with Windows.
- Trust-on-first-use certificate pinning for self-signed servers, with a warning dialog if a
  previously-trusted server's certificate ever changes. Certificates from a publicly trusted CA
  are accepted without a prompt.
- The OS-native screen-picker for screen sharing.
- Window polish: lightbox image controls offset properly, tray destroyed on quit.

The Android client (`android/`) is a thin WebView shell around the phone UI served at `/m/` (see "Mobile
UI" below), so it needs no update when the server changes. It adds local notifications (WorkManager,
or an optional foreground service for faster polling; no Firebase), the system file picker, downloads
into the Downloads folder, a back button that follows the page, and trust-on-first-use certificate
pinning for self-signed servers. Voice and video are not in the phone UI yet.

Since 3.7/3.8: fast mode is on by default; its foreground notification is re-posted when swiped away (Android 14+); Android back moves the app to the background at the top level; chat bubble style and a start-view preference (both stored locally in the WebView).

Every other feature above works on all clients.

## Sites (PHP intranet)

A Site is a server kind (`servers.kind = 'site'`) that hosts a folder of PHP/static pages, shown in
the rail for every user. It has no channels, roles UI, invites, voice or notifications.

- **Create / edit**: creating needs site permission `MANAGE_ANY_SERVER` (or `SITE_ADMINISTRATOR`).
  Editing is the Site owner or `MANAGE_ANY_SERVER`. Deleting is the owner or `MANAGE_ANY_SERVER`.
  Creation back-fills every active user as a member and writes a starter `index.php`.
- **PHP runtime**: `npm run fetch:php` fetches portable PHP 8.4 plus the Visual C++ redistributable
  into `runtime/php/`; the server installs the redistributable on its own when PHP reports the
  missing DLL. Config keys `sites.phpPath` and `sites.maxWorkers` (parallel workers per Site,
  default 4, about 20-30 MB each).
- **Sandbox**: PHP binds to 127.0.0.1, runs with `open_basedir` set to the Site folder, a scrubbed
  environment, and `disable_functions` covering process, mail, `putenv`, `dl`, socket and symlink
  functions, plus `allow_url_fopen=0`. Known residual risk: a page can still read other files in its
  own Site folder.
- **Editor**: file tree with create / rename / delete / upload, tabbed code view with syntax
  colouring (PHP, HTML, JS, CSS), and a visual view with protected PHP chips. Saves are atomic and
  conflict-aware (409 with an Overwrite option). A persistent notice reminds editors that Site
  pages run as part of MeshCrowd.
- **Allowed external origins**: per-Site list of `https://` origins merged into the Site's CSP, with a
  warning dialog on adding one.
- **Navigation**: same-origin links and forms stay in the frame; off-origin links, `target=_blank`
  and `window.open` open in the OS browser (Electron) or a new tab (web).
- **Federation**: Sites are never offered to federation peers.
- **Audit log**: `site_create`, `site_delete`, `site_file_write`, `site_file_delete`,
  `site_origins_change`.

## AI bots

A bot is a real user row (`users.is_bot = 1`) tied to one server and to a site-wide AI provider. It
cannot log in, is hidden from search, friend requests, admin user lists and counts, and shows a BOT
badge in chat, the member list and its profile card.

- **Providers** (Admin Panel > AI, site permission `MANAGE_AI`): kind `ollama` or `openai`, base
  URL (private addresses allowed, because the site admin sets them), encrypted API key, model
  allowlist, timeout (5-600 s), concurrency (1-4), "available to server admins", enabled. A provider
  that bots use cannot be deleted.
- **Bots**: created by `MANAGE_AI` anywhere, or by a server's owner/admins with the server permission
  `MANAGE_BOTS` (site staff with `MANAGE_ANY_SERVER` may manage bots on any server). Server admins
  can only use providers flagged for them and see only their name, kind and models. Deleting a bot
  removes it from the server and keeps its old messages. Audit actions: `bot_create`, `bot_update`,
  `bot_delete`.
- **Mention mode**: an @mention of the bot (or a reply to one of its messages) in a channel or thread
  it can view.
- **DM mode**: every message in a 1:1 DM with the bot. DMs with a bot need a shared server and bots
  cannot join group DMs.
- **Replies** stream into one message that is edited about once a second; the asker is notified when
  it is done. Failures post one short "could not answer" line.
- **One bot, two jobs**: the AI provider is optional. A bot can also carry an **API token** (read and
  post as the bot through `/api/bot`, shown once, regenerate or revoke any time) and an **outgoing
  webhook** (HMAC-signed JSON events for mentions, replies and DMs, or every message in channels the
  bot can view, retried on failure, with a "Send test event" button). That is how n8n or a script
  plugs in; with no provider the bot is purely API/webhook driven. See the API docs for the payload,
  the signature check and an n8n recipe. A private webhook address (LAN, localhost) can only be set
  by a site admin.

## UnifiedPush notifications (Android)

Besides the periodic check and fast mode, the Android app can use **UnifiedPush**: You > Android app > Push
notifications. Install a UnifiedPush app such as ntfy (self-hosted or public), turn push on and pick the app.
The server then wakes the phone through the distributor whenever you get a notification, and the app fetches
the notifications itself; the message text never passes through the distributor, and no Google services are
needed. The periodic check keeps running as a safety net (set it to a long interval), and all three modes stay
selectable. If your ntfy runs on your own LAN, set `pushAllowPrivateEndpoints` to `true` in `config.json`.

## Noise suppression (RNNoise)

User Settings > Voice has **Advanced noise suppression (RNNoise)**. When on, the microphone passes through
RNNoise, a small neural network compiled to WebAssembly, before it is sent to the call, which removes keyboard,
fan and background noise. It runs entirely on the device (a ScriptProcessor on the main thread, 480-sample
frames at 48 kHz, about 10 ms extra delay), is off by default, and the ~5 MB module is only downloaded the
first time a call starts with it on. If it cannot start, the call continues without it. The module comes from the
`@shiguredo/rnnoise-wasm` package (Apache-2.0) and is served from `/vendor/rnnoise`.

## Insights

Server Settings > Insights (Manage Server): member count and growth, messages per day and per hour of day,
the busiest channels, the most active members and how many people were active this week, for the last 7, 14,
30 or 90 days. Everything is computed from the messages and memberships that already exist (nothing extra is
tracked), UTC days, refreshed about once a minute.

## Server templates

Server Settings > Templates (Manage Server): save the structure of the server (roles with their permissions,
categories, channels, channel permissions and the rules text) as a template and share the code. When
creating a server, anyone can paste a template code to start from it; they become the owner of a brand
new private server. Members, messages, emoji, bots and invites are never copied, and **Update** refreshes
a template after the server changed.

## Voice messages

The microphone button in the composer (desktop and phone UI) records a clip of up to five minutes: a red
bar shows the running time, the bin discards it and the send button posts it as a message with a small
player (play/pause, progress, seekable). It is recorded as Opus (WebM or Ogg; MP4 on Safari) in the
browser, Electron client or Android app, so it needs microphone permission and, like calls, HTTPS or
localhost. Plain audio attachments now play inline too. Not available in end-to-end encrypted DMs.

## Scheduled messages

The clock button in the desktop composer opens **Send later** for what you have typed: pick a time (or
a preset such as tomorrow 9:00) and the message is posted as you at that moment, with the same checks as
a message sent by hand (so it can still be refused, for example if you were timed out or AutoMod objects;
failures stay in your list with the reason). The same window lists everything you have scheduled and
lets you cancel. On the phone UI hold the send button. Encrypted DMs, Notes channels and DMs with contacts on
other instances cannot be scheduled.

## Reaction roles

Server Settings > Reaction roles (Manage Roles). Choose a channel and one of its recent messages, an
emoji and a role: members who react with that emoji get the role and lose it when they remove the
reaction. The emoji is placed on the message for you. Tick **Exclusive** to make the emojis of one
message behave like a single choice (picking one removes the others). Roles with moderation or
management powers cannot be used, and members who still have to accept the server rules cannot react.

## Onboarding (membership screening)

Server Settings > Onboarding (Manage Server). Write the server rules, optionally add up to five
questions whose answers hand out roles (for example game or region roles), and turn on **Require new
members to accept the rules**. Members who are already in are not affected. A new member sees a
welcome window (a bottom sheet on the phone UI) with the rules, the questions and an "I agree"
box; until they accept they can read what their roles show but cannot post, react, attach files or join
voice, and choosing **Later** keeps them in that view-only state. Roles with moderation or management
powers can never be handed out by a question.

## AutoMod

Server Settings > AutoMod (Manage Server). Rules are checked before a message is posted in a channel
or thread, and again when a message is edited: **blocked words** (whole-word or substring, `*`
wildcards), **links** (block all, allow only listed sites, or block listed sites; subdomains
included), **mass mentions**, **spam** (too many messages in a window, or the same message
repeated) and **too many capitals**. A hit refuses the message with the rule's name, logs it (author,
channel, first 200 characters) and, if the rule says so, times the author out. The owner and anyone who can
manage messages are never filtered, and each rule can exempt roles and channels. Bots and webhooks
are not filtered.

## Invites and vanity links

Server Settings > Invites (members with Create Invite; Manage Server sees everybody's). Create extra
invite links with an expiry (30 minutes to 30 days, or never) and a use limit (1 to 100, or none),
copy and revoke them. A use is counted only when somebody actually joins; people who are already in
are never charged, banned users are refused first. Expired links are swept hourly. The permanent
code in Overview is unchanged. Managers can also set a **vanity link**: a short name (3-32 letters,
digits, hyphens) that works like a code and never expires.

**Invite links.** Every code (permanent, vanity, extra invite, channel invite) also works as
`https://host:port/i/<code>`, a public landing page with the server name, icon and (public servers only) member
count, **Join in browser** (`/#invite=<code>`, a confirm step in the desktop and phone UI before joining), **Open in
app** (`mcr://host:port/<code>`) and the `downloads` links from `data/config.json`. Opening the page never uses an
invite. Copy-link buttons sit in the invite modal and Server Settings > Invites. The Electron client registers
`mcr://` on every start (Settings > Desktop App turns it off; `register-mcr-protocol.bat` does it by hand) and the
Android app (3.9) has an `mcr` intent filter; both ask before switching server and the page asks before joining.
`code@domain` federated codes get a generic page. `GET /api/invites/:code` and `GET /i/:code` are public and rate limited.

## Mobile UI (/m/)

Phone-first interface, picked automatically for Android browsers and the Android app (add `?ui=desktop` or `?ui=mobile` to switch).

- Bottom tabs: **Servers** (server rail + channels), **Messages** (DMs, new message/group, friends), **Notifications** (mentions, replies, DMs), **You** (status, profile, notification sound, language, open desktop version, log out).
- Chat for channels, threads and DMs: history paging, live updates, typing indicator, optimistic send with retry, attachments, reply (button or swipe), edit, delete, reactions, pin, forward, report, save, create thread, polls, stickers, link previews, jump-to-latest. Encrypted DMs decrypt and send text (attachments in encrypted DMs are desktop-only).
- Search with filters (from user, in channel, file, **mentions**, message text, whole server) and history.
- Conversation info: members, media, links, files, pins; mute.
- Voice and video: voice channels, stage channels (listen, raise hand) and DM/group calls, with mute, deafen, camera on/off and front/back flip. Screen share is not offered on phones. The call survives leaving its screen (green "In call" bar with mute/leave) and stays alive with the screen off through a microphone foreground service in the Android app. The mic and camera need a secure origin (HTTPS with a trusted or pinned certificate, or localhost). The Android app asks for the permissions when a call first needs them, routes audio through the communication mode, and has a Speaker/Earpiece toggle.
- Channel and thread custom icons show in the lists and the chat header. The composer's emoji button opens a full picker (categories, search, recents, custom emoji, `:shortcode:` suggestions), custom emoji reactions render as images, and the sticker picker has search.
- Forum channels list posts as cards with search, sort and previews; a post opens as a thread. The unread "New" line and its preferences work as on desktop; opening a chat jumps to the first unread message and marks it read once you reach the bottom.
- Opening the Admin Panel or Server Settings asks for your password first (`POST /api/auth/verify-password`, rate limited, locks out after repeated failures).
- **You** tab: start view (Messages or last opened view) and, in the Android app, message style (plain or bubbles).
- Notes channels, Sites, admin and server settings show an "Open desktop version" card.
- Works from 320 px wide phones to tablets, portrait and landscape, with the system font scale.

## Slash commands for bots

Bots that have a webhook can publish their own slash commands. Type `/` in a server channel and they appear in the list
beside the built-in ones, with their options (`/roll <sides:integer> [note]`). Options are filled in order, and the last text
option takes the rest of the line, so no quotes are needed. `name:value` also works. A command is sent to the bot's webhook;
the bot answers through the bot API. The answer appears as a normal message headed "X used /command", or as an **ephemeral**
answer that only you can see: it is not stored, never reaches other people and goes away on reload or with Dismiss. On the phone
the commands show as chips above the composer. Bot owners: see "Slash commands for bots" in docs/API.md.

## Age-restricted channels

Tick "Age-restricted channel (18+)" when creating or editing a text channel. The channel gets an 18+ badge, and the first
time a member opens one they confirm "I am 18 or older" once for their whole account. This is a plain click-through: nothing is
verified and nothing is sent to anyone. Unconfirmed members cannot read or post there, and the channel is left out of their
search. It is a courtesy gate, not an access control: use channel permissions to keep people out.

## Verification level

Server Settings > Overview > Verification level holds back brand-new accounts and recent joiners from posting: low (account 5
minutes old), medium (also a member for 10 minutes), high (account 7 days old and a member for 10 minutes). The owner, bots and
anyone with a role are never held back. Everything is local: no email, phone or outside check.

## Role icons

Roles can carry an emoji or an uploaded image (Server Settings > Roles). The icon of a member's highest role that has one is
shown next to their name in chat and in the member list, on the web, in the desktop app and on the phone.

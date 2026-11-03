# Changelog

All notable changes to MeshCrowd. Newest first. Format: [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### 2026-11-03
#### Added
- Calls (STUN/TURN) with a dynamic public IP: Admin Panel > Calls can re-read the WAN address on a schedule (default every 5 minutes) from the router via UPnP, from a STUN server you name, or from a URL you name, so no third party is needed. When it changes, the new address is stored in `externalIp`, the old one kept as `previousIp`, and the built-in server restarts; private/CGNAT results are rejected. New `turn.autoIp*` settings, a "Save and check now" button and a status line.
- Devices (settings > Devices, Android You tab): lists every browser and app signed in to your account (device, IP, last active, signed in) and lets you sign any of them out, or all others; the revoked device is logged out and its live connection closed at once.
- Admin Panel > Servers: every server with owner, members and creation date; delete now (type the name to confirm) or schedule a timed deletion in hours or days, cancellable until it runs. A background worker executes due deletions.
- "Remove Custom Status" item in the avatar status menu (web, desktop and Android), shown while a custom status is set.
- Devices re-sync everything after a connection drop, so changes made while offline show up without pressing the refresh button.
- Wiki (EN/HU): documented devices, the admin Servers tab, removing a custom status and automatic device sync.
- Invite dialog and Android "Copy invite code": when a server has a vanity link, you can pick which one to share (vanity preselected) or the random code.
- Avatar background color picker beside the "Show avatar background color" checkbox (web, desktop and Android); the color is per user and shown to everyone.
- "View as a stranger" button in the profile editor and in the profile popup "..." menu (web, desktop and Android): shows your profile exactly as a non-friend sees it, without private fields.
- Admin Panel: bio editing in Edit user (moderation), and a Presence column showing whether each user is online right now (also for invisible users, visible only there).
- Custom status emoji badge on avatars in the members list, DM list, friends list and the user bar; the full custom status text now appears in the friends list and the user bar (Android friends list and profile too).
- Pin button dot: a new pin by someone else puts a dot on the pin button (and the Android conversation info button) until you open the pinned list; remembered per user on the server.
- Mutual servers in the full profile popup now show their server icons.
- Live sync between devices and users, without reloading the page (web, desktop, Android): friend requests cancelled, declined or removed, accepting or blocking on another device, and your own settings changed on another device (theme, sidebar width, server folders, notification levels, DM pins, nicknames/notes, bookmarks) now update in place; a language change on another device shows a "reload to apply" notice. Only the affected parts redraw, so scroll, drafts and open panels are kept. Blocking and unblocking stay invisible to the other person.
- "Refresh my other devices" button (settings > My Account, Android You tab) asks your other signed-in devices to re-read their lists and settings; devices also quietly re-sync when the window returns to the foreground after a minute.
- Bios are limited to 200 characters (was 500; Android was 190): live counter beside the Bio label in the profile editors (web, desktop, Android) and in the admin Edit user dialog; existing longer bios are shortened once when the server starts, and the server clips on every save.
- Unread threads: a dot on the Threads button of a channel while a thread has messages from others you have not read, and on each unread thread in the threads list (web, desktop and Android); opening a thread clears it, and it is remembered per user on the server (on Android the chat header button follows new threads and pins live). Threads now also keep a read position, so a thread you are viewing never lights up.
- Profile card: the mutual servers line now ends with small server icons (initials when a server has no icon, up to 8 plus a "+N" counter); hover shows the server name and a click opens that server.
- Desktop client tray: with unread items the whole tray icon fades (350 ms each way) between the normal ghost and a full-size colored disc showing the count (9+ above nine), with a dark outline for contrast; it returns to the normal icon once everything is read. Portable client in `Client/` rebuilt with this.
- Making a channel private or changing its permission overrides now hides or shows it for affected members immediately; custom emoji, stickers, kicks and bans were checked and already update live.

#### Fixed (console QA findings from 2026-11-01)
- Over SSH, `ban`, `account disable`, `account delete` and removing your own console permission are refused for your own account, and nobody but the local console can remove the last enabled account that has console access.
- Local-only commands (`account roleperm`, `backup restore`, `ssh ...`) refused over SSH now say "only available in the local server console"; unknown commands still get a "did you mean" hint, never a hidden command.
- Console command audit lines (bans, unbans, IP bans, announcements, config changes, backups) are written at warn so they survive `logging.level warn`; read-only commands are not audited, `config set` logs the key and values and masks only secret keys.
- SSH clients that offer both password and keyboard-interactive no longer count one wrong password twice towards the lockout.
- `ipban` no longer stores `--yes` as the reason; `backup delete` validates the name before asking; pressing `q` in `stats watch` and `log tail` no longer echoes onto the prompt.
- Android (`/m/`): the channel unread marker and the Servers-tab badge now update live.
- The unread line and "N new messages" ribbon now clear by themselves when the whole backlog is already on screen.

#### Changed
- Direct messages can now be deleted: "Delete Conversation" (web, desktop, Android) removes a 1:1 for you. The other person is told the conversation was closed and asked whether to delete it too (Cancel keeps the history as a read-only archive; the prompt also reappears as a banner), and sending into a closed conversation is refused. Once both sides delete, the history is wiped, so messaging again starts a fresh conversation (it can be unencrypted again). "Close Conversation" still only hides it.
- Invisible mode: no typing indicator, read receipts ("Seen") stop advancing while invisible and stay hidden afterwards, no custom status shown, cannot be rung by DM calls, and cannot join any voice or stage channel or DM call (switching to invisible leaves the current call). Messages still arrive normally. Admin Panel still shows real online state.
- The global notification bell in the top bar and the Android Notifications tab now use an inbox icon, so it no longer looks like the per-channel notification settings bell.
- Clicking the MeshCrowd logo at the top of the server rail (web and desktop) selects the Friends tab; the empty "no conversation selected" page is gone everywhere (also on startup and after leaving a server or group).
- Profile edits (name, avatar, avatar background, banner, card, status) now reach other users and your own other devices live; already rendered messages update in place without a re-render, so scroll position and drafts stay put. DM partners also receive profile updates.

### 2026-11-01
#### Added
- Admin console: a text interface in the server window (no login, local) and optionally over SSH (`ssh.enabled`, localhost:2222 by default, own host key, password plus TOTP, lockout and rate limits). `help` lists the commands.
- Console commands: `account` (list, info, create, passwd, delete, disable, enable, roles, grant, revoke), `ban`/`unban`/`kick`, `ipban`/`ipunban`, `config` (list, get, set, reset, path, with validation), `backup` (create, list, delete, verify, keep, auto, restore), `server stop|restart|cancel` with countdown, `status`, `list`, `stats` (and `stats watch`), `announce`, `log` (tail, show, level, files), `ssh status|kick`.
- Site permission **Manage Console** (SSH console access; the Owner has it, Site Administrator alone does not).
- Backups: zip archives in `data/backups/` with database snapshot, config and small media, manifest hashes, `backup.keep` retention, daily schedule and pre-restore copies. Restore is local-only and restarts the server.
- Leveled logging (`debug`/`info`/`warn`/`error`) to `data/logs/` with daily files, size rotation and age pruning (`logging.level`, `logging.keepDays`, `logging.maxFileMb`); events logged: logins, failed logins and 2FA failures with IP, registration, password changes, admin account and role actions, bans and autobans, console commands, startup banner, federation worker errors. Passwords, tokens, keys and message content are never logged.
- Wiki and docs: console, SSH (PuTTY steps), backups and logging in Administration (EN/HU), `ssh`, `backup` and `logging` keys in Configuration.

#### Changed
- Site Administrators without MANAGE_CONSOLE can no longer edit, disable or reset users who hold the Owner role, or edit the Owner role itself (the Admin Panel shows the 403 message).
- Upgraded installs: the one-time migration now finds the first account's Owner role by how it was created and gives it every site permission, including MANAGE_CONSOLE (older Owner roles lacked later flags). `account roleperm <role> +console|-console` in the server window repairs any other case.
- Inline secrets typed after `account create`, `account passwd` and `config set <secret key>` are no longer kept in the console's command history.
- `start-server.bat` closes the window after a deliberate stop (exit code 0) and keeps the pause for failures.
- `start-server.bat` and `start-server.sh` run a supervisor loop so `server restart` brings the server back (exit code 42); `npm start` does the same.
- Shutdown is ordered with per-component timeouts and a watchdog; signals during a countdown take effect immediately.
- Federation heartbeat and outbox worker errors go to the log files instead of only the console.

#### Known issues
- Not yet verified by hand: public-key login over SSH, the local terminal console, and the `start-server.bat` restart loop on Windows (supervisor restart was verified over SSH). TOTP over SSH is covered by tests.
- Open decision: SSH login for accounts with strengthened (split) sign-in sends the plaintext password inside the encrypted SSH channel; a separate console-only password is the alternative.

### 2026-10-31
#### Build
- Android APK 3.14 (versionCode 17) built (AndroidReleases/MeshCrowd-3.14.apk); portable desktop client rebuilt from electron/ (package version 0.9.0, no change to the shipped files).

#### Added
- Profile pictures with transparent parts no longer show the avatar background color behind them (web, desktop and Android, everywhere avatars appear); a new "Show avatar background color" checkbox beside the avatar in the profile editor turns the colored circle back on (default off, live preview, synced to other users); avatars without an uploaded picture keep the colored initial circle.
- Shared whiteboard for stage channels and server voice channels (web, desktop and Android): a panel with a pen (black, white, red, orange, yellow, green, blue, purple), three line widths, an eraser and clear-all, drawn with mouse, touch or stylus and scaled to any screen size. Stage: speakers (and Manage Channels holders) draw, the audience watches and the board is open by default; voice channel: every participant can draw and a board opens by itself when someone draws. Everyone in the call sees strokes live, late joiners get the current board, and a button in the call controls hides or shows it just for you. Clear-all is for Manage Channels holders (and stage speakers). Strokes travel as small throttled websocket batches that the server validates (palette and width whitelist, coordinates 0..1, size, rate and permission limits) and keeps in memory only (at most 400 strokes), dropped when the last participant leaves. New pure modules server/lib/whiteboard.js and web/js/whiteboardMath.mjs with unit tests.
- Crop editor for profile picture, profile header and profile background (web, desktop and Android profile picture): picking an image opens a crop window with a draggable frame, resize handles, a zoom slider, a "Keep aspect ratio" toggle (on by default, matching the avatar circle, the 340x110 header and the card body; off for a free crop), arrow-key nudging (Shift+arrows resize, Enter applies, Esc cancels) and a live preview of exactly what the card will show. The cropped picture is scaled down (avatar 512px, header and card 680px wide at most), keeps PNG transparency and is uploaded through the usual endpoints so the server limits still apply; for a GIF there is a "Keep original (animated)" button because cropping flattens the animation. New dependency-free pure module web/js/cropMath.mjs with unit tests; the auto-refocus helper now only considers the topmost dialog so it cannot steal focus from the editor.
- Notification when someone pins a message: everyone who can see it (channel, thread or DM) except the pinner gets "<user> pinned a message in #channel" in the bell panel, the desktop tray list, system notifications and the Android background check; only members who get all messages from that channel/DM are notified (mentions-only and muted ones, and ignored users, are skipped). Clicking it jumps to the pinned message. Re-pinning or unpinning is silent.
- Notification when a thread is started from a message: the author of that message (not the starter, and not when starting a thread on your own message) gets "<user> started a thread on your message" with a link that opens the thread, through the same bell, tray, system and Android delivery; muted channels and ignored users are respected.
- Setting "Always show the new-messages line" (Settings > Appearance on web/desktop/Android, plus a row in the Android You tab; stored per user with the other unread prefs). Off by default: the red line, the "N new messages since" ribbon and its jump button now appear only for messages that arrived while this device had no connection. On restores the old behavior (any unread message).
- Forums: posts can now be edited (title and opening message, author only) and deleted (author, members with Manage Messages, or site staff with Delete Any Message). Desktop/web: edit and delete buttons in the post pane and the post header; Android/mobile: a "..." menu in the post header. Audit log records deletions; other viewers see the change live.
- The ghost logo (Home) at the top of the server rail now shows an unread pill and a count of conversations with unread DMs, clearing as they are read (web and desktop; Android already shows the count on the Messages tab).

- Stickers in direct messages and group chats (web, desktop and Android): the sticker button now sits next to the emoji button in every composer, including threads and forum posts on Android. In a DM you can use the stickers of every server you are a member of (the picker groups them by server); server-side the same rule applies, so a sticker from a server you have left is refused. In end-to-end encrypted DMs the sticker reference travels inside the encrypted message (the server never sees which sticker was sent, only the ordinary image fetch happens); a federated DM delivers the sticker as an image attachment. Stickers show in message lists, reply quotes, forwards, search results, pins, bookmarks, DM previews ("Sent a sticker"), in-app/desktop/system notifications and the Android background notifications. A sticker message keeps its sticker when its text is edited (the text may be emptied). Not available in federated (remote-server) channels, which cannot carry them.

#### Fixed
- Desktop: notifications no longer linger in the tray after you have read the messages. The tray "Recent" list and the system pop-ups for a channel/DM/friend request are dismissed as soon as it is no longer unread (read in the app or on another device), when you open it with the window focused, and the whole list is cleared when the window gains focus with nothing unread; no need to open the tray menu to clear them. Android: opening the app clears the message notifications from the notification shade.
- Desktop: the unread tray icon is now much easier to see, with a badge over half the icon's height (was about a third), larger digits and a white outline; the normal icon is unchanged.
- `#channel` in messages now links to the channel on web, desktop and Android: names are matched case-insensitively against the channels you can see in that server, including names with accents or spaces (previously only ASCII words), unknown names stay plain text, the link has a hover/screen-reader label and works with the keyboard, and on Android tapping it opens the channel (voice, forum and notes channels open their own screens).
- The private-message unread badge no longer sticks: reading a DM on another device now clears it here too, a closed (hidden) conversation no longer keeps the tray/favicon/tab badge on, reconnecting refreshes the read markers, and on Android your own sent messages and a deleted newest message no longer leave a DM looking unread.
- The message input now keeps focus after sending (Enter or the send button), after picking an emoji, sticker or reaction, after closing the pickers, after finishing an edit and after saving a note, in channels, DMs, threads, forum posts and notes on web, desktop and Android. Focus is not taken from another text field or an open dialog.
- App-wide: a shared handler (web/js/autoRefocus.js, also on Android) hands focus back to whatever text field you were typing in after Enter or a send/save/post-style button next to it, even when the screen re-rendered the field (search boxes, quick replies, inline rename/edit inputs, modal forms that stay open).
- The red "new messages" line and ribbon no longer appear for messages that arrive while you are viewing the channel, thread or DM (they used to pop up whenever the read marker was older than the new message).
- The red line and ribbon now disappear as soon as you scroll to the bottom of the new messages, on web, desktop and Android, instead of lingering until you leave.
- Forums: a post's reply count now updates live for everyone when a reply is deleted, and a newly created post no longer shows a count of 2 to other viewers.
- "<user> is typing..." now shows in threads and forum posts on web, desktop and Android (the server previously dropped typing events for threads, and Android never sent them).

#### Changed
- Auto-ban no longer fires after a few quick page refreshes. Flood protection now counts only dynamic requests from visitors who are not signed in (script, style, image, upload, vendor and language files, signed-in users, private/loopback and allowlisted addresses never count), scanner-style probes (/wp-login.php, /.env, *.php ...) are counted separately, and automatic ban lengths start short and double for each earlier auto-ban of the same address within 24 h (cap 7 days). Defaults: flood 900 -> 1500 requests per 10 s, first ban 15 -> 5 min, rate-limit violations 20 -> 50 per 5 min, failed-sign-in ban 60 -> 15 min (still 30 failures per 10 min), new scanner limit 10 per 5 min. Settings still holding the old defaults follow the new ones; custom values are kept. Security Center shows the new scanner limit.
- Noise suppression: the RNNoise module (~4.8 MB) is now preloaded when the app opens (if the setting is on) and when the setting is switched on, instead of at the first call join.

### 2026-10-30
#### Fixed
- Android/mobile web: opening a server channel via "last chat" start view, a deep link or an invite now switches the underlying tab to Servers, so Back returns to the server's channel list instead of Messages.

#### Changed
- Profile popover: Message, Add friend and (own profile) Edit profile moved into the "..." menu; the action buttons are gone. The quick-message input stays when the user allows DMs. The menu opens beside the card instead of over it, and the card no longer has a gray strip at the bottom. The mobile profile sheet got the same treatment: actions moved into a "..." menu, with a quick-message input when DMs are allowed. Your own sheet has a "..." menu with Edit profile (shared with the You tab).

#### Added
- "Report" entry for users in the member list right-click menu, friend rows, DM rows (desktop) and the mobile profile sheet; previously only message menus and the profile card's "..." menu had it.
- Registration mode in `data/config.json` (`registrationMode`): `open` (default), `invite` (new accounts need a valid server or channel invite link/code) or `closed`. The first account on an empty instance is always allowed.
- Admin Panel > Overview: "Registration" setting (site admins), applied immediately without a restart.
- Sign-in screen on web, Electron and Android: invite field in invite mode (prefilled from `#invite=` links, accepts pasted links), notice instead of the Register link in closed mode.
- English and Hungarian strings for the above.
- Desktop/web profile card is now a Discord-style popover anchored next to the clicked name/member instead of a centered modal.
- Clicking your own name opens your own card with an "Edit Profile" button (opens account settings) instead of jumping straight into settings.
- Profile card: quick-message input (Enter opens the DM and sends the message), shown only when the user can be messaged (friends, or their DM privacy and per-server settings allow it). `GET /api/users/:id` now returns `canMessage`.

#### Fixed
- Chat: in a narrow chat column the message hover toolbar covered the author name, making the profile unopenable; it now sits above the row there.
- Android/mobile voice call tiles: avatar overflowed its 80px wrapper, so the speaking ring was shifted up-left and the avatar covered the status dot and volume strip.

### 2026-10-29
#### Added
- Chat: unread banner with jump and mark-as-read, web and mobile (Android 3.13).

#### Fixed
- Slash command popup renders above poll options.

### 2026-10-28
#### Added
- Configurable message length cap (`maxMessageChars`, default 15000); over-limit text is offered as a `.txt`/`.md` attachment (up to 300 KB), web and mobile.
- Sticker pickers search by description as well as name; animated stickers play on hover only, with a cap on concurrent animations.
- Message paging with a bounded window and scrollable jump views, web and mobile.

#### Fixed
- Double-post of messages over 4000 characters; over-limit sends blocked client-side.
- Stuck unread badge after deleting the newest message; own messages never count as unread.
- Composer buttons stack under the text for tall drafts.
- Single emoji picker button in the role editor.
- Hungarian wording (onboarding and others).

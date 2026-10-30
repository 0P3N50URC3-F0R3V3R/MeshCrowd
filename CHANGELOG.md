# Changelog

All notable changes to MeshCrowd. Newest first. Format: [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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

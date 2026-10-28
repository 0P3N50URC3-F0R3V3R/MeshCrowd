---
title: Accounts, Passport and sign-in
desc: Registering, the Passport identity file, strengthened sign-in, two-factor authentication and recovery.
group: Using MeshCrowd
order: 1
---

## Registering and signing in

Anyone who can reach the server can register with an email address, a username and a password. **The first account becomes the Owner.** You can sign in with your email address or your username.

Sessions are opaque tokens kept on the server in an httpOnly cookie. They are not JWTs, so each one can be revoked, and disabling an account ends its sessions and live connections at once.

## Passport: your portable identity

When you register in the web client the browser creates a **Passport**: a key pair that anchors your account.

- **Export** it from Settings, Passport as an encrypted `.mcpass` file.
- **Sign in with the file** and its passphrase, which is also how you recover a forgotten password.
- **Register on another MeshCrowd server** with the same identity. There is one account per Passport per server.

::: warn Keep the file safe
Your Passport also protects your encrypted DMs and your private Notes channels. If you lose both the Passport file and your password, that encrypted content cannot be recovered by anyone.
:::

## Strengthened sign-in

Accounts created in the web client derive two keys from your password **in the browser**. One key is sent to the server and stored as a bcrypt hash. The other wraps your Passport seed and never leaves the browser. The server never sees the password of such an account, so logs, a database copy or a curious operator cannot read it.

Older accounts, including those created by very old Android apps, can opt in under **Settings, Passport**. Android apps older than 3.0 cannot sign in to a strengthened account and need to be updated.

Failed Passport proofs lock that identity for 15 minutes after five failures. Password login is not affected.

## Two-factor authentication

Turn on TOTP under **Settings, Account**. Scan the QR code with an authenticator app and store the **recovery codes** somewhere safe: each works once. Email verification is not implemented; two-factor is TOTP based.

## Changing your password

Use **Settings, Account, Change password**. For strengthened accounts the browser re-wraps your Passport with the new password.

## Profile

Your avatar, banner, bio, custom status and presence are covered in [Profiles, status and themes](personalization.html). Privacy controls decide who can send you DMs and who can see your profile card.

## Friends and direct messages

Send a friend request by username. Friends can start 1:1 DMs; group DMs hold up to ten people. A 1:1 DM can be switched to end-to-end encryption with the lock button, which cannot be undone: delete the conversation and start a new one to go back. Details are on [Security and privacy](security.html).

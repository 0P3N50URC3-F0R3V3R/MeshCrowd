---
title: Administration and backups
desc: The admin panel, staff ranks, upload limits, pruning, languages, backups and day-to-day running.
group: Operating a server
order: 1
---

## The admin panel

The admin panel is shown only to accounts with a **site staff rank**. The **Owner** (the first account) has every permission and can create ranks and hand out specific permissions.

| Permission | Allows |
|---|---|
| View Admin Panel | See the panel |
| Manage Users | Disable and enable accounts, edit any profile |
| Manage Site Roles | Create and assign staff ranks |
| Delete Any Message | Remove content anywhere |
| Manage Any Server | Delete or transfer any server, create Sites |
| Manage Reports | Work the user report queue |
| Prune Data | Bulk-delete history by date |
| Manage AI | Configure AI providers and bots on any server |
| Site Administrator | Bypasses all site permission checks |

The panel also shows instance statistics and lets you manage users and servers.

## Attachments

Under **Admin, Overview** you can lower the upload size limit at runtime (never above `maxUploadMb` in the configuration) and optionally restrict uploads to an allowlist of extensions such as `.png, .jpg, .pdf`. Executables, HTML and SVG are always blocked, and files are served as downloads under a sandboxing Content-Security-Policy so an upload can never run as script in the app's origin.

## Sessions

Session lifetime is a site setting. Individual sessions are revocable, and disabling an account ends its sessions and live connections immediately.

## Data pruning

- Server moderators with **Prune Content** prune their own server's channels and threads from **Server Settings**.
- Site administrators with **Prune Data** can prune any server's channels or any DM from the admin panel. Conversations are listed by size, and message content is never shown.
- Group DM creators can prune their own group.

Every prune shows a preview first and can run immediately or after a 24-hour notice. See [Moderation and safety](moderation.html#data-pruning).

## Languages

The interface ships in English and Hungarian. Administrators can add language files from the admin panel. Strings are plain JSON, so a translation is a copy of the English file with the values changed.

## Backups

::: note A backup is a folder
Stop the server and copy the whole `data/` folder: the database, the configuration, the certificate and every uploaded file. To restore, put the folder back.
:::

Schedule it with the tool of your choice. If you cannot stop the server, copy at a quiet moment and keep several generations. Test a restore once.

## Updating

Take a backup, stop the server, replace the program files (keeping `data/`) and start again. Database changes are applied automatically. See [Installation](installation.html).

## Monitoring

The server logs to standard output: certificate fingerprints, migrations, warnings and errors. Watch that log with your service manager. A simple health check is requesting the login page.

## Moving to a new machine

Copy `data/` to the new machine and start the server there. If the address changes, update `publicHost` and delete `data/certs/` to get a new certificate. Clients that trusted the old certificate will ask again.

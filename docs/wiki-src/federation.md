---
title: Federation
desc: Pairing two servers so people can reach each other, what is shared, and the safety rules behind it.
group: Extending
order: 4
---

**Federation** lets two MeshCrowd servers trust each other so that their people can interact. It is **off by default**: a stand-alone server opens no federation route and runs no federation worker. Passport sign-in works either way.

## Turning it on

Set `"federation": { "enabled": true }` in `data/config.json` and restart. A **Federation** page appears in the admin panel.

## Pairing

1. A site administrator sets the federation admin password the first time (signed in, or from the server machine). An anonymous visitor cannot claim it.
2. Create an **invite link** on one server and **redeem** it on the other.
3. Each side must explicitly **accept** the other in **Admin, Federation**. A pending peer can do nothing except finish or cancel its own pairing.
4. **Revoke** at any time. Revoking drops trust on both sides.

## What federation shares

- **Friend requests and DMs** between people on paired servers.
- **Discovery**: each other's public servers appear in the directory.
- **Joining**: you can join a server on another instance with a `code@domain` invite. Remote servers appear in your server rail and open in a simplified view with text channels, history, posting, editing, deleting and reactions.

Remote servers are **proxied live** from the owning instance: nothing is copied. They grey out while that instance is offline.

## What it does not do yet

- Remote servers have text channels only: no attachments, threads, voice or member list.
- Federated DMs are not end-to-end encrypted.

## Safety rules

- Peers are trusted **only for identity**. Permissions are always decided by the instance that owns the server.
- Calls between instances are signed and rate limited.
- Outgoing calls refuse redirects and pin the validated address, so a paired peer cannot point your server at your internal network.

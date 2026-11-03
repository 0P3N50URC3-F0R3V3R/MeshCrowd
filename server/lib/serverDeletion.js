'use strict';

const { db } = require('../db');
const hub = require('../socket/hub');
const logger = require('./logger').scoped('server-deletion');

const TICK_MS = 60 * 1000;
let timer = null;

function deleteServerNow(server) {
  const memberIds = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(server.id).map((r) => r.user_id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);
  if (server.kind === 'site') {
    require('./siteProcesses').stop(server.id);
    require('./siteFiles').removeSiteDir(server.id);
  }
  require('./noteFiles').sweepNoteFiles();
  hub.notifyUserIds(memberIds, { type: 'server_delete', serverId: server.id });
}

function deleteDueServers(now = new Date()) {
  const due = db.prepare('SELECT * FROM servers WHERE delete_at IS NOT NULL AND delete_at <= ?').all(now.toISOString());
  for (const s of due) {
    try {
      deleteServerNow(s);
      logger.info(`scheduled deletion executed for server ${s.id} (${JSON.stringify(s.name)})`);
    } catch (err) { logger.error(`scheduled deletion of server ${s.id} failed: ${err.message}`); }
  }
  return due.length;
}

function startWorker() {
  if (timer) return;
  deleteDueServers();
  timer = setInterval(() => deleteDueServers(), TICK_MS);
  timer.unref?.();
}

function stopWorker() { clearInterval(timer); timer = null; }

module.exports = { deleteServerNow, deleteDueServers, startWorker, stopWorker };

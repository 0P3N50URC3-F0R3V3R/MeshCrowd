'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MODES = ['ask', 'folder'];

function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[<>:"/\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  return base || 'download';
}

function uniquePath(dir, name, exists = fs.existsSync) {
  const file = safeName(name);
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  let candidate = path.join(dir, file);
  for (let i = 1; exists(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

function normalizeDir(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 500 || !path.isAbsolute(v)) return null;
  return path.normalize(v);
}

function setupDownloads({ session, ipcMain, dialog, shell, app, getWindow, getConfig }) {
  const downloads = new Map();
  let nextId = 0;

  const send = (payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('dismesh:download-event', payload);
  };

  const updateTaskbar = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    let received = 0;
    let total = 0;
    let active = 0;
    for (const d of downloads.values()) {
      if (d.state !== 'progressing') continue;
      active++;
      received += d.received;
      total += d.total;
    }
    win.setProgressBar(active === 0 ? -1 : total > 0 ? Math.min(received / total, 1) : 2);
  };

  session.on('will-download', (event, item) => {
    const cfg = getConfig();
    const name = safeName(item.getFilename());
    const dir = normalizeDir(cfg.downloadDir);
    const id = ++nextId;
    if (cfg.downloadMode === 'folder') {
      try {
        const target = dir || app.getPath('downloads');
        fs.mkdirSync(target, { recursive: true });
        item.setSavePath(uniquePath(target, name));
      } catch { /* falls back to the save dialog */ }
    }
    if (!item.getSavePath()) item.setSaveDialogOptions({ defaultPath: path.join(dir || app.getPath('downloads'), name) });

    const d = { id, item, name, received: 0, total: item.getTotalBytes(), state: 'progressing', path: '', announced: false };
    downloads.set(id, d);

    const emit = () => send({ id, name, received: d.received, total: d.total, state: d.state, path: d.path });

    item.on('updated', (e, state) => {
      d.path = item.getSavePath();
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      d.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      d.announced = true;
      emit();
      updateTaskbar();
    });
    item.once('done', (e, state) => {
      d.path = item.getSavePath() || d.path;
      d.received = item.getReceivedBytes();
      d.state = state;
      if (d.announced || state === 'completed') emit();
      updateTaskbar();
      if (state !== 'completed') downloads.delete(id);
    });
  });

  ipcMain.handle('dismesh:select-download-dir', async () => {
    const win = getWindow();
    const cfg = getConfig();
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: normalizeDir(cfg.downloadDir) || app.getPath('downloads'),
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  ipcMain.handle('dismesh:show-download', (event, id) => {
    const d = downloads.get(id);
    if (d && d.path) shell.showItemInFolder(d.path);
  });
  ipcMain.handle('dismesh:open-download', async (event, id) => {
    const d = downloads.get(id);
    if (!d || !d.path || d.state !== 'completed') return { ok: false };
    const err = await shell.openPath(d.path);
    return { ok: !err, error: err || undefined };
  });
  ipcMain.handle('dismesh:cancel-download', (event, id) => {
    const d = downloads.get(id);
    if (d && d.state !== 'completed') d.item.cancel();
  });
  ipcMain.handle('dismesh:open-download-dir', async () => {
    const dir = normalizeDir(getConfig().downloadDir) || app.getPath('downloads');
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
}

module.exports = { MODES, safeName, uniquePath, normalizeDir, setupDownloads };

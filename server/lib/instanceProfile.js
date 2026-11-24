'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const DIR = path.join(path.dirname(config.CONFIG_PATH), 'instance');
const MAX_NAME = 60;
const MAX_DESCRIPTION = 300;
const MAX_LOGO = 1024 * 1024;
const MAX_ICON = 16384;
const MAX_ICON_PX = 128;
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class ProfileError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const singleLine = (s, max) => s.replace(/\s+/g, ' ').trim().slice(0, max);

function magicMatches(buf, mime) {
  if (mime === 'image/png') return buf.subarray(0, 8).equals(PNG_SIGNATURE);
  if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/gif') return buf.subarray(0, 4).toString('latin1') === 'GIF8';
  return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
}

// The config file can be edited by hand or with `config set`, so only the exact names this module writes are trusted.
const FILE_NAME = { logoPath: /^logo\.(png|jpg|webp|gif)$/, iconPath: /^icon\.png$/ };

function fileFor(key) {
  const rel = config.load().instance[key];
  if (typeof rel !== 'string' || !FILE_NAME[key].test(rel)) return null;
  const file = path.join(DIR, rel);
  return fs.existsSync(file) ? file : null;
}

function get() {
  const cfg = config.load().instance;
  const name = typeof cfg.name === 'string' ? singleLine(cfg.name, MAX_NAME) : '';
  const description = typeof cfg.description === 'string' ? singleLine(cfg.description, MAX_DESCRIPTION) : '';
  return { name, description, hasLogo: !!fileFor('logoPath'), hasIcon: !!fileFor('iconPath') };
}

function update({ name, description } = {}) {
  const patch = {};
  if (name !== undefined) {
    if (typeof name !== 'string') throw new ProfileError(400, 'name must be a string');
    patch.name = singleLine(name, MAX_NAME);
  }
  if (description !== undefined) {
    if (typeof description !== 'string') throw new ProfileError(400, 'description must be a string');
    patch.description = singleLine(description, MAX_DESCRIPTION);
  }
  if (Object.keys(patch).length) config.save({ instance: patch });
  return get();
}

function store(key, name, buf) {
  fs.mkdirSync(DIR, { recursive: true });
  const old = fileFor(key);
  fs.writeFileSync(path.join(DIR, name), buf);
  if (old && path.basename(old) !== name) fs.rmSync(old, { force: true });
  config.save({ instance: { [key]: name } });
}

function remove(key) {
  const old = fileFor(key);
  if (old) fs.rmSync(old, { force: true });
  config.save({ instance: { [key]: '' } });
}

function setLogo(buf, mime) {
  const ext = LOGO_TYPES[mime];
  if (!ext) throw new ProfileError(400, 'logo must be a PNG, JPEG, WebP or GIF image');
  if (buf.length > MAX_LOGO) throw new ProfileError(413, 'logo is larger than 1 MB');
  if (!magicMatches(buf, mime)) throw new ProfileError(400, 'file content does not match its image type');
  store('logoPath', `logo.${ext}`, buf);
}

function setIcon(buf) {
  if (buf.length > MAX_ICON) throw new ProfileError(413, `icon is larger than ${MAX_ICON} bytes`);
  if (buf.length < 24 || !magicMatches(buf, 'image/png')) throw new ProfileError(400, 'icon must be a PNG image');
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') throw new ProfileError(400, 'icon must be a PNG image');
  if (buf.readUInt32BE(16) > MAX_ICON_PX || buf.readUInt32BE(20) > MAX_ICON_PX) throw new ProfileError(400, `icon must be at most ${MAX_ICON_PX}x${MAX_ICON_PX} pixels`);
  store('iconPath', 'icon.png', buf);
}

const clearLogo = () => remove('logoPath');
const clearIcon = () => remove('iconPath');

function logoFile() {
  const file = fileFor('logoPath');
  if (!file) return null;
  const ext = path.extname(file).slice(1);
  const mime = Object.keys(LOGO_TYPES).find((m) => LOGO_TYPES[m] === ext);
  return { file, mime };
}

function iconFile() {
  const file = fileFor('iconPath');
  return file ? { file, mime: 'image/png' } : null;
}

function iconDataUri() {
  const f = iconFile();
  return f ? `data:image/png;base64,${fs.readFileSync(f.file).toString('base64')}` : null;
}

module.exports = { get, update, setLogo, setIcon, clearLogo, clearIcon, logoFile, iconFile, iconDataUri, ProfileError, MAX_NAME, MAX_DESCRIPTION };

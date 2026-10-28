'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const logger = require('./logger');

const ROOT = path.join(__dirname, '..', '..');
const BUNDLED_DIR = path.join(ROOT, 'runtime', 'php');
const VCREDIST = path.join(BUNDLED_DIR, 'vc_redist.x64.exe');
const VCREDIST_OK_CODES = new Set([0, 1638, 3010]); // success, newer version present, reboot required

const DISABLED_FUNCTIONS = [
  'exec', 'shell_exec', 'system', 'passthru', 'popen', 'proc_open', 'proc_get_status', 'proc_terminate', 'proc_close',
  'pcntl_exec', 'dl', 'mail', 'putenv', 'fsockopen', 'pfsockopen', 'stream_socket_client', 'stream_socket_server', 'symlink', 'link',
].join(',');

let activeBin = 'php';
let status = { ok: false, reason: 'not-initialized' };

function resolveBinary(config) {
  const configured = config && config.sites && config.sites.phpPath;
  if (configured) return configured;
  const bundled = path.join(BUNDLED_DIR, process.platform === 'win32' ? 'php.exe' : 'php');
  return fs.existsSync(bundled) ? bundled : 'php';
}

function classifyExit(code) {
  const u = code >>> 0;
  return u === 0xC0000135 || u === 0xC000007B ? 'vcredist-missing' : 'failed';
}

// php.ini syntax reads an unquoted "~" as the bitwise-NOT operator, which truncates Windows 8.3 short
// names such as C:\Users\RENDSZ~1, so every path value is double-quoted.
const iniPath = (p) => `"${p}"`;

function iniArgs(bin) {
  const dir = path.dirname(bin);
  const ini = path.join(dir, 'php.ini');
  return path.isAbsolute(bin) && fs.existsSync(ini) ? ['-c', ini, '-d', `extension_dir=${iniPath(path.join(dir, 'ext'))}`] : [];
}

// open_basedir is compared against PHP's resolved (long-name) paths, so expand short names up front.
function realDir(dir) {
  const abs = path.resolve(dir);
  try { return fs.realpathSync.native(abs); } catch { return abs; }
}

function check(bin) {
  const r = spawnSync(bin, [...iniArgs(bin), '-v'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (r.error) return { ok: false, reason: 'not-found', detail: r.error.message };
  if (r.status === 0) {
    const lines = String(r.stdout || '').split('\n').map((l) => l.trim());
    return { ok: true, version: lines.find((l) => /^PHP\s/.test(l)) || lines.find(Boolean) || '' };
  }
  return { ok: false, reason: classifyExit(r.status), detail: `exit ${r.status}` };
}

function scrubbedEnv(bin) {
  const env = { PATH: process.platform === 'win32' ? path.dirname(bin) : '/usr/bin:/bin' };
  for (const k of ['SystemRoot', 'TEMP', 'TMP']) {
    const v = process.env[k] || (k === 'TMP' ? process.env.TEMP : undefined);
    if (v) env[k] = v;
  }
  return env;
}

function launchSpec({ port, docroot }) {
  const bin = activeBin;
  const root = realDir(docroot);
  const args = iniArgs(bin);
  args.push(
    '-d', `open_basedir=${iniPath(root)}`,
    '-d', `disable_functions=${DISABLED_FUNCTIONS}`,
    '-d', 'allow_url_include=0', '-d', 'allow_url_fopen=0',
    '-d', 'display_errors=0', '-d', 'log_errors=1',
    '-d', 'file_uploads=0', '-d', 'max_execution_time=15',
    '-d', 'memory_limit=128M', '-d', 'expose_php=0',
    '-S', `127.0.0.1:${port}`, '-t', root,
  );
  return { bin, args, cwd: root, env: scrubbedEnv(bin) };
}

function installVcRedist() {
  return new Promise((resolve) => {
    const child = spawn(VCREDIST, ['/install', '/quiet', '/norestart'], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve({ ok: false, code: null }));
    child.once('exit', (code) => resolve({ ok: VCREDIST_OK_CODES.has(code), code }));
  });
}

async function init(config) {
  activeBin = resolveBinary(config);
  let r = check(activeBin);
  if (r.reason === 'vcredist-missing' && process.platform === 'win32' && fs.existsSync(VCREDIST)) {
    logger.warn('[php] Visual C++ runtime missing; running the bundled installer (a UAC prompt may appear)');
    const inst = await installVcRedist();
    logger.log(`[php] vc_redist finished with code ${inst.code}`);
    r = check(activeBin);
  }
  status = { ...r, bin: activeBin };
  if (status.ok) logger.log(`[php] ${status.version} at ${activeBin}`);
  else logger.warn(`[php] unavailable (${status.reason}${status.detail ? `: ${status.detail}` : ''}); Sites with PHP pages will not work`);
  return getStatus();
}

const getStatus = () => ({ ...status });

module.exports = { resolveBinary, classifyExit, check, scrubbedEnv, launchSpec, installVcRedist, init, getStatus, DISABLED_FUNCTIONS };

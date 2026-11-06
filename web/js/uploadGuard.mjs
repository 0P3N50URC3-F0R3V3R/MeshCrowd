const BLOCKED = new Set([
  'exe', 'com', 'bat', 'cmd', 'msi', 'ps1', 'psm1', 'sh', 'bash', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'scr', 'jar', 'dll', 'cpl', 'hta', 'msc', 'reg', 'lnk', 'pif', 'scf', 'url', 'jnlp', 'msix', 'appx',
  'html', 'htm', 'xhtml', 'svg', 'shtml',
]);

export function fileExtension(name) {
  const base = String(name || '').replace(/[. ]+$/, '');
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

export function checkUploadFile(file, maxMb) {
  const ext = fileExtension(file.name);
  if (BLOCKED.has(ext)) return { ok: false, reason: 'blocked', ext };
  if (maxMb > 0 && file.size > maxMb * 1024 * 1024) return { ok: false, reason: 'tooLarge', maxMb };
  return { ok: true };
}

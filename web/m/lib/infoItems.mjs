const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

export function collectItems(messages) {
  const media = [];
  const files = [];
  const links = [];
  const seen = new Set();
  for (const m of [...messages].sort((a, b) => b.id - a.id)) {
    for (const a of m.attachments || []) {
      const mime = a.mimeType || '';
      (mime.startsWith('image/') || mime.startsWith('video/') ? media : files).push({ url: a.url, mimeType: mime, fileName: a.fileName, sizeBytes: a.sizeBytes });
    }
    if (m.decryptFailed || !m.content) continue;
    for (const url of m.content.match(URL_RE) || []) {
      if (!seen.has(url)) { seen.add(url); links.push(url); }
    }
  }
  return { media, files, links };
}

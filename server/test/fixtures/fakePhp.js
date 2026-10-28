'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const a = process.argv;
const [host, port] = a[a.indexOf('-S') + 1].split(':');
const root = a[a.indexOf('-t') + 1];
if (fs.existsSync(path.join(root, 'crash.flag'))) process.exit(1);

let chain = Promise.resolve(); // serialise requests like php -S does
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    chain = chain.then(() => new Promise((done) => {
      res.on('close', done);
      const respond = () => {
        res.setHeader('x-saw-cookie', req.headers.cookie ? 'yes' : 'no');
        res.setHeader('x-worker-pid', String(process.pid));
        res.setHeader('set-cookie', 'PHPSESSID=abc');
        if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: '/login.php' }); return res.end(); }
        if (req.url.startsWith('/evil')) { res.writeHead(302, { Location: '//evil.com/x' }); return res.end(); }
        if (req.url.startsWith('/json')) { res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}'); }
        res.setHeader('content-type', 'text/html');
        res.end(`<html><head></head><body><a href="/next.php">n</a>${req.method} ${req.url} [${body}]</body></html>`);
      };
      if (req.url.startsWith('/slow')) setTimeout(respond, 300); else respond();
    }));
  });
}).listen(Number(port), host);

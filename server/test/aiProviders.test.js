'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const secretBox = require('../lib/ai/secretBox');
const { validateBaseUrl } = require('../lib/ai/http');
const providers = require('../lib/ai/providers');

let server; let port; let mode = 'ok'; let seen = null;

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      if (mode === 'status500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom secret detail"}'); return; }
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); return; }
      if (mode === 'hang') return;
      if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'gemma3:4b' }, { name: 'phi4' }, { name: 'gemma3:4b' }] })); return; }
      if (req.url === '/v1/models' || req.url === '/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] })); return; }
      if (req.url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (mode === 'ollamaError') { res.end('{"error":"model not found"}\n'); return; }
        if (mode === 'hugeLine') { res.end(`${'x'.repeat(70000)}\n`); return; }
        if (mode === 'long') {
          for (let i = 0; i < 60; i++) res.write(`${JSON.stringify({ message: { content: 'y'.repeat(100) }, done: false })}\n`);
          res.end(`${JSON.stringify({ message: { content: '' }, done: true })}\n`);
          return;
        }
        res.write(`${JSON.stringify({ message: { content: 'Hel' }, done: false })}\n`);
        res.write(`${JSON.stringify({ message: { content: 'lo' }, done: false })}\n`);
        res.end(`${JSON.stringify({ message: { content: '' }, done: true })}\n`);
        return;
      }
      if (req.url === '/v1/chat/completions' || req.url === '/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' there' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
test.beforeEach(() => { mode = 'ok'; seen = null; });
test.after(async () => {
  server.closeAllConnections?.();
  server.close();
  db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const row = (kind, extra = {}) => ({
  kind, base_url: `http://127.0.0.1:${port}`, api_key_enc: null, timeout_s: 5, scope: 'site', ...extra,
});
const msgs = [{ role: 'user', content: 'hi' }];

test('validateBaseUrl normalizes and rejects bad URLs', () => {
  assert.equal(validateBaseUrl('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(validateBaseUrl(' https://ai.example.com/api/ '), 'https://ai.example.com/api');
  for (const bad of ['ftp://x', 'nope', 'http://u:p@host', 'http://h/?a=1', 'http://h/#x', '']) {
    assert.throws(() => validateBaseUrl(bad), `should reject ${bad}`);
  }
});

test('ollama chat streams tokens and returns the full text', async () => {
  const tokens = [];
  const out = await providers.chat({ provider: row('ollama'), model: 'gemma3:4b', messages: msgs, onToken: (t, full) => tokens.push([t, full]) });
  assert.equal(out.text, 'Hello');
  assert.deepEqual(tokens, [['Hel', 'Hel'], ['lo', 'Hello']]);
  assert.equal(seen.url, '/api/chat');
  assert.deepEqual(seen.body, { model: 'gemma3:4b', messages: msgs, stream: true });
});

test('openai chat streams SSE, sends the bearer key, and does not double /v1', async () => {
  const provider = row('openai', { api_key_enc: secretBox.encrypt('sk-test') });
  const out = await providers.chat({ provider, model: 'gpt-x', messages: msgs });
  assert.equal(out.text, 'Hi there');
  assert.equal(seen.url, '/v1/chat/completions');
  assert.equal(seen.headers.authorization, 'Bearer sk-test');
  await providers.chat({ provider: { ...provider, base_url: `http://127.0.0.1:${port}/v1` }, model: 'gpt-x', messages: msgs });
  assert.equal(seen.url, '/v1/chat/completions');
});

test('listModels for both kinds, de-duplicated and sorted', async () => {
  assert.deepEqual(await providers.listModels(row('ollama')), ['gemma3:4b', 'phi4']);
  assert.deepEqual(await providers.listModels(row('openai')), ['gpt-x', 'gpt-y']);
});

test('a non-200 answer becomes a generic ProviderError without upstream detail', async () => {
  mode = 'status500';
  await assert.rejects(providers.chat({ provider: row('ollama'), model: 'm', messages: msgs }), (err) => {
    assert.ok(err instanceof providers.ProviderError);
    assert.match(err.message, /HTTP 500/);
    assert.ok(!err.message.includes('secret detail'));
    return true;
  });
});

test('redirects are refused', async () => {
  mode = 'redirect';
  await assert.rejects(providers.chat({ provider: row('ollama'), model: 'm', messages: msgs }), /redirect/i);
});

test('an {error} line from ollama is a ProviderError', async () => {
  mode = 'ollamaError';
  await assert.rejects(providers.chat({ provider: row('ollama'), model: 'm', messages: msgs }), providers.ProviderError);
});

test('an oversized stream line is refused', async () => {
  mode = 'hugeLine';
  await assert.rejects(providers.chat({ provider: row('ollama'), model: 'm', messages: msgs }), providers.ProviderError);
});

test('a provider that never answers times out', async () => {
  mode = 'hang';
  await assert.rejects(providers.chat({ provider: row('ollama'), model: 'm', messages: msgs, timeoutMs: 150 }), /timed out/i);
});

test('a caller abort stops the call', async () => {
  mode = 'hang';
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(providers.chat({ provider: row('ollama'), model: 'm', messages: msgs, signal: ctl.signal, timeoutMs: 5000 }), providers.ProviderError);
});

test('output is truncated at maxChars', async () => {
  mode = 'long';
  const out = await providers.chat({ provider: row('ollama'), model: 'm', messages: msgs, maxChars: 250 });
  assert.equal(out.text.length, 250);
  assert.equal(out.truncated, true);
});

test('a non-site provider cannot reach a private address', async () => {
  await assert.rejects(providers.chat({ provider: row('ollama', { scope: 'server' }), model: 'm', messages: msgs }), providers.ProviderError);
});

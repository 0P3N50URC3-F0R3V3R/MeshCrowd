'use strict';

const secretBox = require('./secretBox');
const { AiHttpError, aiRequest, readBody, readLines } = require('./http');

const MAX_ERROR_BODY = 4096;
const MAX_JSON_BODY = 1024 * 1024;
const DEFAULT_MAX_CHARS = 8000;

class ProviderError extends Error {
  constructor(message) { super(message); this.name = 'ProviderError'; }
}

const baseOf = (provider) => provider.base_url.replace(/\/+$/, '');
const openAiUrl = (provider, tail) => {
  const base = baseOf(provider);
  return /\/v1$/.test(base) ? `${base}${tail}` : `${base}/v1${tail}`;
};
const authHeaders = (provider) => (
  provider.api_key_enc ? { authorization: `Bearer ${secretBox.decrypt(provider.api_key_enc)}` } : {}
);
const timedSignal = (provider, signal, timeoutMs) => {
  const timeout = AbortSignal.timeout(timeoutMs ?? provider.timeout_s * 1000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

function toProviderError(err, signal) {
  if (err instanceof ProviderError) return err;
  if (err instanceof AiHttpError) return new ProviderError(err.message);
  if (signal?.aborted && signal.reason?.name === 'TimeoutError') return new ProviderError('the provider timed out');
  if (err && err.name === 'TimeoutError') return new ProviderError('the provider timed out');
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return new ProviderError('the request was cancelled');
  if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH')) {
    return new ProviderError('could not connect to the provider');
  }
  if (err && err.code === 'EBLOCKED') return new ProviderError('address is not public');
  return new ProviderError('the provider request failed');
}

function parseOllamaLine(line) {
  if (!line.trim()) return {};
  let obj;
  try { obj = JSON.parse(line); } catch { throw new ProviderError('malformed provider response'); }
  if (obj.error) throw new ProviderError('the provider reported an error');
  return { token: obj.message?.content || '', done: !!obj.done };
}

function parseOpenAiLine(line) {
  if (!line.startsWith('data:')) return {};
  const data = line.slice(5).trim();
  if (data === '[DONE]') return { done: true };
  let obj;
  try { obj = JSON.parse(data); } catch { throw new ProviderError('malformed provider response'); }
  if (obj.error) throw new ProviderError('the provider reported an error');
  return { token: obj.choices?.[0]?.delta?.content || '' };
}

async function chat({ provider, model, messages, signal, onToken, maxChars = DEFAULT_MAX_CHARS, timeoutMs }) {
  const sig = timedSignal(provider, signal, timeoutMs);
  const ollama = provider.kind === 'ollama';
  const url = ollama ? `${baseOf(provider)}/api/chat` : openAiUrl(provider, '/chat/completions');
  let res;
  try {
    res = await aiRequest(url, {
      method: 'POST',
      headers: authHeaders(provider),
      body: { model, messages, stream: true },
      signal: sig,
      allowPrivate: provider.scope === 'site',
    });
  } catch (err) { throw toProviderError(err, sig); }

  if (res.statusCode !== 200) {
    await readBody(res, MAX_ERROR_BODY).catch(() => '');
    throw new ProviderError(`the provider answered HTTP ${res.statusCode}`);
  }

  const parse = ollama ? parseOllamaLine : parseOpenAiLine;
  let text = '';
  let truncated = false;
  try {
    for await (const line of readLines(res)) {
      const { token, done } = parse(line);
      if (token) {
        text += token;
        if (text.length > maxChars) {
          text = text.slice(0, maxChars);
          truncated = true;
          if (onToken) onToken('', text);
          res.destroy();
          break;
        }
        if (onToken) onToken(token, text);
      }
      if (done) break;
    }
  } catch (err) {
    if (truncated) return { text, truncated };
    throw toProviderError(err, sig);
  }
  return { text, truncated };
}

async function listModels(provider, { signal, timeoutMs } = {}) {
  const sig = timedSignal(provider, signal, timeoutMs);
  const ollama = provider.kind === 'ollama';
  const url = ollama ? `${baseOf(provider)}/api/tags` : openAiUrl(provider, '/models');
  let res;
  try {
    res = await aiRequest(url, { headers: authHeaders(provider), signal: sig, allowPrivate: provider.scope === 'site' });
  } catch (err) { throw toProviderError(err, sig); }
  if (res.statusCode !== 200) {
    await readBody(res, MAX_ERROR_BODY).catch(() => '');
    throw new ProviderError(`the provider answered HTTP ${res.statusCode}`);
  }
  let data;
  try { data = JSON.parse(await readBody(res, MAX_JSON_BODY)); } catch (err) { throw toProviderError(err, sig); }
  const names = ollama ? (data.models || []).map((m) => m.name) : (data.data || []).map((m) => m.id);
  return [...new Set(names.filter((n) => typeof n === 'string' && n))].sort().slice(0, 500);
}

module.exports = { ProviderError, chat, listModels };

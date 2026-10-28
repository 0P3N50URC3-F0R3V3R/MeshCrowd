// Shared helpers for the tour recorders: a tiny cookie-jar API client for talking to a throwaway server.
export const BASE = process.env.TOUR_BASE || 'http://localhost:8099';
export const PASSWORD = 'tourpass123';

export class Client {
  constructor(name) { this.name = name; this.cookie = ''; this.user = null; }

  async req(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (this.cookie) init.headers.cookie = this.cookie;
    if (body !== undefined) {
      if (body instanceof FormData) init.body = body;
      else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    }
    const res = await fetch(BASE + path, init);
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return json;
  }

  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }

  async register(username, displayName) {
    const r = await this.post('/api/auth/register', { username, displayName, email: `${username}@demo.local`, password: PASSWORD });
    this.user = r.user;
    return r.user;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

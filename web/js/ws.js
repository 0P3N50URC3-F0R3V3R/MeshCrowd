import { bus } from './bus.js';

let socket = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let pingTimer = null;
let manuallyClosed = false;

function connect() {
  manuallyClosed = false;
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${wsProtocol}//${location.host}/ws`;
  socket = new WebSocket(url);

  socket.addEventListener('open', () => {
    reconnectDelay = 1000;
    bus.emit('ws:open');
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), 25000);
  });

  socket.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (!msg || typeof msg.type !== 'string' || msg.type === 'pong') return;
    bus.emit('ws:message', msg);
    bus.emit(`ws:${msg.type}`, msg);
  });

  socket.addEventListener('close', () => {
    clearInterval(pingTimer);
    bus.emit('ws:close');
    if (!manuallyClosed) scheduleReconnect();
  });

  const thisSocket = socket;
  thisSocket.addEventListener('error', () => {
    thisSocket.close();
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
    connect();
  }, reconnectDelay);
}

// Skips the backoff wait and reconnects immediately if not already open/connecting. A backgrounded
// mobile WebView can sit disconnected well past its normal backoff window (the OS throttles JS
// timers while hidden), so the native host calls this on resume instead of waiting for the timer.
function reconnectNow() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  reconnectDelay = 1000;
  connect();
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function disconnect() {
  manuallyClosed = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  socket?.close();
}

function sendTyping(scopeType, scopeId) {
  send({ type: 'typing', scopeType, scopeId });
}

export const ws = { connect, disconnect, send, sendTyping, reconnectNow };

// Native app hosts (currently just the Android WebView wrapper) call this directly by name
// rather than importing the module, since they inject a plain evaluateJavascript snippet.
window.__dismeshForceReconnect = reconnectNow;

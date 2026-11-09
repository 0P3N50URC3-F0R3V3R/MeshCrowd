(() => {
  if (window.top !== window || !window.chrome || !window.chrome.webview || window.dismeshClient) return;
  const wv = window.chrome.webview;
  const pending = new Map();
  const listeners = {};
  let nextId = 0;
  let windowState = { hidden: false, focused: true, notifyWhenHidden: true, notifyWhenUnfocused: false };

  wv.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'result') {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p(m.value); }
    } else if (m.type === 'event') {
      if (m.name === 'dismesh:window-state') windowState = m.data;
      for (const cb of listeners[m.name] || []) cb(m.data);
    }
  });

  const invoke = (channel, arg) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    wv.postMessage({ type: 'invoke', id, channel, arg });
  });
  const send = (channel, arg) => wv.postMessage({ type: 'send', channel, arg });
  const on = (name, cb) => { (listeners[name] ||= []).push(cb); };

  // A toast click only runs the page's onclick; the native window (maybe hidden to the tray) must be raised too.
  const NativeNotification = window.Notification;
  if (NativeNotification) {
    const Wrapped = function Notification(title, options) {
      const n = new NativeNotification(title, options);
      n.addEventListener('click', () => send('dismesh:show-window'));
      return n;
    };
    Wrapped.prototype = NativeNotification.prototype;
    Object.defineProperty(Wrapped, 'permission', { get: () => NativeNotification.permission });
    Wrapped.requestPermission = (...a) => NativeNotification.requestPermission(...a);
    Object.defineProperty(Wrapped, 'maxActions', { get: () => NativeNotification.maxActions });
    window.Notification = Wrapped;
  }

  // Electron's titleBarOverlay exposes env(titlebar-area-*); here the native min/max/close buttons
  // (3 x 46px) sit over the right end of the top bar, so reserve their width explicitly.
  document.addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = '.app-topbar { padding-right: 146px !important; }';
    document.head.appendChild(st);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); send('dismesh:f11'); }
  }, true);

  Object.defineProperty(window, 'dismeshClient', {
    value: Object.freeze({
      isUserLooking: () => !(windowState.hidden && windowState.notifyWhenHidden) && !(!windowState.focused && windowState.notifyWhenUnfocused),
      getConfig: () => invoke('dismesh:get-config'),
      setServer: (url) => invoke('dismesh:set-server', url),
      forgetServer: () => invoke('dismesh:forget-server'),
      retryConnect: () => invoke('dismesh:retry-connect'),
      getNetworkInterfaces: () => invoke('dismesh:get-network-interfaces'),
      openExternal: (url) => invoke('dismesh:open-external', url),

      getAppSettings: () => invoke('dismesh:get-app-settings'),
      setAppSettings: (settings) => invoke('dismesh:set-app-settings', settings),
      pushNotification: (n) => send('dismesh:push-notification', n),
      clearNotifications: (keys) => send('dismesh:clear-notifications', keys),
      setTrayLabels: (labels) => send('dismesh:set-tray-labels', labels),
      setTrayBadge: (badge) => send('dismesh:set-tray-badge', badge),
      selectDownloadDir: () => invoke('dismesh:select-download-dir'),
      showDownload: (id) => invoke('dismesh:show-download', id),
      openDownload: (id) => invoke('dismesh:open-download', id),
      cancelDownload: (id) => invoke('dismesh:cancel-download', id),
      openDownloadDir: () => invoke('dismesh:open-download-dir'),
      onDownloadEvent: (cb) => on('dismesh:download-event', cb),
      onNavigateTo: (cb) => on('dismesh:navigate-to', cb),
      onRequestLogout: (cb) => on('dismesh:request-logout', cb),
    }),
  });
})();

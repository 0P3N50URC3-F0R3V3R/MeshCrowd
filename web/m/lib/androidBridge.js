// The APK's WebView exposes window.MeshCrowdAndroid (see the shell spec); plain browsers don't.
export function androidBridge() {
  const b = window.MeshCrowdAndroid;
  if (!b || typeof b.getSettings !== 'function') return null;
  return {
    getSettings() { try { return JSON.parse(b.getSettings()); } catch { return { pollMinutes: 15, fastMode: false }; } },
    setPollMinutes(n) { b.setPollMinutes(Math.max(1, Math.round(n))); },
    setFastMode(on) { b.setFastMode(!!on); },
    changeServer() { b.changeServer(); },
    openBatterySettings() { b.openBatterySettings(); },
    // Voice/video: keeps the process alive and routes call audio. Older APKs lack these, so guard each.
    setInCall(on) { if (typeof b.setInCall === 'function') b.setInCall(!!on); },
    setSpeaker(on) { if (typeof b.setSpeaker === 'function') b.setSpeaker(!!on); },
    hasCallSupport: typeof b.setInCall === 'function',
    // "Send to MeshCrowd" (Android share target); older APKs lack these.
    hasShareSupport: typeof b.takeShare === 'function',
    takeShare() { try { return b.takeShare() || ''; } catch { return ''; } },
    setShareTargets(list) { try { if (typeof b.setShareTargets === 'function') b.setShareTargets(JSON.stringify(list)); } catch { /* not in the app */ } },
    finishShare() { try { b.finishShare(); } catch { /* not in the app */ } },
    // Notifications while the app is on screen (older APKs lack these).
    hasNativeNotify: typeof b.setOpenScope === 'function',
    setOpenScope(scope) { if (typeof b.setOpenScope === 'function') b.setOpenScope(scope); },
    checkNotifications() { if (typeof b.checkNotifications === 'function') b.checkNotifications(); },
    // UnifiedPush (older APKs lack these).
    hasPushSupport: typeof b.pushEnable === 'function',
    pushDistributors() { try { return JSON.parse(b.pushDistributors()); } catch { return []; } },
    pushEnable(id) { return !!b.pushEnable(id || ''); },
    pushDisable() { b.pushDisable(); },
  };
}

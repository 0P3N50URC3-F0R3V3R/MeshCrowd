// Call lifecycle for voice rooms, kept free of DOM so it can be unit-tested. A user is in at most one
// voice room at a time, and the call (with its engine) outlives the view that mounted it: navigating
// elsewhere only detaches the UI, the engine is stopped only when the call is left.
// Toast for a voice_join_denied reason; null ends the call quietly ('cancelled': the join was
// overtaken by this user's call ending on another connection). 'moved': the same user joined the
// call from another tab or device.
const DENIED_TOASTS = { invisible: 'voice.joinDeniedInvisible', update_required: 'voice.updateRequired', sfu_unavailable: 'voice.sfuUnavailable', moved: 'voice.callMovedToast', no_access: 'voice.noAccessToast' };
export const joinDeniedToastKey = (reason) => (reason === 'cancelled' ? null : DENIED_TOASTS[reason] || 'voice.joinDeniedToast');

export const callKey = ({ dmId, channelId }) => (dmId ? `dm:${dmId}` : `ch:${channelId}`);

export function createCallRegistry() {
  let active = null; // { key, attach(container), leave() }
  return {
    active: () => active,
    mount(key, container, create) {
      if (active && active.key === key) return active.attach(container);
      return create(container);
    },
    leaveActive: () => active?.leave(),
    leaveOthers(key) { if (active && active.key !== key) active.leave(); },
    set(call) { active = call; },
    clear(key) { if (active?.key === key) active = null; },
  };
}

// Per-mount state: `joined`, `detached` and the engine of this room's call.
export function createCallMount(registry, key) {
  const m = {
    key,
    joined: false,
    detached: false,
    engine: null,
    beginJoin() {
      if (m.joined) return false;
      m.joined = true;
      return true;
    },
    cancelJoin() { m.joined = false; },
    // One room per user: called once the mic is up, so a failed mic leaves the other call running.
    activate({ attach, leave }) {
      registry.leaveOthers(key);
      registry.set({ key, attach, leave });
    },
    // The engine is picked once the room's mode is known (first voice_state that includes me).
    setEngine(engine) {
      if (!m.joined) { engine.stop(); return false; }
      m.engine = engine;
      return true;
    },
    // Reconnect, SFU reset and connection retry replace the engine without leaving the call.
    dropEngine() {
      const engine = m.engine;
      m.engine = null;
      engine?.stop();
    },
    end() {
      m.joined = false;
      registry.clear(key);
      const engine = m.engine;
      m.engine = null;
      engine?.stop();
    },
    // Returns true when the view may be torn down for real; a joined call only detaches.
    detach() {
      if (!m.joined) return true;
      m.detached = true;
      return false;
    },
    attach() { m.detached = false; },
  };
  return m;
}

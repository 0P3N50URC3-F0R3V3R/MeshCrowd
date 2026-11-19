import test from 'node:test';
import assert from 'node:assert/strict';
import { callKey, createCallRegistry, createCallMount, joinDeniedToastKey } from './callLifecycle.mjs';

const fakeEngine = () => ({ stopped: false, stop() { this.stopped = true; } });

// Mirrors how views/voice.js wires a mount: join activates an engine, leave ends the call, and
// destroy() tears the view down only when not joined.
function mountRoom(registry, opts) {
  const key = callKey(opts);
  const call = createCallMount(registry, key);
  const view = { container: null, destroyed: false };
  const handle = {
    call,
    view,
    join({ micOk = true } = {}) {
      if (!call.beginJoin()) return;
      if (!micOk) { call.cancelJoin(); return; }
      call.activate({ attach: handle.attach, leave: () => { if (call.joined) handle.leave(); } });
      call.setEngine(fakeEngine());
    },
    leave() {
      call.end();
      if (call.detached) handle.destroy();
    },
    destroy() {
      if (!call.detach()) return;
      view.destroyed = true;
    },
    attach(container) {
      view.container = container;
      call.attach();
      return handle;
    },
  };
  return registry.mount(key, 'c0', (container) => { view.container = container; return handle; });
}

test('callKey distinguishes DM calls from channel calls', () => {
  assert.equal(callKey({ channelId: 4 }), 'ch:4');
  assert.equal(callKey({ dmId: 4 }), 'dm:4');
});

test('detaching the view of a joined call keeps the engine running', () => {
  const registry = createCallRegistry();
  const a = mountRoom(registry, { channelId: 1 });
  a.join();
  const engine = a.call.engine;
  a.destroy();
  assert.equal(a.view.destroyed, false);
  assert.equal(a.call.detached, true);
  assert.equal(engine.stopped, false);
  assert.equal(registry.active().key, 'ch:1');
});

test('re-attaching the same room reuses the running call and its engine', () => {
  const registry = createCallRegistry();
  const a = mountRoom(registry, { channelId: 1 });
  a.join();
  const engine = a.call.engine;
  a.destroy();
  const again = mountRoom(registry, { channelId: 1 });
  assert.equal(again, a);
  assert.equal(again.view.container, 'c0');
  assert.equal(again.call.detached, false);
  assert.equal(again.call.engine, engine);
  assert.equal(engine.stopped, false);
});

test('joining a second room leaves the first and stops its engine', () => {
  const registry = createCallRegistry();
  const a = mountRoom(registry, { channelId: 1 });
  a.join();
  const engineA = a.call.engine;
  a.destroy();
  const b = mountRoom(registry, { dmId: 9 });
  assert.notEqual(b, a);
  b.join();
  assert.equal(engineA.stopped, true);
  assert.equal(a.call.joined, false);
  assert.equal(a.view.destroyed, true, 'the detached first view is torn down once its call ends');
  assert.equal(registry.active().key, 'dm:9');
  assert.equal(b.call.engine.stopped, false);
});

test('leaving stops the engine and clears the active call', () => {
  const registry = createCallRegistry();
  const a = mountRoom(registry, { channelId: 1 });
  a.join();
  const engine = a.call.engine;
  registry.leaveActive();
  assert.equal(engine.stopped, true);
  assert.equal(registry.active(), null);
  assert.equal(a.view.destroyed, false, 'an attached view stays after leaving');
});

test('a second-room join whose mic fails keeps the current call', () => {
  const registry = createCallRegistry();
  const a = mountRoom(registry, { channelId: 1 });
  a.join();
  const engineA = a.call.engine;
  a.destroy();
  const b = mountRoom(registry, { channelId: 2 });
  b.join({ micOk: false });
  assert.equal(engineA.stopped, false);
  assert.equal(a.call.joined, true);
  assert.equal(b.call.joined, false);
  assert.equal(registry.active().key, 'ch:1');
});

test('dropEngine stops the engine but keeps the call; setEngine after end stops the late engine', () => {
  const registry = createCallRegistry();
  const a = mountRoom(registry, { channelId: 1 });
  a.join();
  const first = a.call.engine;
  a.call.dropEngine();
  assert.equal(first.stopped, true);
  assert.equal(a.call.engine, null);
  assert.equal(a.call.joined, true);
  assert.equal(registry.active().key, 'ch:1');
  registry.leaveActive();
  const late = fakeEngine();
  assert.equal(a.call.setEngine(late), false);
  assert.equal(late.stopped, true);
  assert.equal(a.call.engine, null);
});

test('a cancelled join ends the call without a toast; other denials keep theirs', () => {
  assert.equal(joinDeniedToastKey('cancelled'), null);
  assert.equal(joinDeniedToastKey('update_required'), 'voice.updateRequired');
  assert.equal(joinDeniedToastKey('sfu_unavailable'), 'voice.sfuUnavailable');
  assert.equal(joinDeniedToastKey('moved'), 'voice.callMovedToast');
  assert.equal(joinDeniedToastKey('no_access'), 'voice.noAccessToast');
  assert.equal(joinDeniedToastKey(undefined), 'voice.joinDeniedToast');
});

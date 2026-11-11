// Runs the real public/app.js against stubbed browser APIs (no browser needed) to check
// the peer-recovery logic. Run with: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Any DOM element/property the page touches: chainable, harmless.
function anyStub() {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_t, key) => {
      if (key === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (key === 'style' || key === 'dataset') return {};
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'then') return undefined;
      return anyStub();
    },
    apply: () => anyStub(),
    set: () => true,
  });
}

// A fake navigator.wakeLock that counts requests and hands out locks the test can inspect.
function fakeWakeLock() {
  const api = {
    requests: 0,
    locks: [],
    refuse: false,
    async request(kind) {
      api.requests += 1;
      if (api.refuse) throw new Error('NotAllowedError');
      const lock = {
        kind,
        released: false,
        handlers: [],
        addEventListener(type, fn) { if (type === 'release') lock.handlers.push(fn); },
        async release() { lock.fire(); },
        // Also what the browser does by itself when the page is hidden.
        fire() {
          if (lock.released) return;
          lock.released = true;
          for (const fn of lock.handlers) fn();
        },
      };
      api.locks.push(lock);
      return lock;
    },
    held: () => api.locks.filter((l) => !l.released).length,
  };
  return api;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function loadPage({ wakeLock, storage = {} } = {}) {
  const timers = [];
  let clock = 0;
  const sockets = [];
  const connections = [];

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      this.handlers = {};
      this.closed = false;
      sockets.push(this);
    }
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; this.readyState = 3; }
    async deliver(msg) { for (const fn of this.handlers.message || []) await fn({ data: JSON.stringify(msg) }); }
  }
  FakeSocket.OPEN = 1;

  class FakeConnection {
    constructor() {
      this.signalingState = 'stable';
      this.iceConnectionState = 'new';
      this.remoteDescription = null;
      this.localDescription = null;
      this.closed = false;
      this.handlers = {};
      connections.push(this);
    }
    addTrack() {}
    getSenders() { return []; }
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
    close() { this.closed = true; }
    async setRemoteDescription(desc) { this.remoteDescription = desc; this.signalingState = 'have-remote-offer'; }
    async createAnswer() { return { type: 'answer', sdp: 'x' }; }
    async createOffer() { return { type: 'offer', sdp: 'x' }; }
    async setLocalDescription(desc) { this.localDescription = desc; }
    async addIceCandidate() {}
    setIce(state) {
      this.iceConnectionState = state;
      for (const fn of this.handlers.iceconnectionstatechange || []) fn();
    }
  }

  const track = { enabled: true, readyState: 'live', kind: 'audio', addEventListener() {}, stop() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };

  // The document: visibility is controllable, everything else is a harmless stub.
  const doc = { hidden: false, listeners: {} };
  const documentStub = new Proxy({}, {
    get: (_t, key) => {
      if (key === 'hidden') return doc.hidden;
      if (key === 'addEventListener') return (type, fn) => { (doc.listeners[type] = doc.listeners[type] || []).push(fn); };
      return anyStub();
    },
  });
  const setHidden = (hidden) => {
    doc.hidden = hidden;
    // The browser takes the wake lock away when the page is hidden.
    if (hidden && wakeLock) for (const lock of wakeLock.locks) lock.fire();
    for (const fn of doc.listeners.visibilitychange || []) fn();
  };

  const navigatorStub = { mediaDevices: { getUserMedia: async () => stream } };
  if (wakeLock) navigatorStub.wakeLock = wakeLock;

  const context = vm.createContext({
    document: documentStub,
    window: anyStub(),
    navigator: navigatorStub,
    localStorage: {
      getItem: (key) => (key in storage ? storage[key] : null),
      setItem(key, value) { storage[key] = String(value); },
      removeItem(key) { delete storage[key]; },
    },
    location: { host: 'test.local', reload() {} },
    WebSocket: FakeSocket,
    RTCPeerConnection: FakeConnection,
    Audio: class { constructor() { this.muted = false; } },
    alert() {},
    console,
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock + (ms || 0) }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    Float32Array,
    Map, Set, Promise, JSON, Math, Error, Array, Object, String, Number, Boolean,
  });
  vm.runInContext(SOURCE, context, { filename: 'app.js' });

  const run = (code) => vm.runInContext(code, context);
  const advance = (ms) => {
    clock += ms;
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (t.at <= clock) t.fn(); else timers.push(t);
    }
  };
  await run("join('Test')");
  const sock = sockets[sockets.length - 1];
  const open = async () => {
    for (const fn of sock.handlers.open || []) fn();
    await settle();
  };
  return { run, sock, sockets, connections, advance, setHidden, open, storage };
}

test('one failed connection is retried on its own; healthy connections and the session stay up', async () => {
  const page = await loadPage();
  await page.sock.deliver({ type: 'welcome', id: 'mmm' });
  // 'aaa' sorts before us (it should call us, as the gateway does), 'zzz' sorts after us.
  await page.sock.deliver({ type: 'peers', peers: [{ id: 'aaa', name: 'Radio' }, { id: 'zzz', name: 'Other' }] });
  const [failing, healthy] = [page.run("peers.get('aaa')"), page.run("peers.get('zzz')")];
  assert.ok(failing && healthy);

  failing.setIce('failed');
  assert.equal(page.run("peers.has('aaa')"), false, 'the failed connection is removed');
  page.advance(8100);

  assert.equal(page.sockets.length, 1, 'the session must not be rebuilt for one bad peer');
  assert.equal(page.sock.closed, false);
  assert.equal(healthy.closed, false, 'a healthy connection was closed');
  assert.equal(page.run("peers.has('aaa')"), true, 'the failed peer was not retried');
  assert.equal(page.connections.filter((c) => c !== failing && c !== healthy).length, 1);
});

test('retries back off and stop once the peer is gone from the roster', async () => {
  const page = await loadPage();
  await page.sock.deliver({ type: 'welcome', id: 'mmm' });
  await page.sock.deliver({ type: 'peers', peers: [{ id: 'aaa', name: 'Radio' }] });
  page.run("peers.get('aaa')").setIce('failed');
  await page.sock.deliver({ type: 'peers', peers: [] }); // it left
  page.advance(60000);
  assert.equal(page.run("peers.has('aaa')"), false, 'retried a peer that is no longer there');
});

test('simultaneous offers: the lower id wins, nobody is left with a broken connection', async () => {
  const page = await loadPage();
  await page.sock.deliver({ type: 'welcome', id: 'mmm' });
  await page.sock.deliver({ type: 'peers', peers: [{ id: 'zzz', name: 'Higher' }] });
  const ours = page.run("peers.get('zzz')");
  ours.signalingState = 'have-local-offer';
  // Their offer arrives while ours is pending. We have the lower id, so ours wins and theirs is ignored.
  await page.sock.deliver({ type: 'offer', from: 'zzz', sdp: { type: 'offer', sdp: 'x' } });
  assert.equal(ours.closed, false);
  assert.equal(page.run("peers.get('zzz')"), ours);

  // Now the other way round: we have the higher id, so we give way and answer theirs.
  const page2 = await loadPage();
  await page2.sock.deliver({ type: 'welcome', id: 'mmm' });
  await page2.sock.deliver({ type: 'peers', peers: [{ id: 'aaa', name: 'Lower' }] });
  const stale = page2.run("peers.get('aaa')");
  stale.signalingState = 'have-local-offer';
  await page2.sock.deliver({ type: 'offer', from: 'aaa', sdp: { type: 'offer', sdp: 'x' } });
  assert.equal(stale.closed, true, 'our losing offer should have been dropped');
  const answered = page2.sock.sent.filter((m) => m.type === 'answer');
  assert.equal(answered.length, 1, 'we should have answered their offer');
});

// --- Screen wake lock ---

test('wake lock: taken once the socket opens, not before, and never requested twice', async () => {
  const wakeLock = fakeWakeLock();
  const page = await loadPage({ wakeLock });
  assert.equal(wakeLock.requests, 0, 'no lock before the session is up');
  await page.open();
  assert.equal(wakeLock.requests, 1);
  assert.equal(wakeLock.locks[0].kind, 'screen');
  assert.equal(wakeLock.held(), 1);

  // More reasons to want the lock while it is already held (or still being asked for).
  page.run('updateWakeLock(); updateWakeLock(); noteActivity()');
  await settle();
  assert.equal(wakeLock.requests, 1, 'a second request was made while one lock is held');
});

test('wake lock: asked for again when the page comes back to the foreground', async () => {
  const wakeLock = fakeWakeLock();
  const page = await loadPage({ wakeLock });
  await page.open();
  page.setHidden(true);
  await settle();
  assert.equal(wakeLock.held(), 0);
  assert.equal(wakeLock.requests, 1, 'must not ask while hidden');
  page.setHidden(false);
  await settle();
  assert.equal(wakeLock.requests, 2);
  assert.equal(wakeLock.held(), 1);
});

test('wake lock: re-acquired if the browser releases it while the page is visible', async () => {
  const wakeLock = fakeWakeLock();
  const page = await loadPage({ wakeLock });
  await page.open();
  wakeLock.locks[0].fire();
  await settle();
  assert.equal(wakeLock.held(), 1);
});

test('wake lock: "during conversations" releases 10 minutes after the last activity', async () => {
  const wakeLock = fakeWakeLock();
  const page = await loadPage({ wakeLock, storage: { 'walkie-wake': 'active' } });
  await page.open();
  await page.sock.deliver({ type: 'welcome', id: 'mmm' });
  assert.equal(wakeLock.held(), 1);

  page.advance(9 * 60 * 1000);
  await page.sock.deliver({ type: 'floor', holder: 'aaa', name: 'Radio' }); // activity restarts the window
  page.advance(30 * 60 * 1000);
  assert.equal(wakeLock.held(), 1, 'released while someone was still talking');

  await page.sock.deliver({ type: 'floor', holder: null });
  page.advance(9 * 60 * 1000);
  assert.equal(wakeLock.held(), 1, 'released before the idle window ended');
  page.advance(2 * 60 * 1000);
  assert.equal(wakeLock.held(), 0, 'still held after 10 idle minutes');

  // New activity takes it again.
  await page.sock.deliver({ type: 'floor', holder: 'aaa', name: 'Radio' });
  await settle();
  assert.equal(wakeLock.held(), 1);
});

test('wake lock: "always" keeps it through idle time and through a reconnect', async () => {
  const wakeLock = fakeWakeLock();
  const page = await loadPage({ wakeLock });
  await page.open();
  page.advance(60 * 60 * 1000);
  assert.equal(wakeLock.held(), 1);
  page.run('scheduleReconnect()');
  await settle();
  assert.equal(wakeLock.held(), 1, 'the screen must stay on while reconnecting');
});

test('wake lock: "off" never asks; changing the mode applies at once and is remembered', async () => {
  const wakeLock = fakeWakeLock();
  const page = await loadPage({ wakeLock, storage: { 'walkie-wake': 'off' } });
  await page.open();
  assert.equal(wakeLock.requests, 0);

  page.run("setWakeMode('always')");
  await settle();
  assert.equal(wakeLock.held(), 1);
  assert.equal(page.storage['walkie-wake'], 'always');

  page.run("setWakeMode('off')");
  await settle();
  assert.equal(wakeLock.held(), 0);
  page.run("setWakeMode('nonsense')");
  assert.equal(page.storage['walkie-wake'], 'off', 'an unknown mode must be ignored');
});

test('wake lock: a refused request is not retried in a loop, only on the next activity', async () => {
  const wakeLock = fakeWakeLock();
  wakeLock.refuse = true;
  const page = await loadPage({ wakeLock });
  await page.open();
  await settle();
  assert.equal(wakeLock.requests, 1);
  wakeLock.refuse = false;
  page.run('noteActivity()');
  await settle();
  assert.equal(wakeLock.held(), 1);
});

test('wake lock: a browser without the API still works', async () => {
  const page = await loadPage();
  await page.open();
  await page.sock.deliver({ type: 'welcome', id: 'mmm' });
  await page.sock.deliver({ type: 'floor', holder: 'aaa', name: 'Radio' });
  page.setHidden(true);
  page.setHidden(false);
  page.run("setWakeMode('active'); noteActivity()");
  assert.deepEqual(page.sock.sent[0], { type: 'join', name: 'Test' });
});

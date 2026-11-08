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

async function loadPage() {
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

  const context = vm.createContext({
    document: anyStub(),
    window: anyStub(),
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
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
  return { run, sock, sockets, connections, advance };
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

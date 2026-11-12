// The admin API (lib/admin.js) against a real server with a prepared database,
// and public/admin.js run against a small fake DOM. Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createStore } = require('../lib/store');
const { groupConversations, csvCell, toCsv } = require('../lib/admin');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* older Node: no database, so nothing to serve */ }
const skip = sqlite ? false : 'node:sqlite is not available in this Node version';

const TOKEN = 'admin-token-0123456789abcdef';
const MIN = 60 * 1000;
// A fixed day, far enough back that the server's "now" is never inside it.
const DAY = Date.UTC(2026, 10, 10, 0, 0, 0);
const DAY2 = DAY - 2 * 24 * 60 * MIN; // two days earlier
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36';

// Radio and a phone talk in the morning (one conversation, 3 turns); the phone
// drops; the radio then calls twice more to nobody, and once in the evening.
function seed(dir) {
  const store = createStore({ dir, log: { error() {} } });
  const at = (minutes, seconds = 0) => DAY + 8 * 60 * MIN + minutes * MIN + seconds * 1000;
  store.sessionStart({ connId: 'radio01', ip: '10.0.0.5', ua: 'Python/3.12', ts: at(0) });
  store.sessionJoin({ connId: 'radio01', deviceId: 'cli-gateway0001', name: 'Radio', role: 'gateway', ua: 'Python/3.12', ts: at(0, 1) });
  store.sessionStart({ connId: 'phone01', ip: '10.0.0.9', ua: PHONE_UA, origin: 'https://walkie.test', ts: at(1) });
  store.sessionJoin({ connId: 'phone01', deviceId: 'device-phone-0001', name: '=Mom', role: 'browser', ua: PHONE_UA, ts: at(1, 1) });
  store.sessionStart({ connId: 'probe01', ip: '10.0.0.77', ua: 'curl', ts: at(2) }); // never joins
  store.sessionEnd({ connId: 'probe01', reason: 'closed', code: 1000, ts: at(2, 1) });

  const tx = (id, connId, name, role, start, seconds, audible, reason = 'ptt-stop') => {
    store.txStart({ tx: id, connId, name, role, priority: role === 'gateway', listeners: 1, listenersAudible: audible, ts: start });
    store.txEnd({ tx: id, reason, listenersAudible: audible, ts: start + seconds * 1000 });
  };
  tx('t1', 'radio01', 'Radio', 'gateway', at(10), 20, 1);
  tx('t2', 'phone01', '=Mom', 'browser', at(10, 30), 10, 0);
  tx('t3', 'radio01', 'Radio', 'gateway', at(11), 40, 1);
  store.sessionEnd({ connId: 'phone01', reason: 'dead-connection', code: 1006, ts: at(12) });
  tx('t4', 'radio01', 'Radio', 'gateway', at(15), 47, 0);
  tx('t5', 'radio01', 'Radio', 'gateway', at(15, 50), 29, 0); // 3 s after t4 ended: same conversation
  tx('t6', 'radio01', 'Radio', 'gateway', DAY + 20 * 60 * MIN, 5, 0, 'timeout');
  store.sessionEnd({ connId: 'radio01', reason: 'closed', code: 1000, ts: DAY + 21 * 60 * MIN });
  store.event('seeded', null, {}, DAY + 21 * 60 * MIN);

  // A second day: the gateway is cut off at 09:00 and is back at 09:02; a
  // listener (Dad) is connected all morning and never talks; Mom talks once
  // while the gateway is up and once while it is down.
  const at2 = (minutes, seconds = 0) => DAY2 + 8 * 60 * MIN + minutes * MIN + seconds * 1000;
  store.sessionStart({ connId: 'gwA', ip: '10.0.0.5', ua: 'Python/3.12', ts: at2(0) });
  store.sessionJoin({ connId: 'gwA', deviceId: 'cli-gateway0001', name: 'Radio', role: 'gateway', ua: 'Python/3.12', ts: at2(0, 1) });
  store.sessionStart({ connId: 'dad', ip: '10.0.0.8', ua: PHONE_UA, origin: 'https://walkie.test', ts: at2(5) });
  store.sessionJoin({ connId: 'dad', deviceId: 'device-dad-00001', name: 'Dad', role: 'browser', ua: PHONE_UA, ts: at2(5, 1) });
  store.sessionStart({ connId: 'mom2', ip: '10.0.0.9', ua: PHONE_UA, origin: 'https://walkie.test', ts: at2(6) });
  store.sessionJoin({ connId: 'mom2', deviceId: 'device-phone-0001', name: 'Mom', role: 'browser', ua: PHONE_UA, ts: at2(6, 1) });
  tx('u1', 'mom2', 'Mom', 'browser', at2(10), 10, 2); // gateway up
  tx('u2', 'gwA', 'Radio', 'gateway', at2(10, 30), 20, 2); // same conversation: mixed
  store.sessionEnd({ connId: 'gwA', reason: 'dead-connection', code: 1006, ts: at2(60) });
  tx('u3', 'mom2', 'Mom', 'browser', at2(61), 8, 2); // gateway down: the radio never got it
  store.sessionStart({ connId: 'gwB', ip: '10.0.0.5', ua: 'Python/3.12', ts: at2(62) });
  store.sessionJoin({ connId: 'gwB', deviceId: 'cli-gateway0001', name: 'Radio', role: 'gateway', ua: 'Python/3.12', ts: at2(62, 1) });
  tx('u4', 'gwB', 'Radio', 'gateway', at2(90), 30, 0); // radio talk with nobody on the app
  store.sessionEnd({ connId: 'gwB', reason: 'closed', code: 1000, ts: at2(120) });
  store.sessionEnd({ connId: 'dad', reason: 'closed', code: 1000, ts: at2(120) });
  store.sessionEnd({ connId: 'mom2', reason: 'closed', code: 1000, ts: at2(120) });
  store.close();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), ADMIN_TOKEN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle = { port, child, out: '' };
  child.stdout.on('data', (d) => { handle.out += d; });
  child.stderr.on('data', (d) => { handle.out += d; });
  const end = Date.now() + 15000;
  while (!handle.out.includes(' listening ')) {
    if (Date.now() > end) { child.kill(); throw new Error('server did not start'); }
    await new Promise((r) => setTimeout(r, 50));
  }
  return handle;
}

function get(server, pathname, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: server.port, path: pathname, method, headers, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* not JSON (CSV, HTML) */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let open; // server without a token
let locked; // server with a token
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-admin-'));

before(async () => {
  if (skip) return;
  seed(dataDir);
  open = await startServer({ DATA_DIR: dataDir });
  locked = await startServer({ DATA_DIR: dataDir, ADMIN_TOKEN: TOKEN });
});

after(() => {
  for (const s of [open, locked]) if (s) s.child.kill();
});

const RANGE = `from=${DAY}&to=${DAY + 24 * 60 * MIN}`;

// ---------- pure pieces ----------

test('conversations: transmissions closer than the gap are one conversation', () => {
  const t = (id, start, heldS, name = 'A', device = name) => ({ id, started_at: start, ended_at: start + heldS * 1000, held_ms: heldS * 1000, name, device_id: device });
  const list = [t('1', 0, 10, 'Radio'), t('2', 30000, 5, 'Mom'), t('3', 95000, 5, 'Radio'), t('4', 161000, 5, 'Radio')];
  // gaps: 20 s, 60 s exactly (still the same conversation), 61 s (a new one)
  const groups = groupConversations(list, 60000);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].turns, 3);
  assert.equal(groups[0].length_ms, 100000);
  assert.equal(groups[0].talk_ms, 20000);
  assert.deepEqual(groups[0].participants.map((p) => [p.name, p.turns, p.talk_ms]), [['Radio', 2, 15000], ['Mom', 1, 5000]]);
  assert.equal(groups[1].turns, 1);
  assert.deepEqual(groupConversations([], 60000), []);
});

test('CSV: quoting, and text that a spreadsheet would run as a formula is defused', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(-5), '-5', 'a real negative number must stay a number');
  assert.equal(csvCell('=HYPERLINK("http://x")'), '"\'=HYPERLINK(""http://x"")"');
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(toCsv(['a', 'b'], [{ a: 1, b: 'x\ny' }]), 'a,b\r\n1,"x\ny"\r\n');
});

// ---------- the API ----------

test('range: totals, per-device numbers and conversations match the data', { skip }, async () => {
  const res = await get(open, `/api/admin/range?${RANGE}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const d = res.json;
  assert.equal(d.truncated, false);
  assert.equal(d.conversation_gap_s, 60);
  assert.deepEqual(d.totals, {
    talk_ms: 151000,
    transmissions: 6,
    longest: { id: 't4', name: 'Radio', started_at: DAY + 8 * 60 * MIN + 15 * MIN, held_ms: 47000 },
    sessions: 1, // people only: the probe that never joined and the gateway are not counted
    drops: 1,
    online: { sessions: 1, drops: 1, talk_ms: 10000, transmissions: 1 },
    radio: { transmissions: 5, talk_ms: 141000, unmonitored: 3, unmonitored_ms: 81000 },
    missed_by_radio: 0,
    missed_by_radio_ms: 0,
  });

  // The radio gateway is not a device: only people are listed.
  assert.equal(d.devices.length, 1);
  assert.deepEqual(d.devices[0], {
    device_id: 'device-phone-0001', name: '=Mom', role: 'browser', kind: 'phone',
    talk_ms: 10000, transmissions: 1, connected_ms: 11 * MIN, sessions: 1, drops: 1,
  });
  assert.equal(d.transmissions.filter((t) => t.origin === 'radio').length, 5);
  assert.equal(d.transmissions.find((t) => t.id === 't2').origin, 'online');

  // The gateway has its own summary: connected 08:00 to 21:00 of the 24 hours.
  assert.equal(d.gateway.known, true);
  assert.equal(d.gateway.sessions, 1);
  assert.equal(d.gateway.connected_ms, 13 * 60 * MIN);
  assert.equal(d.gateway.uptime_pct, 54.2);
  assert.deepEqual(d.gateway.outages.map((o) => [o.reason, o.back_at]), [['closed', null]]);

  assert.deepEqual(d.conversations.map((c) => [c.turns, c.talk_ms, c.participants.length]), [[3, 70000, 2], [2, 76000, 1], [1, 5000, 1]]);
  assert.deepEqual(d.conversations.map((c) => c.kind), ['mixed', 'radio', 'radio']);
  assert.equal(d.transmissions.length, 6);
  assert.equal(d.transmissions[5].end_reason, 'timeout');
  assert.equal(d.sessions.length, 3);
  assert.ok(!('recording_path' in d.transmissions[0]), 'file paths on the server are not exposed');
});

test('range: the gateway is not a person; its drop, the call the radio missed and the listener show up', { skip }, async () => {
  const d = (await get(open, `/api/admin/range?from=${DAY2}&to=${DAY2 + 24 * 60 * MIN}`)).json;
  const at2 = (minutes, seconds = 0) => DAY2 + 8 * 60 * MIN + minutes * MIN + seconds * 1000;
  assert.equal(d.totals.transmissions, 4);
  assert.deepEqual(d.totals.online, { sessions: 2, drops: 0, talk_ms: 18000, transmissions: 2 });
  assert.equal(d.totals.drops, 0, 'the gateway drop is not a people drop');
  assert.deepEqual(d.devices.map((x) => x.name).sort(), ['Dad', 'Mom']);
  assert.equal(d.gateway.sessions, 2);
  assert.equal(d.gateway.drops, 1);
  assert.deepEqual(d.gateway.outages[0], { left_at: at2(60), reason: 'dead-connection', connected_for_ms: 60 * MIN, down_ms: 2 * MIN, back_at: at2(62) });
  assert.equal(d.gateway.outages.length, 2);
  assert.equal(d.gateway.drops, 1, 'a clean stop is an outage, not a drop');
  // only u3 (spoken while the gateway was cut off) was lost; u1 was fine
  assert.deepEqual(d.gateway.missed.map((m) => m.id), ['u3']);
  assert.equal(d.totals.missed_by_radio, 1);
  assert.equal(d.totals.radio.unmonitored, 1, 'radio talk with nobody on the app is counted, not flagged');

  const [first, second] = d.conversations;
  assert.equal(first.kind, 'mixed');
  assert.deepEqual(first.listeners.map((l) => l.name), ['Dad'], 'Dad only listened; Mom talked so is not a listener');
  assert.equal(second.kind, 'online');
  assert.equal(d.conversations[2].kind, 'radio');
});

test('range: only what falls inside it; connection time is clipped to it', { skip }, async () => {
  // 08:10:15 to 08:11:30: only t2 and t3 start inside.
  const from = DAY + 8 * 60 * MIN + 10 * MIN + 15000;
  const to = from + 75000;
  const d = (await get(open, `/api/admin/range?from=${from}&to=${to}`)).json;
  assert.deepEqual(d.transmissions.map((t) => t.id), ['t2', 't3']);
  assert.equal(d.sessions.length, 2, 'both were connected during the range');
  for (const dev of d.devices) assert.equal(dev.connected_ms, 75000);
  assert.equal(d.gateway.connected_ms, 75000, 'the gateway is clipped to the range too');
});

test('range: an empty day is an answer, not an error', { skip }, async () => {
  const from = DAY - 5 * 24 * 60 * MIN;
  const d = (await get(open, `/api/admin/range?from=${from}&to=${from + 24 * 60 * MIN}`)).json;
  assert.deepEqual(d.transmissions, []);
  assert.deepEqual(d.sessions, []);
  assert.deepEqual(d.conversations, []);
  assert.equal(d.totals.talk_ms, 0);
  assert.equal(d.totals.longest, null);
});

test('range: bad input is refused with 400', { skip }, async () => {
  for (const q of ['', 'from=1', 'from=abc&to=5', 'from=10&to=10', 'from=10&to=5', 'from=-5&to=5', 'from=1.5&to=9',
    `from=0&to=${401 * 24 * 60 * MIN}`, 'from=1&to=2%3BDROP%20TABLE%20sessions']) {
    const res = await get(open, `/api/admin/range?${q}`);
    assert.equal(res.status, 400, `accepted: ${q}`);
  }
  assert.equal((await get(open, `/api/admin/range?${RANGE}`)).json.totals.transmissions, 6, 'the data is still there');
});

test('devices: everyone ever seen, with all-time totals', { skip }, async () => {
  const d = (await get(open, '/api/admin/devices')).json;
  const radio = d.devices.find((x) => x.id === 'cli-gateway0001');
  assert.equal(radio.kind, 'gateway');
  assert.equal(radio.transmissions, 7);
  assert.equal(radio.talk_ms, 191000);
  const phone = d.devices.find((x) => x.id === 'device-phone-0001');
  assert.equal(phone.drops, 1);
  assert.equal(phone.sessions, 2);
});

test('export: CSV of either table for the range; anything else is refused', { skip }, async () => {
  const tx = await get(open, `/api/admin/export.csv?table=transmissions&${RANGE}`);
  assert.equal(tx.status, 200);
  assert.match(tx.headers['content-type'], /^text\/csv/);
  assert.match(tx.headers['content-disposition'], /attachment; filename="walkie-transmissions\.csv"/);
  const lines = tx.body.trim().split('\r\n');
  assert.equal(lines.length, 7);
  assert.ok(lines[0].startsWith('id,session_id,device_id,name,role,priority,started_at,'));
  assert.ok(lines[2].includes(",'=Mom,"), 'a name starting with = must be defused');

  const sessions = await get(open, `/api/admin/export.csv?table=sessions&${RANGE}`);
  assert.equal(sessions.body.trim().split('\r\n').length, 4);

  for (const table of ['events', 'sqlite_master', 'sessions;--', '']) {
    assert.equal((await get(open, `/api/admin/export.csv?table=${encodeURIComponent(table)}&${RANGE}`)).status, 400);
  }
});

test('the API is read-only and unknown paths are 404', { skip }, async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal((await get(open, `/api/admin/range?${RANGE}`, {}, method)).status, 405);
  }
  assert.equal((await get(open, '/api/admin/nothing')).status, 404);
});

// ---------- access ----------

test('no token set: the API is open and the server says so at start', { skip }, async () => {
  assert.equal((await get(open, '/api/admin/devices')).status, 200);
  assert.ok(open.out.includes(' WARN  admin-open '));
  assert.ok(open.out.includes('admin="open"'));
});

test('token set: required on every API path, and never written to the log', { skip }, async () => {
  for (const p of [`/api/admin/range?${RANGE}`, '/api/admin/devices', `/api/admin/export.csv?table=sessions&${RANGE}`, '/api/admin/nothing']) {
    const none = await get(locked, p);
    assert.equal(none.status, 401, p);
    assert.equal(none.headers['www-authenticate'], 'Bearer');
    assert.ok(!none.body.includes('Radio'), 'data leaked without a token');
  }
  const wrong = 'wrong-token-zzzzzzzzzzzzzzzz';
  assert.equal((await get(locked, '/api/admin/devices', { Authorization: `Bearer ${wrong}` })).status, 401);
  assert.equal((await get(locked, '/api/admin/devices', { Authorization: TOKEN })).status, 401, 'the Bearer scheme is required');
  // The token in the URL does nothing: it is only ever read from the header.
  assert.equal((await get(locked, `/api/admin/devices?token=${TOKEN}`)).status, 401);

  const ok = await get(locked, `/api/admin/range?${RANGE}`, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.totals.transmissions, 6);

  await new Promise((r) => setTimeout(r, 100));
  assert.ok(locked.out.includes(' WARN  admin-denied '));
  assert.ok(locked.out.includes('reason="wrong-token"') || locked.out.includes('reason="no-token"'));
  assert.ok(!locked.out.includes(TOKEN));
  assert.ok(!locked.out.includes(wrong));
  assert.ok(!locked.out.includes(' admin-open '));
  assert.ok(locked.out.includes('admin="token"'));
});

test('the page itself is static and loads without a token; it has no inline script or style', { skip }, async () => {
  for (const file of ['/admin.html', '/admin.js', '/admin.css']) assert.equal((await get(locked, file)).status, 200, file);
  const html = (await get(locked, '/admin.html')).body;
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), 'inline script');
  assert.ok(!/<style/i.test(html) && !/\sstyle=/i.test(html), 'inline style');
  assert.ok(!/\son[a-z]+=/i.test(html), 'inline event handler');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\b|setAttribute\('style'/.test(js), 'admin.js must build the page with DOM calls and classes only');
});

test('an unusable ADMIN_TOKEN closes the API instead of leaving it open', { skip }, async () => {
  const s = await startServer({ DATA_DIR: dataDir, ADMIN_TOKEN: 'short' });
  try {
    assert.equal((await get(s, '/api/admin/devices')).status, 403);
    assert.equal((await get(s, '/api/admin/devices', { Authorization: 'Bearer short' })).status, 403);
    assert.ok(s.out.includes(' ERROR admin-disabled '));
    assert.ok(s.out.includes('admin="disabled"'));
  } finally {
    s.child.kill();
  }
});

test('STATS=off: the API answers 503 and the channel is unaffected', async () => {
  const s = await startServer({ STATS: 'off', DATA_DIR: path.join(dataDir, 'unused') });
  try {
    const res = await get(s, `/api/admin/range?${RANGE}`);
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'stats-off');
    assert.equal((await get(s, '/')).status, 200);
  } finally {
    s.child.kill();
  }
});

// ---------- public/admin.js against a fake DOM ----------

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.text = '';
    this.value = '';
    this.disabled = false;
    const self = this;
    this.classList = {
      add: (c) => { if (!self.has(c)) self.className = `${self.className} ${c}`.trim(); },
      remove: (c) => { self.className = self.className.split(' ').filter((x) => x && x !== c).join(' '); },
      toggle: (c, on) => (on ? self.classList.add(c) : self.classList.remove(c)),
      contains: (c) => self.has(c),
    };
  }
  has(c) { return this.className.split(' ').includes(c); }
  get firstChild() { return this.children[0] || null; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  remove() {}
  click() { for (const fn of this.listeners.click || []) fn({ preventDefault() {} }); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  set textContent(v) { this.text = String(v); this.children = []; }
  // Everything a reader would see inside this node.
  get textContent() { return this.text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(' '); }
  all(pred, out = []) {
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (pred(c)) out.push(c);
      c.all(pred, out);
    }
    return out;
  }
}

function loadAdminPage({ responses, storage = {} }) {
  const byId = new Map();
  const requests = [];
  const document = {
    body: new FakeNode('body'),
    getElementById: (id) => { if (!byId.has(id)) byId.set(id, new FakeNode(`#${id}`)); return byId.get(id); },
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
  };
  const context = vm.createContext({
    document,
    Node: FakeNode,
    sessionStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    fetch: async (url, options) => {
      requests.push({ url, headers: (options && options.headers) || {} });
      const r = responses(url, options);
      return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json, blob: async () => ({}) };
    },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setTimeout: () => 0,
    console, Date, Map, Set, Promise, JSON, Math, Array, Object, String, Number, Boolean, Error,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8'), context, { filename: 'admin.js' });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  return { $: document.getElementById, run: (code) => vm.runInContext(code, context), requests, storage, settle };
}

test('admin.js helpers: days, durations, busiest hour, daily buckets', () => {
  const page = loadAdminPage({ responses: () => ({ status: 503, json: {} }) });
  const day = JSON.parse(page.run("JSON.stringify(dayRange('2026-11-10'))"));
  assert.equal(new Date(day.from).getHours(), 0);
  assert.equal(new Date(day.from).getDate(), 10);
  assert.equal(new Date(day.to).getDate(), 11);
  assert.equal(new Date(day.to).getHours(), 0);
  assert.equal(page.run("dayRange('2026-02-31')"), null);
  assert.equal(page.run("dayRange('<script>')"), null);
  assert.equal(page.run("shiftDay('2026-03-01', -1)"), '2026-02-28');
  assert.equal(page.run("shiftDay('2026-12-31', 1)"), '2027-01-01');

  assert.deepEqual(JSON.parse(page.run('JSON.stringify([0, 4400, 59999, 72000, 600000, 3723000].map(fmtDuration))')),
    ['0 s', '4 s', '1 min', '1 min 12 s', '10 min', '1 h 2 min']);
  assert.equal(page.run('fmtMinutes(584000)'), '9.7');
  assert.deepEqual(JSON.parse(page.run('JSON.stringify([0, 0.4, 7, 14.2, 20, 61, 1000].map(niceMax))')), [1, 0.5, 10, 20, 20, 100, 1000]);

  const at = (h, m) => new Date(2026, 10, 10, h, m).getTime();
  const txs = JSON.stringify([
    { started_at: at(8, 5), held_ms: 30000 }, { started_at: at(8, 50), held_ms: 20000 },
    { started_at: at(20, 0), held_ms: 45000 }, { started_at: new Date(2026, 10, 9, 23, 59).getTime(), held_ms: 9000 },
  ]);
  assert.deepEqual(JSON.parse(page.run(`JSON.stringify(busiestHour(${txs}))`)), { hour: 8, talk_ms: 50000 });
  assert.equal(page.run('busiestHour([])'), null);
  const days = JSON.parse(page.run(`JSON.stringify(dailyTotals(${txs}, '2026-11-08', 3))`));
  assert.deepEqual(days, [
    { key: '2026-11-08', talk_ms: 0, transmissions: 0 },
    { key: '2026-11-09', talk_ms: 9000, transmissions: 1 },
    { key: '2026-11-10', talk_ms: 95000, transmissions: 3 },
  ]);
});

function sampleRange(url) {
  const from = Number(/from=(\d+)/.exec(url)[1]);
  const to = Number(/to=(\d+)/.exec(url)[1]);
  const start = to - 12 * 60 * MIN; // midday of the last day in the range
  const hostile = '<img src=x onerror=alert(1)>';
  const transmissions = [
    { id: 't1', device_id: 'radio', name: 'Radio', role: 'gateway', priority: 1, started_at: start, ended_at: start + 20000, held_ms: 20000, end_reason: 'ptt-stop', listeners: 1, listeners_audible: 1 },
    { id: 't2', device_id: 'phone', name: hostile, role: 'browser', priority: 0, started_at: start + 30000, ended_at: start + 40000, held_ms: 10000, end_reason: 'ptt-stop', listeners: 1, listeners_audible: 0 },
    { id: 't3', device_id: 'radio', name: 'Radio', role: 'gateway', priority: 1, started_at: start + 300000, ended_at: start + 347000, held_ms: 47000, end_reason: 'timeout', listeners: 1, listeners_audible: 0 },
  ];
  return {
    from, to, now: to + 1000, truncated: false, conversation_gap_s: 60,
    totals: { talk_ms: 77000, transmissions: 3, longest: { id: 't3', name: 'Radio', started_at: start + 300000, held_ms: 47000 }, sessions: 1, drops: 1, online: { sessions: 1, drops: 1, talk_ms: 10000, transmissions: 1 }, radio: { transmissions: 2, talk_ms: 67000, unmonitored: 1, unmonitored_ms: 47000 }, missed_by_radio: 1, missed_by_radio_ms: 10000 },
    gateway: {
      known: true, sessions: 2, drops: 1, connected_ms: 3000000, down_ms: 600000, uptime_pct: 83.3, first_joined_at: start - 59000,
      outages: [{ left_at: start + 50000, reason: 'dead-connection', connected_for_ms: 600000, down_ms: 120000, back_at: start + 170000 }],
      missed: [{ id: 't2', name: 'phone', started_at: start + 30000, held_ms: 10000 }],
    },
    devices: [
      { device_id: 'phone', name: hostile, role: 'browser', kind: 'phone', talk_ms: 10000, transmissions: 1, connected_ms: 600000, sessions: 1, drops: 1 },
    ],
    conversations: [
      { started_at: start, ended_at: start + 40000, length_ms: 40000, turns: 2, talk_ms: 30000, kind: 'mixed', listeners: [{ name: 'Dad' }], participants: [{ name: 'Radio', role: 'gateway', turns: 1, talk_ms: 20000 }, { name: hostile, role: 'browser', turns: 1, talk_ms: 10000 }] },
      { started_at: start + 300000, ended_at: start + 347000, length_ms: 47000, turns: 1, talk_ms: 47000, kind: 'radio', listeners: [], participants: [{ name: 'Radio', role: 'gateway', turns: 1, talk_ms: 47000 }] },
    ],
    transmissions,
    sessions: [
      { id: 1, conn_id: 'a', device_id: 'radio', name: 'Radio', role: 'gateway', kind: 'gateway', connected_at: start - 60000, joined_at: start - 59000, left_at: null, leave_reason: null },
      { id: 2, conn_id: 'b', device_id: 'phone', name: hostile, role: 'browser', kind: 'phone', connected_at: start - 30000, joined_at: start - 29000, left_at: start + 100000, leave_reason: 'dead-connection' },
      { id: 3, conn_id: 'c', device_id: null, name: null, role: null, kind: null, connected_at: start, joined_at: null, left_at: start + 10, leave_reason: 'closed' },
    ],
  };
}

test('admin.js draws the day: tiles, tables, both charts, and text from peers stays text', async () => {
  const page = loadAdminPage({ responses: (url) => ({ status: 200, json: sampleRange(url) }) });
  await page.settle();
  assert.equal(page.$('content').has('hidden'), false);
  assert.equal(page.requests.length, 2, 'one request for the day, one for the 30-day chart');
  assert.ok(page.requests.every((r) => !r.headers.Authorization), 'no token was set, none must be sent');

  const tiles = page.$('tiles').textContent;
  for (const piece of ['Minutes talked', '1.3', 'Transmissions', '3', '2 conversations', 'Longest', '47 s', 'Busiest hour', '12:00', '1 dropped', 'People connections', 'Missed by radio', '10 s spoken while the gateway was down']) {
    assert.ok(tiles.includes(piece), `tiles are missing "${piece}": ${tiles}`);
  }

  const rowsOf = (id) => page.$(id).all((n) => n.tag === 'tr').length - 1; // minus the header row
  assert.equal(rowsOf('talk-table'), 3);
  assert.equal(rowsOf('conversations-table'), 2);
  assert.equal(rowsOf('devices-table'), 1, 'people only: the radio gateway is not a device');
  assert.equal(rowsOf('missed-table'), 1, 'the call from the app that the radio never got');
  assert.equal(rowsOf('outages-table'), 1);
  assert.ok(page.$('gateway-tiles').textContent.includes('83.3%'));
  assert.ok(page.$('conversations-table').textContent.includes('Radio and app'));
  assert.ok(page.$('conversations-table').textContent.includes('Dad'), 'listeners are named');
  assert.ok(page.$('talk-table').textContent.includes('nobody listening'));
  assert.ok(page.$('talk-table').textContent.includes('Time limit'));

  // 30 bars, today's selected, each with a hit area that names the day.
  const daily = page.$('daily-chart');
  assert.equal(daily.all((n) => n.has('bar')).length, 30);
  assert.equal(daily.all((n) => n.has('selected')).length, 1);
  const hits = daily.all((n) => n.has('hit'));
  assert.equal(hits.length, 30);
  assert.match(hits[29].attrs['aria-label'], /1\.3 min in 3 transmissions/);

  // Timeline: the probe that never joined has no row; the drop is marked by a cap as well as colour.
  const timeline = page.$('timeline');
  assert.equal(timeline.all((n) => n.has('row-label')).length, 2);
  assert.equal(timeline.all((n) => n.has('session')).length, 2);
  assert.equal(timeline.all((n) => n.has('drop-cap')).length, 1);
  assert.equal(timeline.all((n) => n.has('drop')).length, 0, 'bars are not coloured by how they ended; only the end mark is');
  assert.equal(timeline.all((n) => n.has('row-label') && n.textContent === 'Radio gateway').length, 1);
  assert.equal(timeline.all((n) => n.has('talk')).length, 3);

  // The hostile name is there, as text; nothing in the tree was built from markup.
  assert.ok(page.$('devices-table').textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(page.$('devices-table').all((n) => n.tag === 'img').length, 0);
});

test('admin.js: a 401 asks for the token, sends it as a Bearer header, and keeps it for the tab only', async () => {
  let accept = null;
  const page = loadAdminPage({
    responses: (url, options) => (accept && options.headers.Authorization === `Bearer ${accept}` ? { status: 200, json: sampleRange(url) } : { status: 401, json: {} }),
  });
  accept = TOKEN;
  await page.settle();
  assert.equal(page.$('token-form').has('hidden'), false);
  assert.equal(page.$('content').has('hidden'), true);

  page.$('token-input').value = `  ${TOKEN} `;
  for (const fn of page.$('token-form').listeners.submit) fn({ preventDefault() {} });
  await page.settle();
  assert.equal(page.$('token-form').has('hidden'), true);
  assert.equal(page.$('content').has('hidden'), false);
  assert.equal(page.storage['walkie-admin-token'], TOKEN);
  assert.equal(page.$('token-input').value, '', 'the field is cleared');
  const sent = page.requests.filter((r) => r.headers.Authorization);
  assert.ok(sent.length >= 2);
  assert.ok(page.requests.every((r) => !r.url.includes(TOKEN)), 'the token must never be in a URL');

  // A wrong token is forgotten and asked for again.
  const bad = loadAdminPage({ responses: () => ({ status: 401, json: {} }), storage: { 'walkie-admin-token': 'old-wrong-token' } });
  await bad.settle();
  assert.equal(bad.storage['walkie-admin-token'], undefined);
  assert.ok(bad.$('message').textContent.includes('not accepted'));
});

test('admin.js: database off or admin disabled is explained, not shown as an empty day', async () => {
  const off = loadAdminPage({ responses: () => ({ status: 503, json: { error: 'stats-off' } }) });
  await off.settle();
  assert.ok(off.$('message').textContent.includes('usage database is off'));
  assert.equal(off.$('content').has('hidden'), true);

  const disabled = loadAdminPage({ responses: () => ({ status: 403, json: {} }) });
  await disabled.settle();
  assert.ok(disabled.$('message').textContent.includes('ADMIN_TOKEN'));
});

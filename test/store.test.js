// The usage database on its own (lib/store.js). Run with: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, deviceKind } = require('../lib/store');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* older Node: the store turns itself off */ }
const skip = sqlite ? false : 'node:sqlite is not available in this Node version';

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-store-'));
  const logged = [];
  const log = { error: (event, fields) => logged.push({ event, ...fields }), info() {}, warn() {}, debug() {} };
  const store = createStore({ dir, log, ...options });
  const all = (sql, ...args) => store.db.prepare(sql).all(...args);
  const one = (sql, ...args) => store.db.prepare(sql).get(...args);
  return { dir, store, logged, all, one };
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 10, 13, 0, 0);

test('creates the schema, in WAL mode', { skip }, () => {
  const { store, all, one } = setup();
  const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  assert.deepEqual(tables, ['denied', 'devices', 'events', 'presence', 'sessions', 'transmissions']);
  assert.equal(one('PRAGMA journal_mode').journal_mode, 'wal');
  assert.equal(one('PRAGMA user_version').user_version, 1);
  store.close();
});

test("a session's whole story ends up in the right tables", { skip }, () => {
  const { store, all, one } = setup();
  const phoneUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36';

  store.sessionStart({ connId: 'radio01', ip: '10.0.0.5', ua: 'Python/3.12 websockets/13', ts: T0 });
  store.sessionJoin({ connId: 'radio01', deviceId: 'cli-gateway0001', name: 'Radio', role: 'gateway', ua: 'Python/3.12 websockets/13', ts: T0 + 10 });
  store.sessionStart({ connId: 'phone01', ip: '10.0.0.9', ua: phoneUa, origin: 'https://walkie.test', ts: T0 + 1000 });
  store.sessionJoin({ connId: 'phone01', deviceId: 'device-phone-0001', name: 'Mom', role: 'browser', ua: phoneUa, ts: T0 + 1100 });

  // The radio talks for 4 s to one listener who can hear it.
  store.txStart({ tx: 't1', connId: 'radio01', name: 'Radio', role: 'gateway', priority: true, listeners: 1, listenersAudible: 1, ts: T0 + 5000 });
  store.denied({ connId: 'phone01', holderTx: 't1', ts: T0 + 6000 });
  store.txEnd({ tx: 't1', reason: 'ptt-stop', listenersAudible: 1, ts: T0 + 9000 });

  // The phone locks, then drops; the radio talks again to nobody.
  store.presence({ connId: 'phone01', visible: false, audible: false, ts: T0 + 20000 });
  store.txStart({ tx: 't2', connId: 'radio01', name: 'Radio', role: 'gateway', priority: true, listeners: 1, listenersAudible: 0, ts: T0 + 30000 });
  store.sessionEnd({ connId: 'phone01', reason: 'dead-connection', code: 1006, ts: T0 + 32000 });
  store.txEnd({ tx: 't2', reason: 'ptt-stop', listenersAudible: 0, ts: T0 + 77000 });

  assert.deepEqual(all('SELECT id, kind, last_name FROM devices ORDER BY id').map((r) => ({ ...r })), [
    { id: 'cli-gateway0001', kind: 'gateway', last_name: 'Radio' },
    { id: 'device-phone-0001', kind: 'phone', last_name: 'Mom' },
  ]);

  const phone = one("SELECT * FROM sessions WHERE conn_id = 'phone01'");
  assert.equal(phone.device_id, 'device-phone-0001');
  assert.equal(phone.role, 'browser');
  assert.equal(phone.connected_at, T0 + 1000);
  assert.equal(phone.joined_at, T0 + 1100);
  assert.equal(phone.leave_reason, 'dead-connection');
  assert.equal(phone.leave_code, 1006);
  assert.equal(phone.duration_s, 31);
  assert.equal(one("SELECT left_at FROM sessions WHERE conn_id = 'radio01'").left_at, null, 'the radio is still connected');

  const t1 = one("SELECT * FROM transmissions WHERE id = 't1'");
  assert.equal(t1.device_id, 'cli-gateway0001');
  assert.equal(t1.held_ms, 4000);
  assert.equal(t1.end_reason, 'ptt-stop');
  assert.equal(t1.priority, 1);

  // The questions the plan asks of the data.
  const minutes = all(`SELECT device_id, SUM(held_ms) / 60000.0 AS minutes FROM transmissions GROUP BY device_id`);
  assert.equal(minutes.length, 1);
  assert.equal(minutes[0].minutes, (4000 + 47000) / 60000);
  const unheard = all("SELECT id, held_ms FROM transmissions WHERE role = 'gateway' AND listeners_audible = 0");
  assert.deepEqual(unheard.map((r) => ({ ...r })), [{ id: 't2', held_ms: 47000 }]);

  assert.equal(one('SELECT holder_tx FROM denied').holder_tx, 't1');
  assert.equal(one('SELECT session_id FROM denied').session_id, phone.id);
  assert.deepEqual({ ...one('SELECT session_id, visible, audible FROM presence') }, { session_id: phone.id, visible: 0, audible: 0 });
  store.close();
});

test('joining again keeps the first join time and updates the name', { skip }, () => {
  const { store, one } = setup();
  store.sessionStart({ connId: 'c1', ts: T0 });
  store.sessionJoin({ connId: 'c1', deviceId: 'device-0001', name: 'Old', role: 'browser', ts: T0 + 5 });
  store.sessionJoin({ connId: 'c1', deviceId: 'device-0001', name: 'New', role: 'browser', ts: T0 + 900 });
  const s = one('SELECT name, joined_at FROM sessions');
  assert.equal(s.name, 'New');
  assert.equal(s.joined_at, T0 + 5);
  const d = one('SELECT first_seen, last_seen, last_name FROM devices');
  assert.deepEqual({ ...d }, { first_seen: T0 + 5, last_seen: T0 + 900, last_name: 'New' });
  store.close();
});

test('a transmission is ended once: a late second end does not overwrite the first', { skip }, () => {
  const { store, one } = setup();
  store.sessionStart({ connId: 'c1', ts: T0 });
  store.txStart({ tx: 't1', connId: 'c1', name: 'A', ts: T0 });
  store.txEnd({ tx: 't1', reason: 'preempted', preemptedBy: 't2', ts: T0 + 500 });
  store.txEnd({ tx: 't1', reason: 'disconnect', ts: T0 + 9000 });
  const t = one('SELECT held_ms, end_reason, preempted_by FROM transmissions');
  assert.deepEqual({ ...t }, { held_ms: 500, end_reason: 'preempted', preempted_by: 't2' });
  store.close();
});

test('raw events are kept as JSON; text from peers is cleaned', { skip }, () => {
  const { store, all } = setup();
  store.event('join', 'c1', { name: 'Mom', again: false }, T0);
  store.event('server-start', null, undefined, T0 + 1);
  store.sessionStart({ connId: 'c1', ip: '10.0.0.9', ua: 'evil\u001b[2J\nagent' + 'x'.repeat(1000), ts: T0 });
  const rows = all('SELECT event, conn_id, data FROM events ORDER BY id');
  assert.deepEqual(JSON.parse(rows[0].data), { name: 'Mom', again: false });
  assert.equal(rows[1].conn_id, null);
  assert.equal(rows[1].data, null);
  const ua = all('SELECT ua FROM sessions')[0].ua;
  assert.ok(!/[\u0000-\u001f]/.test(ua), 'control characters were stored');
  assert.ok(ua.length <= 301);
  store.close();
});

test('sessions and transmissions left open by a crash are closed at the next start', { skip }, () => {
  const first = setup();
  first.store.sessionStart({ connId: 'c1', ts: T0 });
  first.store.txStart({ tx: 't1', connId: 'c1', name: 'A', ts: T0 + 1000 });
  first.store.event('floor-granted', 'c1', { tx: 't1' }, T0 + 1000);
  first.store.event('stats', null, {}, T0 + 4000); // the last sign of life
  first.store.close(); // no leave, no release: the process just died

  const logged = [];
  const store = createStore({ dir: first.dir, log: { error: (e, f) => logged.push({ e, ...f }) } });
  const s = store.db.prepare('SELECT left_at, leave_reason, duration_s FROM sessions').get();
  assert.deepEqual({ ...s }, { left_at: T0 + 4000, leave_reason: 'server-restart', duration_s: 4 });
  const t = store.db.prepare('SELECT ended_at, held_ms, end_reason FROM transmissions').get();
  assert.deepEqual({ ...t }, { ended_at: T0 + 4000, held_ms: 3000, end_reason: 'server-restart' });
  assert.deepEqual(logged, []);
  store.close();
});

test('maintenance purges old raw events only, and keeps the newest 7 daily backups', { skip }, () => {
  const { dir, store, all } = setup({ retentionDays: 30 });
  const now = T0 + 100 * DAY;
  store.event('old', null, {}, now - 31 * DAY);
  store.event('recent', null, {}, now - 29 * DAY);
  store.sessionStart({ connId: 'ancient', ts: now - 300 * DAY });

  const backups = path.join(dir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  for (let d = 1; d <= 9; d++) fs.writeFileSync(path.join(backups, `walkie-2026010${d}.db`), 'x');
  fs.writeFileSync(path.join(backups, 'notes.txt'), 'not ours');

  const done = store.maintain(now);
  assert.equal(done.purged, 1);
  assert.deepEqual(all('SELECT event FROM events').map((r) => r.event), ['recent']);
  assert.equal(all('SELECT conn_id FROM sessions').length, 1, 'sessions are never purged');

  const name = `walkie-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}.db`;
  assert.equal(done.backup, name);
  const files = fs.readdirSync(backups).sort();
  assert.equal(files.filter((f) => f.endsWith('.db')).length, 7);
  assert.ok(files.includes(name));
  assert.ok(files.includes('notes.txt'), 'a file that is not a backup was deleted');
  assert.ok(!files.includes('walkie-20260101.db'));

  // The backup is a real database with the data in it.
  const copy = new sqlite.DatabaseSync(path.join(backups, name));
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  copy.close();

  // Same day again: nothing new.
  const again = store.maintain(now + 3600 * 1000);
  assert.equal(again.backup, null);
  assert.equal(again.removed, 0);
  store.close();
});

test('a failing database never throws; it logs one throttled error', { skip }, () => {
  const { store, logged } = setup();
  store.db.close(); // every statement now fails
  assert.doesNotThrow(() => {
    for (let i = 0; i < 50; i++) {
      store.sessionStart({ connId: `c${i}`, ts: T0 });
      store.sessionJoin({ connId: `c${i}`, deviceId: 'device-0001', name: 'A', role: 'browser', ts: T0 });
      store.txStart({ tx: `t${i}`, connId: `c${i}`, ts: T0 });
      store.txEnd({ tx: `t${i}`, reason: 'ptt-stop', ts: T0 });
      store.presence({ connId: `c${i}`, visible: false, audible: false });
      store.denied({ connId: `c${i}`, holderTx: 't0' });
      store.event('x', `c${i}`, { i });
      store.sessionEnd({ connId: `c${i}`, reason: 'closed', code: 1000 });
    }
    store.maintain();
    store.close();
  });
  assert.equal(logged.length, 1, 'errors must be throttled to one line');
  assert.equal(logged[0].event, 'store-error');
});

test('a data directory that cannot be used turns the store off instead of failing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-store-'));
  const blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  const logged = [];
  const store = createStore({ dir: path.join(blocker, 'data'), log: { error: (event) => logged.push(event) } });
  assert.equal(store.enabled, false);
  assert.deepEqual(logged, ['store-disabled']);
  assert.doesNotThrow(() => {
    store.sessionStart({ connId: 'c1' });
    store.event('x');
    store.maintain();
    store.close();
  });
});

test('STATS off: nothing is opened and nothing is written', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-store-')), 'data');
  const store = createStore({ enabled: false, dir, log: {} });
  assert.equal(store.enabled, false);
  store.event('x');
  assert.equal(fs.existsSync(dir), false);
});

test('device kind comes from the role and the user agent', () => {
  assert.equal(deviceKind('gateway', 'Python'), 'gateway');
  assert.equal(deviceKind('cli', 'Python'), 'other');
  assert.equal(deviceKind('browser', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)'), 'phone');
  assert.equal(deviceKind('browser', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'), 'desktop');
  assert.equal(deviceKind('browser', undefined), 'desktop');
});

// Starts the real server.js on a free port and drives it with real WebSocket
// clients. Run with: npm test
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const TOKEN = 'test-token-0123456789abcdef';
// The usage database of the main test server goes to a throwaway directory,
// never into the repository. Throwaway servers run without one unless a test asks.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-test-data-'));
let server;
let port;
let serverLog = ''; // everything the main test server has printed so far
const sockets = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  return fn();
}

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    sockets.push(ws);
  });
}

const last = (ws, type) => [...ws.msgs].reverse().find((m) => m.type === type);
const send = (ws, msg) => ws.send(JSON.stringify(msg));

async function client(name, token) {
  const ws = await open();
  const welcome = await waitFor(() => last(ws, 'welcome'));
  ws.id = welcome.id;
  send(ws, { type: 'join', name, token });
  await sleep(100);
  return ws;
}

before(async () => {
  port = await freePort();
  server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), MAX_TRANSMIT_MS: '1000', PRIORITY_TOKEN: TOKEN, MAX_CLIENTS: '8', HEARTBEAT_MS: '300', DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.exited = false;
  server.on('exit', () => (server.exited = true));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (d) => {
      if (String(d).includes(' listening ')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.on('exit', () => reject(new Error('server exited during start')));
  });
});

// Each test starts with an empty room (the server is capped at MAX_CLIENTS).
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await sleep(100);
});

after(() => {
  server.kill();
});

test('survives non-object and malformed frames', async () => {
  const ws = await open();
  for (const raw of ['null', '[1,2]', '"str"', '42', '{', JSON.stringify({ type: 'join', name: { toString: 1 } })]) {
    ws.send(raw);
  }
  await sleep(150);
  assert.equal(server.exited, false);
  // still works afterwards
  const c = await client('After', null);
  assert.ok(last(c, 'welcome'));
});

test('survives an invalid UTF-8 text frame', async () => {
  const ws = await open();
  const frame = WebSocket.Sender.frame(Buffer.from([0xff, 0xfe, 0xfd]), {
    fin: true, rsv1: false, opcode: 0x01, mask: true, readOnly: false,
  });
  ws._socket.write(Buffer.concat(frame));
  await sleep(200);
  assert.equal(server.exited, false);
});

test('oversized frame closes only that connection', async () => {
  const big = await open();
  const other = await client('Bystander', null);
  big.send(JSON.stringify({ type: 'offer', target: 'x', sdp: 'A'.repeat(64 * 1024) }));
  await waitFor(() => big.readyState !== WebSocket.OPEN);
  assert.notEqual(big.readyState, WebSocket.OPEN);
  assert.equal(other.readyState, WebSocket.OPEN);
});

test('names are sanitised and cannot carry the priority star', async () => {
  const a = await client('Alice', null);
  await client('⭐ Dad\u001b[2J\nX', null);
  const peers = await waitFor(() => last(a, 'peers')?.peers.find((p) => p.name.includes('Dad')));
  assert.ok(peers);
  assert.equal(peers.name, 'Dad[2JX');
  assert.equal(peers.priority, false);
});

test('unjoined connections get no broadcasts and cannot take the floor', async () => {
  const joined = await client('Joined', null);
  const lurker = await open();
  const welcome = await waitFor(() => last(lurker, 'welcome'));
  assert.ok(welcome);
  send(lurker, { type: 'ptt-start' });
  await sleep(150);
  assert.equal(last(lurker, 'floor'), undefined);
  assert.notEqual(last(joined, 'floor')?.holder, welcome.id);
});

test('floor: grant, deny, timeout, and holder cannot extend it', async () => {
  const a = await client('A', null);
  const b = await client('B', null);

  send(a, { type: 'ptt-start' });
  await waitFor(() => last(b, 'floor')?.holder === a.id);
  assert.equal(last(b, 'floor').holder, a.id);

  send(b, { type: 'ptt-start' });
  assert.ok(await waitFor(() => last(b, 'floor-denied')));

  // Re-sending ptt-start must not re-arm the 1000 ms timer.
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) {
    send(a, { type: 'ptt-start' });
    await sleep(150);
  }
  await waitFor(() => last(b, 'floor')?.holder === null, 1500);
  assert.equal(last(b, 'floor').holder, null);
  assert.ok(Date.now() - t0 < 1600, 'floor should time out on schedule');
});

test('priority token preempts a normal holder; wrong token does not', async () => {
  const normal = await client('Normal', null);
  const impostor = await client('Impostor', 'wrong-token-wrong-token');
  const radio = await client('Radio', TOKEN);

  send(normal, { type: 'ptt-start' });
  await waitFor(() => last(radio, 'floor')?.holder === normal.id);

  send(impostor, { type: 'ptt-start' });
  assert.ok(await waitFor(() => last(impostor, 'floor-denied')));

  send(radio, { type: 'ptt-start' });
  assert.ok(await waitFor(() => last(normal, 'floor-preempted')));
  const floor = await waitFor(() => last(normal, 'floor')?.holder === radio.id && last(normal, 'floor'));
  assert.equal(floor.priority, true);
});

test('relay forwards only whitelisted fields and sets from/name itself', async () => {
  const a = await client('Sender', null);
  const b = await client('Receiver', null);
  send(a, { type: 'offer', target: b.id, sdp: { type: 'offer', sdp: 'v=0' }, from: 'spoofed', name: 'Spoof', extra: 'x' });
  const got = await waitFor(() => last(b, 'offer'));
  assert.equal(got.from, a.id);
  assert.equal(got.name, 'Sender');
  assert.equal(got.extra, undefined);
});

test('app-level ping gets a pong, even before join', async () => {
  const ws = await open();
  await waitFor(() => last(ws, 'welcome'));
  send(ws, { type: 'ping' });
  assert.ok(await waitFor(() => last(ws, 'pong')));
});

test('a connection that stops answering protocol pings is dropped and frees the floor', async () => {
  const watcher = await client('Watcher', null);
  const ghost = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false, autoPong: false });
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    sockets.push(ws);
  });
  const welcome = await waitFor(() => last(ghost, 'welcome'));
  send(ghost, { type: 'join', name: 'Ghost' });
  send(ghost, { type: 'ptt-start' });
  await waitFor(() => last(watcher, 'floor')?.holder === welcome.id);
  assert.equal(last(watcher, 'floor').holder, welcome.id);
  // No pong from the ghost: it must be terminated and the floor released.
  await waitFor(() => last(watcher, 'floor')?.holder === null, 2500);
  assert.equal(last(watcher, 'floor').holder, null);
  await waitFor(() => ghost.readyState === WebSocket.CLOSED, 1000);
});

test('a client that misses one protocol ping but answers the next is kept', async () => {
  let pings = 0;
  const flaky = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false, autoPong: false });
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.on('ping', () => { pings += 1; if (pings !== 2) ws.pong(); }); // skips exactly one
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    sockets.push(ws);
  });
  await waitFor(() => last(flaky, 'welcome'));
  send(flaky, { type: 'join', name: 'Flaky' });
  await waitFor(() => pings >= 6, 4000); // well past the point where one miss used to drop it
  assert.equal(flaky.readyState, WebSocket.OPEN, 'one missed ping must not drop a client');
});

test('a browser that pings once then goes silent is dropped', async () => {
  const watcher = await client('Watcher2', null);
  const quiet = await client('Quiet', null);
  send(quiet, { type: 'ping' });
  await waitFor(() => last(watcher, 'peers')?.peers.some((p) => p.name === 'Quiet'));
  // Quiet keeps auto-ponging but sends nothing at the app level.
  const gone = await waitFor(() => !last(watcher, 'peers')?.peers.some((p) => p.name === 'Quiet'), 3500);
  assert.ok(gone, 'silent app-ping client should be removed from the peer list');
});

// Starts a throwaway server with extra env and resolves with its welcome message.
async function welcomeFrom(extraEnv) {
  const p = await freePort();
  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(p), STATS: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
      child.stdout.on('data', (d) => {
        if (String(d).includes(' listening ')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', () => reject(new Error('server exited during start')));
    });
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${p}`, { rejectUnauthorized: false });
      ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.type === 'welcome') {
          ws.terminate();
          resolve(m);
        }
      });
      ws.on('error', reject);
    });
  } finally {
    child.kill();
  }
}

test('roger beep is announced as off by default', async () => {
  const ws = await open();
  const welcome = await waitFor(() => last(ws, 'welcome'));
  assert.equal(welcome.rogerBeep, false);
});

test('ROGER_BEEP turns the announcement on; junk values leave it off', async () => {
  assert.equal((await welcomeFrom({ ROGER_BEEP: 'on' })).rogerBeep, true);
  assert.equal((await welcomeFrom({ ROGER_BEEP: 'TRUE' })).rogerBeep, true);
  assert.equal((await welcomeFrom({ ROGER_BEEP: 'off' })).rogerBeep, false);
  assert.equal((await welcomeFrom({ ROGER_BEEP: 'banana' })).rogerBeep, false);
});

// ---------------------------------------------------------------------------
// Logging. These read what the real server actually printed.
// ---------------------------------------------------------------------------

const lines = (mark) => serverLog.slice(mark).split('\n').filter(Boolean);
const LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (DEBUG|INFO |WARN |ERROR) [a-z][a-z-]*( |$)/;
const has = (mark, ...needles) => lines(mark).some((l) => needles.every((n) => l.includes(n)));
const heldMs = (l) => Number((l.match(/held_ms=(\d+)/) || [])[1]);

// Starts a throwaway server with extra env; resolves once its port accepts connections.
async function startServer(extraEnv) {
  const p = await freePort();
  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(p), HEARTBEAT_MS: '300', STATS: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle = { port: p, child, out: '' };
  child.stdout.on('data', (d) => { handle.out += d; });
  child.stderr.on('data', (d) => { handle.out += d; });
  const end = Date.now() + 15000;
  for (;;) {
    const up = await new Promise((resolve) => {
      const s = net.connect(p, '127.0.0.1', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (up) return handle;
    if (Date.now() > end) { child.kill(); throw new Error('server did not start'); }
    await sleep(50);
  }
}

test('startup logs the effective settings', async () => {
  assert.ok(has(0, ' INFO  config ', 'priority="enabled"', 'roger_beep="off"', 'max_clients=8', 'max_transmit_ms=1000', 'log_level="info"'));
  assert.ok(has(0, ' INFO  listening url="https://'));
});

test("the log tells a session's story: connect, join, floor, denied, release, leave", async () => {
  const mark = serverLog.length;
  const alice = await client('LogAlice', null);
  const bob = await client('LogBob', null);
  send(alice, { type: 'ptt-start' });
  await waitFor(() => last(bob, 'floor')?.holder === alice.id);
  send(bob, { type: 'ptt-start' });
  await waitFor(() => last(bob, 'floor-denied'));
  send(alice, { type: 'ptt-stop' });
  await waitFor(() => last(bob, 'floor')?.holder === null);
  bob.close();
  await waitFor(() => has(mark, ' leave ', 'name="LogBob"'));

  assert.ok(has(mark, ' INFO  connect ', 'ip="127.0.0.1"', 'clients='));
  assert.ok(has(mark, ' INFO  join ', 'name="LogAlice"', 'priority=false', 'again=false'));
  assert.ok(has(mark, ' INFO  floor-granted ', 'name="LogAlice"'));
  assert.ok(has(mark, ' INFO  floor-denied ', 'name="LogBob"', 'holder="LogAlice"'));
  const released = lines(mark).find((l) => l.includes(' floor-released ') && l.includes('name="LogAlice"'));
  assert.ok(released, "release is logged with the holder's name");
  assert.ok(released.includes('reason="ptt-stop"'));
  assert.ok(heldMs(released) >= 0);
  assert.ok(has(mark, ' INFO  leave ', 'name="LogBob"', 'reason="closed"', 'duration_s=', 'clients='));
});

test('losing the connection while talking logs the release (with the name) and then the leave', async () => {
  const mark = serverLog.length;
  const drop = await client('LogDrop', null);
  send(drop, { type: 'ptt-start' });
  await waitFor(() => has(mark, ' floor-granted ', 'name="LogDrop"'));
  drop.terminate();
  await waitFor(() => has(mark, ' leave ', 'name="LogDrop"'));
  const l = lines(mark);
  const released = l.findIndex((x) => x.includes(' floor-released ') && x.includes('name="LogDrop"') && x.includes('reason="disconnect"'));
  const left = l.findIndex((x) => x.includes(' leave ') && x.includes('name="LogDrop"'));
  assert.ok(released >= 0, 'release on disconnect is logged');
  assert.ok(left > released, 'and comes before the leave line');
});

test('a transmit timeout is logged as a warning with the limit', async () => {
  const mark = serverLog.length;
  const slow = await client('LogSlow', null);
  send(slow, { type: 'ptt-start' });
  await waitFor(() => has(mark, ' WARN  floor-timeout ', 'name="LogSlow"'), 2500);
  const l = lines(mark).find((x) => x.includes(' floor-timeout '));
  assert.ok(l && l.includes('limit_ms=1000') && heldMs(l) >= 900);
});

test('a priority preemption is logged with both names', async () => {
  const mark = serverLog.length;
  const low = await client('LogLow', null);
  const vip = await client('LogVip2', TOKEN);
  send(low, { type: 'ptt-start' });
  await waitFor(() => last(vip, 'floor')?.holder === low.id);
  send(vip, { type: 'ptt-start' });
  await waitFor(() => has(mark, ' floor-preempted ', 'by="LogVip2"', 'from="LogLow"'));
});

test('logs never contain the token, SDP, ICE or raw frames; a wrong token is reported without being shown', async () => {
  const mark = serverLog.length;
  const vip = await client('LogVip', TOKEN);
  const fake = await client('LogFake', 'wrong-token-value-1234567890');
  send(vip, { type: 'offer', target: fake.id, sdp: { type: 'offer', sdp: 'SECRET-SDP-MARKER' } });
  send(vip, { type: 'ice', target: fake.id, candidate: { candidate: 'SECRET-ICE-MARKER' } });
  const raw = await open();
  raw.send('not json SECRET-FRAME-MARKER');
  await waitFor(() => has(mark, ' invalid-frame '));
  const text = serverLog.slice(mark);
  for (const secret of [TOKEN, 'wrong-token-value', 'SECRET-SDP-MARKER', 'SECRET-ICE-MARKER', 'SECRET-FRAME-MARKER']) {
    assert.ok(!text.includes(secret), `log must not contain ${secret}`);
  }
  assert.ok(has(mark, ' WARN  priority-denied ', 'name="LogFake"', 'reason="wrong-token"'));
  assert.ok(has(mark, ' INFO  join ', 'name="LogVip"', 'priority=true'));
  assert.ok(has(mark, ' WARN  invalid-frame ', 'reason="not-json"', 'bytes='));
  for (const l of lines(mark)) assert.match(l, LINE_RE, `malformed log line: ${l}`);
});

test('a hostile name cannot add log lines or fields', async () => {
  const mark = serverLog.length;
  await client('Eve"\n2026-10-21T00:00:00.000Z INFO  floor-granted id="boss" priority=true', null);
  await waitFor(() => has(mark, ' join ', 'name="Eve'));
  for (const l of lines(mark)) assert.match(l, LINE_RE, `malformed log line: ${l}`);
  assert.ok(!has(mark, 'id="boss"'));
});

test('a burst of bad frames from one client produces one log line, not thousands', async () => {
  const mark = serverLog.length;
  const raw = await open();
  const welcome = await waitFor(() => last(raw, 'welcome'));
  for (let i = 0; i < 40; i++) raw.send('garbage ' + i);
  await waitFor(() => has(mark, ' invalid-frame '));
  await sleep(300);
  const mine = lines(mark).filter((l) => l.includes(' invalid-frame ') && l.includes(`id="${welcome.id.slice(0, 8)}"`));
  assert.equal(mine.length, 1);
});

test('flooding is logged once and the leave line says why', async () => {
  const mark = serverLog.length;
  const raw = await open();
  const welcome = await waitFor(() => last(raw, 'welcome'));
  const short = welcome.id.slice(0, 8);
  for (let i = 0; i < 800; i++) raw.send(JSON.stringify({ type: 'ping' }));
  await waitFor(() => has(mark, ' leave ', `id="${short}"`, 'reason="flood"'), 4000);
  const floods = lines(mark).filter((l) => l.includes(' WARN  flood ') && l.includes(`id="${short}"`));
  assert.equal(floods.length, 1);
  assert.ok(floods[0].includes('limit_per_s=500'));
});

test('a dead connection is logged as a warning and the leave line says why', async () => {
  const mark = serverLog.length;
  const ghost = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false, autoPong: false });
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    sockets.push(ws);
  });
  await waitFor(() => last(ghost, 'welcome'));
  send(ghost, { type: 'join', name: 'LogGhost' });
  await waitFor(() => has(mark, ' WARN  dead-connection ', 'name="LogGhost"', 'check="protocol-ping"'), 3000);
  await waitFor(() => has(mark, ' leave ', 'name="LogGhost"', 'reason="dead-connection"'), 2000);
});

test('something that is not TLS on the HTTPS port is logged, and does not hurt the server', async () => {
  const mark = serverLog.length;
  const s = net.connect(port, '127.0.0.1', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
  s.on('error', () => {});
  await waitFor(() => has(mark, ' INFO  tls-error ', 'ip="127.0.0.1"', 'code='), 3000);
  s.destroy();
  assert.equal(server.exited, false);
});

test('json format with debug level: every line parses, relays are traced without their content', async () => {
  const s = await startServer({ LOG_FORMAT: 'json', LOG_LEVEL: 'debug', ROGER_BEEP: 'on' });
  try {
    const open2 = () => new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${s.port}`, { rejectUnauthorized: false });
      ws.msgs = [];
      ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      sockets.push(ws);
    });
    const a = await open2();
    const b = await open2();
    const wa = await waitFor(() => last(a, 'welcome'));
    const wb = await waitFor(() => last(b, 'welcome'));
    send(a, { type: 'join', name: 'JA' });
    send(b, { type: 'join', name: 'JB' });
    await sleep(150);
    send(a, { type: 'offer', target: wb.id, sdp: { type: 'offer', sdp: 'SECRET-SDP-MARKER' } });
    await waitFor(() => s.out.includes('"event":"relay"'));
    const events = s.out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const cfg = events.find((e) => e.event === 'config');
    assert.equal(cfg.roger_beep, 'on');
    assert.equal(cfg.log_format, 'json');
    const relay = events.find((e) => e.event === 'relay');
    assert.equal(relay.level, 'debug');
    assert.equal(relay.from, wa.id.slice(0, 8));
    assert.equal(relay.to, wb.id.slice(0, 8));
    assert.ok(!s.out.includes('SECRET-SDP-MARKER'));
  } finally {
    s.child.kill();
  }
});

test('LOG_LEVEL=warn hides info lines but still shows a refused priority token', async () => {
  const s = await startServer({ LOG_LEVEL: 'warn', PRIORITY_TOKEN: 'short' });
  try {
    await sleep(300);
    assert.match(s.out, / ERROR priority-disabled /);
    assert.ok(!s.out.includes(' INFO '));
  } finally {
    s.child.kill();
  }
});

test('a bad LOG_LEVEL falls back to info and says so', async () => {
  const s = await startServer({ LOG_LEVEL: 'shouting' });
  try {
    await sleep(300);
    assert.match(s.out, / WARN {2}log-config /);
    assert.match(s.out, / INFO {2}config .*log_level="info"/);
  } finally {
    s.child.kill();
  }
});

test('the Docker image contains every local file server.js loads', () => {
  const fs = require('node:fs');
  const root = path.join(__dirname, '..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const copied = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+\S+/gim)].map((m) => m[1].replace(/\/$/, ''));
  const needed = new Set();
  const scan = (file) => {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of src.matchAll(/require\('(\.[^']+)'\)/g)) {
      let rel = path.normalize(path.join(path.dirname(file), m[1])).replace(/\\/g, '/');
      if (!/\.(js|json)$/.test(rel)) rel += '.js';
      if (!needed.has(rel)) {
        needed.add(rel);
        if (rel.endsWith('.js')) scan(rel);
      }
    }
  };
  scan('server.js');
  assert.ok(needed.has('lib/logger.js'), 'the scan should find the logger');
  for (const file of needed) {
    // COPY sources may use wildcards (package*.json) or name a whole directory.
    const ok = copied.some((c) => {
      const escape = (part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      const glob = new RegExp('^' + c.split('*').map(escape).join('[^/]*') + '$');
      return glob.test(file) || file.startsWith(c + '/');
    });
    assert.ok(ok, `Dockerfile does not COPY ${file}; the container would crash on start`);
  }
});

test('over the whole run, the token never appeared in the server log', () => {
  assert.ok(!serverLog.includes(TOKEN));
  assert.equal(server.exited, false);
});

// Fetches the page over HTTPS from a throwaway server and returns the response headers.
function headersOf(p) {
  return new Promise((resolve, reject) => {
    require('node:https').get({ host: '127.0.0.1', port: p, path: '/', rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.headers);
    }).on('error', reject);
  });
}

test('framing is denied by default', async () => {
  const s = await startServer({ FRAME_ANCESTORS: '' });
  try {
    const h = await headersOf(s.port);
    assert.match(h['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(h['x-frame-options'], 'DENY');
  } finally {
    s.child.kill();
  }
});

test('FRAME_ANCESTORS allows the listed origins and drops X-Frame-Options', async () => {
  const s = await startServer({ FRAME_ANCESTORS: 'https://ha.example.ts.net:8444, http://10.0.0.5:8123' });
  try {
    const h = await headersOf(s.port);
    assert.match(h['content-security-policy'], /frame-ancestors https:\/\/ha\.example\.ts\.net:8444 http:\/\/10\.0\.0\.5:8123$/);
    assert.equal(h['x-frame-options'], undefined);
    assert.match(h['content-security-policy'], /default-src 'self'.*object-src 'none'/);
  } finally {
    s.child.kill();
  }
});

test('a hostile FRAME_ANCESTORS value is ignored and framing stays denied', async () => {
  for (const bad of ['https://a.com; script-src *', '*', 'https://a.com"', "https://a.com/path", 'javascript:alert(1)']) {
    const s = await startServer({ FRAME_ANCESTORS: bad });
    try {
      const h = await headersOf(s.port);
      assert.match(h['content-security-policy'], /frame-ancestors 'none'$/, bad);
      assert.ok(!h['content-security-policy'].includes('script-src'), bad);
      assert.equal(h['x-frame-options'], 'DENY', bad);
      await sleep(100);
      assert.match(s.out, / WARN {2}frame-ancestors-ignored /, bad);
    } finally {
      s.child.kill();
    }
  }
});

test('a bad frame sent to a connection refused as "server full" does not crash the server', async () => {
  const s = await startServer({ MAX_CLIENTS: '1' });
  const raw = [];
  try {
    const wsUrl = `wss://127.0.0.1:${s.port}`;
    const first = new WebSocket(wsUrl, { rejectUnauthorized: false });
    raw.push(first);
    await new Promise((resolve, reject) => { first.on('open', resolve); first.on('error', reject); });
    await sleep(100);
    for (let i = 0; i < 5; i++) {
      const extra = new WebSocket(wsUrl, { rejectUnauthorized: false });
      raw.push(extra);
      extra.on('error', () => {});
      await new Promise((resolve) => { extra.on('open', resolve); extra.on('error', resolve); });
      if (extra.readyState === WebSocket.OPEN) {
        const frame = WebSocket.Sender.frame(Buffer.from([0xff, 0xfe, 0xfd]), {
          fin: true, rsv1: false, opcode: 0x01, mask: true, readOnly: false,
        });
        extra._socket.write(Buffer.concat(frame));
      }
    }
    await sleep(300);
    assert.equal(s.child.exitCode, null, 'server exited');
    assert.ok(s.out.includes(' reject-full '), 'the full connection was refused');
    assert.ok(!s.out.includes('uncaught-exception'), s.out);
  } finally {
    for (const w of raw) w.terminate();
    s.child.kill();
  }
});

test('a client that joins while someone is talking is told who has the floor', async () => {
  const talker = await client('Talker', null);
  send(talker, { type: 'ptt-start' });
  await waitFor(() => last(talker, 'floor')?.holder === talker.id);
  const late = await client('Late', null);
  const floor = last(late, 'floor');
  assert.ok(floor, 'late joiner received no floor message');
  assert.equal(floor.holder, talker.id);
  assert.equal(floor.name, 'Talker');
});

test('a client that joins an idle channel gets no floor message', async () => {
  const c = await client('Quiet', null);
  assert.equal(last(c, 'floor'), undefined);
});

test('a client that stops reading is dropped instead of buffering without limit', async () => {
  const s = await startServer({ MAX_CLIENTS: '4', RELAY_BYTES_PER_SECOND: '1000000000' });
  const socks = [];
  try {
    const mk = async (name) => {
      const ws = new WebSocket(`wss://127.0.0.1:${s.port}`, { rejectUnauthorized: false });
      socks.push(ws);
      ws.msgs = [];
      ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      const welcome = await waitFor(() => last(ws, 'welcome'));
      ws.id = welcome.id;
      ws.send(JSON.stringify({ type: 'join', name }));
      await sleep(100);
      return ws;
    };
    const stuck = await mk('Stuck');
    const sender = await mk('Sender');
    stuck._socket.pause(); // stops reading: the kernel buffers fill, then the server's queue grows
    const payload = { type: 'offer', target: stuck.id, sdp: 'A'.repeat(15000) }; // under the 16 KB per-message cap
    for (let i = 0; i < 1500 && sender.readyState === WebSocket.OPEN; i++) {
      sender.send(JSON.stringify(payload));
      if (i % 100 === 99) await sleep(220); // stay under the per-second message limit
    }
    await sleep(300);
    assert.equal(s.child.exitCode, null, 'server exited');
    assert.ok(s.out.includes(' slow-consumer '), 'the stuck client was not cut off');
    assert.equal(sender.readyState, WebSocket.OPEN, 'the sender must not be affected');
  } finally {
    for (const w of socks) w.terminate();
    s.child.kill();
  }
});

async function connectTo(port, name) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  ws.msgs = [];
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const welcome = await waitFor(() => last(ws, 'welcome'));
  ws.id = welcome.id;
  ws.send(JSON.stringify({ type: 'join', name }));
  await sleep(100);
  return ws;
}

test('a relay flood cuts off the sender and never the reading recipient', async () => {
  const s = await startServer({ MAX_CLIENTS: '4' });
  const socks = [];
  try {
    const radio = await connectTo(s.port, 'Radio');
    const flooder = await connectTo(s.port, 'Flooder');
    socks.push(radio, flooder);
    // 15 KB each is under the per-message cap but far over the per-second byte budget.
    const offer = { type: 'offer', target: radio.id, sdp: { type: 'offer', sdp: 'A'.repeat(15000) } };
    for (let i = 0; i < 400 && flooder.readyState === WebSocket.OPEN; i++) flooder.send(JSON.stringify(offer));
    await sleep(500);
    assert.equal(radio.readyState, WebSocket.OPEN, 'the reading recipient was disconnected');
    assert.notEqual(flooder.readyState, WebSocket.OPEN, 'the flooding sender was not cut off');
    assert.ok(s.out.includes(' relay-flood '), 'no relay-flood log line');
    assert.ok(!s.out.includes(' slow-consumer '), 'the recipient was treated as a slow consumer');
  } finally {
    for (const w of socks) w.terminate();
    s.child.kill();
  }
});

test('oversized offers are dropped, not relayed, and nobody is disconnected for them', async () => {
  const s = await startServer({ MAX_CLIENTS: '4' });
  const socks = [];
  try {
    const radio = await connectTo(s.port, 'Radio');
    const sender = await connectTo(s.port, 'Sender');
    socks.push(radio, sender);
    for (let i = 0; i < 100 && sender.readyState === WebSocket.OPEN; i++) {
      sender.send(JSON.stringify({ type: 'offer', target: radio.id, sdp: { type: 'offer', sdp: 'A'.repeat(31000) } }));
    }
    await sleep(400);
    assert.equal(radio.readyState, WebSocket.OPEN);
    assert.equal(sender.readyState, WebSocket.OPEN);
    assert.equal(radio.msgs.filter((m) => m.type === 'offer').length, 0, 'an oversized offer was relayed');
    assert.ok(s.out.includes(' relay-too-large '));
  } finally {
    for (const w of socks) w.terminate();
    s.child.kill();
  }
});

test('normal-sized negotiation still gets through', async () => {
  const s = await startServer({ MAX_CLIENTS: '4' });
  const socks = [];
  try {
    const a = await connectTo(s.port, 'A');
    const b = await connectTo(s.port, 'B');
    socks.push(a, b);
    a.send(JSON.stringify({ type: 'offer', target: b.id, sdp: { type: 'offer', sdp: 'v=0 '.repeat(1000) } }));
    for (let i = 0; i < 30; i++) a.send(JSON.stringify({ type: 'ice', target: b.id, candidate: { candidate: 'candidate:1 1 UDP 2122252543 10.0.0.1 5000 typ host', sdpMLineIndex: 0 } }));
    await waitFor(() => b.msgs.filter((m) => m.type === 'ice').length === 30);
    assert.equal(b.msgs.filter((m) => m.type === 'offer').length, 1);
    assert.equal(b.msgs.filter((m) => m.type === 'ice').length, 30);
  } finally {
    for (const w of socks) w.terminate();
    s.child.kill();
  }
});

// ---------------------------------------------------------------------------
// Usage records: the optional protocol fields and what lands in the database.
// ---------------------------------------------------------------------------

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* older Node: the server runs without the database */ }
const noSqlite = sqlite ? false : 'node:sqlite is not available in this Node version';

// Reads the main test server's database while the server is running.
function query(sql, ...args) {
  const db = new sqlite.DatabaseSync(path.join(DATA_DIR, 'walkie.db'), { readOnly: true });
  try {
    return db.prepare(sql).all(...args).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

// Joins with any extra `join` fields and optional HTTP headers (a browser sends Origin).
async function joinAs(name, extra = {}, headers = {}) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false, headers });
  ws.msgs = [];
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
  sockets.push(ws);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.id = (await waitFor(() => last(ws, 'welcome'))).id;
  send(ws, { type: 'join', name, ...extra });
  await sleep(100);
  return ws;
}

test('floor messages carry a transmission id while someone talks, and null when free', async () => {
  const a = await client('Alice', null);
  const b = await client('Bob', null);
  send(a, { type: 'ptt-start' });
  const first = await waitFor(() => last(b, 'floor')?.holder === a.id && last(b, 'floor'));
  assert.match(first.tx, /^t[0-9a-z]{8,}$/);
  assert.equal(last(a, 'floor').tx, first.tx, 'everyone must see the same id');

  // Someone who joins mid-transmission gets the same id.
  const late = await client('Late', null);
  assert.equal((await waitFor(() => last(late, 'floor'))).tx, first.tx);

  send(a, { type: 'ptt-stop' });
  const free = await waitFor(() => last(b, 'floor')?.holder === null && last(b, 'floor'));
  assert.equal(free.tx, null);

  send(b, { type: 'ptt-start' });
  const second = await waitFor(() => last(a, 'floor')?.holder === b.id && last(a, 'floor'));
  assert.notEqual(second.tx, first.tx, 'each transmission needs its own id');
});

test('join records the device and role; bad or missing values are replaced, never trusted', { skip: noSqlite }, async () => {
  await joinAs('Good', { device: 'device-good-0001', role: 'gateway' });
  await joinAs('NoFields');
  await joinAs('BadFields', { device: '../../etc/passwd', role: 'admin' }, { Origin: 'https://walkie.test' });
  await joinAs('NotStrings', { device: { a: 1 }, role: 7 });
  await joinAs('TooShort', { device: 'abc' });

  const rows = await waitFor(() => {
    const r = query("SELECT name, device_id, role FROM sessions WHERE name IN ('Good', 'NoFields', 'BadFields', 'NotStrings', 'TooShort')");
    return r.length === 5 && r;
  });
  assert.ok(rows, 'the sessions were not recorded');
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual(by.Good, { name: 'Good', device_id: 'device-good-0001', role: 'gateway' });
  // No role given: no Origin header means the CLI, an Origin header means a browser.
  assert.equal(by.NoFields.role, 'cli');
  assert.equal(by.BadFields.role, 'browser');
  assert.equal(by.NotStrings.role, 'cli');
  for (const name of ['NoFields', 'BadFields', 'NotStrings', 'TooShort']) {
    assert.match(by[name].device_id, /^auto-[0-9a-f]{16}$/, `${name} got ${by[name].device_id}`);
  }
  assert.equal(server.exited, false);
});

test('a device without an id keeps the same derived id across reconnects', { skip: noSqlite }, async () => {
  const first = await joinAs('Stable');
  first.terminate();
  await sleep(100);
  await joinAs('Stable');
  const ids = await waitFor(() => {
    const r = query("SELECT DISTINCT device_id FROM sessions WHERE name = 'Stable'");
    return query("SELECT COUNT(*) AS n FROM sessions WHERE name = 'Stable'")[0].n === 2 && r;
  });
  assert.equal(ids.length, 1);
});

test('the database tells a transmission: who, how long, how it ended, and who could hear it', { skip: noSqlite }, async () => {
  const radio = await joinAs('StoryRadio', { device: 'story-radio-0001', role: 'gateway' });
  const phone = await joinAs('StoryPhone', { device: 'story-phone-0001', role: 'browser' }, { Origin: 'https://walkie.test' });
  const other = await joinAs('StoryOther', { device: 'story-other-0001', role: 'gateway' });

  // 1. Heard: the phone is on screen. (The other gateway never counts as a person.)
  send(radio, { type: 'ptt-start' });
  const tx1 = (await waitFor(() => last(phone, 'floor')?.tx && last(phone, 'floor'))).tx;
  send(phone, { type: 'ptt-start' }); // denied
  await sleep(150);
  send(radio, { type: 'ptt-stop' });
  await waitFor(() => last(phone, 'floor')?.holder === null);

  // 2. Not heard: the phone's screen locked.
  send(phone, { type: 'presence', visible: false, audible: false });
  send(phone, { type: 'presence', visible: false, audible: false }); // no change: not recorded twice
  await sleep(100);
  send(radio, { type: 'ptt-start' });
  const tx2 = (await waitFor(() => last(phone, 'floor')?.tx && last(phone, 'floor'))).tx;
  send(radio, { type: 'ptt-stop' });
  await waitFor(() => last(phone, 'floor')?.holder === null);

  // 3. Hidden but audible (a desktop tab with background audio) counts as heard.
  send(phone, { type: 'presence', visible: false, audible: true });
  await sleep(100);
  send(radio, { type: 'ptt-start' });
  const tx3 = (await waitFor(() => last(phone, 'floor')?.tx && last(phone, 'floor'))).tx;
  // The phone drops mid-transmission.
  phone.terminate();
  await sleep(150);
  radio.terminate(); // and the radio's connection dies while talking
  await sleep(200);
  other.terminate();

  const txs = await waitFor(() => {
    const r = query('SELECT * FROM transmissions WHERE id IN (?, ?, ?) AND ended_at IS NOT NULL ORDER BY started_at', tx1, tx2, tx3);
    return r.length === 3 && r;
  });
  assert.ok(txs, 'the transmissions were not recorded');
  const [t1, t2, t3] = txs;
  assert.equal(t1.name, 'StoryRadio');
  assert.equal(t1.device_id, 'story-radio-0001');
  assert.equal(t1.role, 'gateway');
  assert.equal(t1.end_reason, 'ptt-stop');
  assert.equal(t1.listeners, 2);
  assert.equal(t1.listeners_audible, 1);
  assert.ok(t1.held_ms >= 100 && t1.held_ms < 5000, `held_ms ${t1.held_ms}`);
  assert.equal(t1.ended_at - t1.started_at, t1.held_ms);

  assert.equal(t2.listeners, 2);
  assert.equal(t2.listeners_audible, 0, 'a locked phone was counted as a listener');

  assert.equal(t3.listeners_audible, 1);
  assert.equal(t3.listeners_audible_end, 0, 'the phone had already dropped when it ended');
  assert.equal(t3.end_reason, 'disconnect');

  const denied = query('SELECT holder_tx FROM denied WHERE holder_tx = ?', tx1);
  assert.equal(denied.length, 1);

  const presence = query("SELECT visible, audible FROM presence WHERE session_id = (SELECT id FROM sessions WHERE name = 'StoryPhone') ORDER BY id");
  assert.deepEqual(presence, [{ visible: 0, audible: 0 }, { visible: 0, audible: 1 }]);

  const session = await waitFor(() => query("SELECT * FROM sessions WHERE name = 'StoryPhone' AND left_at IS NOT NULL")[0]);
  assert.ok(session, 'the leave was not recorded');
  assert.equal(session.origin, 'https://walkie.test');
  assert.ok(session.joined_at >= session.connected_at);
  assert.ok(session.left_at >= session.joined_at);
  assert.equal(typeof session.leave_code, 'number');

  const device = query("SELECT kind, last_name FROM devices WHERE id = 'story-radio-0001'")[0];
  assert.deepEqual(device, { kind: 'gateway', last_name: 'StoryRadio' });

  // The raw event log has the same story, in order.
  const events = query('SELECT event FROM events WHERE conn_id = ? ORDER BY id', radio.id).map((r) => r.event);
  assert.deepEqual(events, [
    'connect', 'join',
    'floor-granted', 'floor-released',
    'floor-granted', 'floor-released',
    'floor-granted', 'floor-released',
    'leave',
  ]);
});

test('a preemption and a timeout are recorded as how the transmission ended', { skip: noSqlite }, async () => {
  const normal = await joinAs('EndNormal', { device: 'end-normal-0001' });
  const boss = await joinAs('EndBoss', { device: 'end-boss-00001', token: TOKEN });
  send(normal, { type: 'ptt-start' });
  const tx1 = (await waitFor(() => last(boss, 'floor')?.tx && last(boss, 'floor'))).tx;
  send(boss, { type: 'ptt-start' }); // preempts
  const tx2 = (await waitFor(() => last(normal, 'floor')?.holder === boss.id && last(normal, 'floor'))).tx;
  // ...and never lets go: the server's limit (1 s in tests) ends it.
  await waitFor(() => last(normal, 'floor')?.holder === null, 3000);

  const rows = await waitFor(() => {
    const r = query('SELECT id, end_reason, preempted_by, priority FROM transmissions WHERE id IN (?, ?) AND ended_at IS NOT NULL ORDER BY started_at', tx1, tx2);
    return r.length === 2 && r;
  });
  assert.ok(rows);
  assert.deepEqual(rows[0], { id: tx1, end_reason: 'preempted', preempted_by: tx2, priority: 0 });
  assert.deepEqual(rows[1], { id: tx2, end_reason: 'timeout', preempted_by: null, priority: 1 });
});

test('presence before joining, or with junk values, is ignored', { skip: noSqlite }, async () => {
  const before = query('SELECT COUNT(*) AS n FROM presence')[0].n;
  const ws = await open();
  send(ws, { type: 'presence', visible: false });
  const c = await joinAs('Junk');
  for (const visible of ['no', 0, null, undefined, {}]) send(c, { type: 'presence', visible });
  await sleep(200);
  assert.equal(query('SELECT COUNT(*) AS n FROM presence')[0].n, before);
  assert.equal(server.exited, false);
});

test('the token never reaches the database', { skip: noSqlite }, async () => {
  await joinAs('Secretive', { token: TOKEN });
  await joinAs('Wrong', { token: 'wrong-token-zzzzzzzzzzzzzzzz' });
  await sleep(200);
  const dump = JSON.stringify([query('SELECT * FROM events'), query('SELECT * FROM sessions'), query('SELECT * FROM devices')]);
  assert.ok(!dump.includes(TOKEN));
  assert.ok(!dump.includes('wrong-token-zzzz'));
});

test('STATS=off: the channel works and no database is created', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-test-off-')), 'data');
  const s = await startServer({ STATS: 'off', DATA_DIR: dir });
  const socks = [];
  try {
    const a = await connectTo(s.port, 'A');
    const b = await connectTo(s.port, 'B');
    socks.push(a, b);
    a.send(JSON.stringify({ type: 'ptt-start' }));
    const floor = await waitFor(() => last(b, 'floor')?.holder === a.id && last(b, 'floor'));
    assert.match(floor.tx, /^t[0-9a-z]+$/, 'the transmission id does not depend on the database');
    assert.ok(s.out.includes('stats_db="off"'));
    assert.equal(fs.existsSync(dir), false);
  } finally {
    for (const w of socks) w.terminate();
    s.child.kill();
  }
});

test('a data directory that cannot be written does not stop the server', async () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-test-bad-')), 'file');
  fs.writeFileSync(blocker, 'x');
  const s = await startServer({ STATS: 'on', DATA_DIR: path.join(blocker, 'data') });
  const socks = [];
  try {
    const a = await connectTo(s.port, 'A');
    const b = await connectTo(s.port, 'B');
    socks.push(a, b);
    a.send(JSON.stringify({ type: 'ptt-start' }));
    assert.ok(await waitFor(() => last(b, 'floor')?.holder === a.id));
    assert.ok(s.out.includes(' store-disabled '));
  } finally {
    for (const w of socks) w.terminate();
    s.child.kill();
  }
});

test('the first start writes a backup of the database', { skip: noSqlite }, async () => {
  const files = await waitFor(() => {
    try { return fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((f) => /^walkie-\d{8}\.db$/.test(f)); } catch { return null; }
  });
  assert.equal(files && files.length, 1);
  assert.ok(has(0, ' INFO  store-maintenance ', 'backup="walkie-'));
});

// ---------------------------------------------------------------------------
// The radio gateway: patience with a flaky link, and telling browsers how the radio is doing.
// ---------------------------------------------------------------------------

// A client with a role and device id. Its answers to protocol pings can be switched off and on
// (`ws.answer`), to play a link that stalls and recovers.
async function roleClient(p, name, { role, device, answer = true } = {}) {
  const ws = new WebSocket(`wss://127.0.0.1:${p}`, {
    rejectUnauthorized: false,
    autoPong: false,
    headers: role === 'browser' ? { Origin: 'https://test.local' } : {},
  });
  ws.msgs = [];
  ws.answer = answer;
  ws.on('ping', () => { if (ws.answer) ws.pong(); });
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.id = (await waitFor(() => last(ws, 'welcome'))).id;
  send(ws, { type: 'join', name, role, device });
  await sleep(100);
  return ws;
}

const radioStates = (ws) => ws.msgs.filter((m) => m.type === 'radio').map((m) => m.state);
// True if `wanted` appears in `seen` in this order, other entries allowed in between.
const inOrder = (seen, wanted) => {
  let i = 0;
  for (const s of seen) if (s === wanted[i]) i += 1;
  return i === wanted.length;
};

test('a radio gateway that stalls is given far more time than a normal client before it is dropped', async () => {
  const s = await startServer({ GATEWAY_GRACE_MS: '2400' });
  const socks = [];
  try {
    const gateway = await roleClient(s.port, 'Radio', { role: 'gateway', device: 'gw-grace-0001', answer: false });
    const cli = await roleClient(s.port, 'Other', { role: 'cli', device: 'cli-grace-0001', answer: false });
    socks.push(gateway, cli);
    const t0 = Date.now();
    // A normal client that stops answering is gone after two missed checks.
    await waitFor(() => cli.readyState === WebSocket.CLOSED, 2000);
    assert.equal(cli.readyState, WebSocket.CLOSED, 'a normal client is dropped after two missed checks');
    assert.equal(gateway.readyState, WebSocket.OPEN, 'the gateway is still held at the same moment');
    // The gateway goes only after the grace period.
    await waitFor(() => gateway.readyState === WebSocket.CLOSED, 4000);
    assert.equal(gateway.readyState, WebSocket.CLOSED);
    assert.ok(Date.now() - t0 >= 2000, `dropped after ${Date.now() - t0} ms, expected the grace period`);
    assert.ok(s.out.includes('gateway_grace_ms=2400'));
    assert.match(s.out, /dead-connection id="[0-9a-f]{8}" name="Radio" check="protocol-ping"/);
  } finally {
    for (const w of socks) w.terminate();
    s.child.kill();
  }
});

test('browsers are told how the radio is doing: online, unstable, online again, then offline, then back', async () => {
  const s = await startServer({ HEARTBEAT_MS: '500', GATEWAY_GRACE_MS: '3000' });
  const socks = [];
  try {
    const early = await roleClient(s.port, 'Early', { role: 'browser', device: 'browser-radio-001' });
    socks.push(early);
    await sleep(700);
    assert.deepEqual(radioStates(early), [], 'with no gateway ever seen there is nothing to report');

    const gateway = await roleClient(s.port, 'Radio', { role: 'gateway', device: 'gw-radio-0001' });
    socks.push(gateway);
    await waitFor(() => radioStates(early).includes('online'), 2000);
    assert.equal(radioStates(early)[0], 'online');

    // Someone who arrives later is told the current state when they join.
    const late = await roleClient(s.port, 'Late', { role: 'browser', device: 'browser-radio-002' });
    socks.push(late);
    assert.deepEqual(radioStates(late), ['online']);

    // Only browsers get it.
    const cli = await roleClient(s.port, 'Headless', { role: 'cli', device: 'cli-radio-0001' });
    socks.push(cli);

    // The link stalls ...
    gateway.answer = false;
    await waitFor(() => radioStates(early).includes('unstable'), 3000);
    assert.equal(radioStates(early).at(-1), 'unstable');
    assert.equal(gateway.readyState, WebSocket.OPEN, 'unstable is a warning, not a drop');
    // ... and recovers before the grace period ends: nobody was disconnected.
    gateway.answer = true;
    await waitFor(() => radioStates(early).at(-1) === 'online', 3000);
    assert.equal(gateway.readyState, WebSocket.OPEN);

    // Stalls for good: unstable, then offline once the gateway is dropped.
    gateway.answer = false;
    await waitFor(() => radioStates(early).at(-1) === 'offline', 8000);
    assert.ok(inOrder(radioStates(early), ['online', 'unstable', 'online', 'unstable', 'offline']), radioStates(early).join(','));
    assert.equal(radioStates(late).at(-1), 'offline');

    // A new gateway brings it back.
    const again = await roleClient(s.port, 'Radio', { role: 'gateway', device: 'gw-radio-0001' });
    socks.push(again);
    await waitFor(() => radioStates(early).at(-1) === 'online', 2000);

    assert.deepEqual(radioStates(cli), [], 'the headless client is not sent radio news');
    assert.deepEqual(radioStates(gateway), []);
    assert.ok(s.out.includes(' INFO  radio-state ') && s.out.includes('state="offline"'));
  } finally {
    for (const w of socks) w.terminate();
    s.child.kill();
  }
});

test('a gateway that reconnects replaces its stale old connection at once, without the radio ever showing offline', async () => {
  const s = await startServer({ HEARTBEAT_MS: '500', GATEWAY_GRACE_MS: '30000' });
  const socks = [];
  try {
    const browser = await roleClient(s.port, 'Phone', { role: 'browser', device: 'browser-repl-0001' });
    const old = await roleClient(s.port, 'Radio', { role: 'gateway', device: 'gw-repl-00001', answer: false });
    socks.push(browser, old);
    await waitFor(() => radioStates(browser).includes('online'), 2000);

    const fresh = await roleClient(s.port, 'Radio', { role: 'gateway', device: 'gw-repl-00001' });
    socks.push(fresh);
    await waitFor(() => old.readyState === WebSocket.CLOSED, 1500);
    assert.equal(old.readyState, WebSocket.CLOSED, 'the old connection must go as soon as its replacement joins');
    assert.equal(fresh.readyState, WebSocket.OPEN);

    await waitFor(() => last(browser, 'peers')?.peers.filter((p) => p.name === 'Radio').length === 1, 1500);
    assert.equal(last(browser, 'peers').peers.filter((p) => p.name === 'Radio').length, 1, 'one Radio in the list, not two');
    assert.ok(!radioStates(browser).includes('offline'), `the radio never went offline: ${radioStates(browser).join(',')}`);
    await waitFor(() => s.out.includes('reason="replaced"'), 1500);
    assert.match(s.out, / INFO {2}gateway-replaced id="[0-9a-f]{8}" by_id="[0-9a-f]{8}" name="Radio"/);
    assert.match(s.out, /leave id="[0-9a-f]{8}" name="Radio" joined=true reason="replaced"/);
  } finally {
    for (const w of socks) w.terminate();
    s.child.kill();
  }
});

test('a different gateway device with the same name is not treated as a replacement', async () => {
  const s = await startServer({ GATEWAY_GRACE_MS: '30000' });
  const socks = [];
  try {
    const a = await roleClient(s.port, 'Radio', { role: 'gateway', device: 'gw-twin-a-0001' });
    const b = await roleClient(s.port, 'Radio', { role: 'gateway', device: 'gw-twin-b-0001' });
    socks.push(a, b);
    await sleep(400);
    assert.equal(a.readyState, WebSocket.OPEN);
    assert.equal(b.readyState, WebSocket.OPEN);
  } finally {
    for (const w of socks) w.terminate();
    s.child.kill();
  }
});

test('a restarted server still says the radio is offline until the gateway is back', { skip: noSqlite }, async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-test-radio-')), 'data');
  const first = await startServer({ STATS: 'on', DATA_DIR: dir });
  let gateway;
  try {
    gateway = await roleClient(first.port, 'Radio', { role: 'gateway', device: 'gw-restart-0001' });
    await sleep(200);
  } finally {
    if (gateway) gateway.terminate();
    await sleep(200);
    first.child.kill();
    await new Promise((resolve) => first.child.on('exit', resolve));
  }

  const second = await startServer({ STATS: 'on', DATA_DIR: dir });
  const socks = [];
  try {
    const browser = await roleClient(second.port, 'Phone', { role: 'browser', device: 'browser-restart-01' });
    socks.push(browser);
    await waitFor(() => radioStates(browser).length > 0, 1500);
    assert.deepEqual(radioStates(browser), ['offline']);
    const back = await roleClient(second.port, 'Radio', { role: 'gateway', device: 'gw-restart-0001' });
    socks.push(back);
    await waitFor(() => radioStates(browser).at(-1) === 'online', 2000);
  } finally {
    for (const w of socks) w.terminate();
    second.child.kill();
  }
});

test('a server that never had a gateway says nothing about the radio, even with the database on', { skip: noSqlite }, async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-test-noradio-')), 'data');
  const s = await startServer({ STATS: 'on', DATA_DIR: dir });
  const socks = [];
  try {
    const browser = await roleClient(s.port, 'Phone', { role: 'browser', device: 'browser-nogw-0001' });
    const other = await roleClient(s.port, 'Other', { role: 'cli', device: 'cli-nogw-000001' });
    socks.push(browser, other);
    await sleep(800);
    assert.deepEqual(radioStates(browser), []);
  } finally {
    for (const w of socks) w.terminate();
    s.child.kill();
  }
});

// Express reads NODE_ENV at require time; default to production so error
// responses (e.g. a bad Range header on a static file) never carry stack traces.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';

const express = require('express');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { execFileSync } = require('child_process');
const { createLogger, createThrottle, createKeyedThrottle } = require('./lib/logger');
const { createStore } = require('./lib/store');
const { createAdminRouter } = require('./lib/admin');

// LOG_LEVEL: debug | info (default) | warn | error.  LOG_FORMAT: text (default) | json.
// LOG_STATS_MS: how often to write a one-line summary; 0 turns it off (default 5 minutes).
const log = createLogger({
  level: (process.env.LOG_LEVEL || 'info').trim().toLowerCase(),
  format: (process.env.LOG_FORMAT || 'text').trim().toLowerCase(),
});
const LOG_STATS_MS = process.env.LOG_STATS_MS === undefined ? 300000 : Math.max(0, Number(process.env.LOG_STATS_MS) || 0);
const STARTED_AT = Date.now();
const shortId = (id) => String(id).slice(0, 8);

// A crash must leave a line in the log (the default prints a bare stack to stderr),
// and must still end the process so the container restarts, as it did before.
function logFatal(event, err) {
  log.error(event, {
    error: err && err.message,
    code: err && err.code,
    stack: String((err && err.stack) || '').split('\n').slice(0, 6).map((l) => l.trim()).join(' | '),
  });
  process.exit(1);
}
process.on('uncaughtException', (err) => logFatal('uncaught-exception', err));
process.on('unhandledRejection', (err) => logFatal('unhandled-rejection', err instanceof Error ? err : new Error(String(err))));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log.info('shutdown', { signal });
    store.event('server-stop', null, { signal });
    store.close();
    process.exit(0);
  });
}

// Usage database (lib/store.js): sessions, transmissions and a raw event log in
// SQLite. STATS=off turns it off. It can never affect the channel: if it cannot
// be opened or a write fails, the server logs it and carries on without it.
const isOff = (value) => ['0', 'false', 'off', 'no'].includes(String(value || '').trim().toLowerCase());
const STATS = !isOff(process.env.STATS);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EVENT_RETENTION_DAYS = Math.max(1, Number(process.env.EVENT_RETENTION_DAYS) || 400);
const store = createStore({ enabled: STATS, dir: DATA_DIR, log, retentionDays: EVENT_RETENTION_DAYS });
const MAINTENANCE_MS = 60 * 60 * 1000;

const PORT = Number(process.env.PORT) || 8443;
const CERT_DIR = path.join(__dirname, 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');

const MAX_TRANSMIT_MS = Number(process.env.MAX_TRANSMIT_MS) || 60000;
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 32;
const MAX_MESSAGE_BYTES = 32 * 1024; // SDP offers are a few KB; nothing legitimate is near this
const MAX_MESSAGES_PER_SECOND = 500; // flood guard, well above a burst of ICE candidates
const NAME_MAX_CHARS = 24;
// Dead-connection detection. A phone that roams between access points can
// vanish without closing its socket; without this it would hold the floor
// until MAX_TRANSMIT_MS and stay in everyone's peer list.
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 5000;
// Roger beep: a short courtesy tone every client plays when the channel goes
// from "someone is talking" to free. One global switch, off unless asked for;
// the server only announces it (in `welcome`) and never touches audio.
const ROGER_BEEP = ['1', 'true', 'on', 'yes'].includes(String(process.env.ROGER_BEEP || '').trim().toLowerCase());
const MIN_TOKEN_LENGTH = 16;
const PLACEHOLDER_TOKENS = new Set(['some-long-random-string', 'changeme', 'change-me', 'secret']);

// Optional: comma-separated list of origins (e.g. https://walkie.example.ts.net)
// allowed to open the WebSocket from a browser. Unset = no Origin check, the
// previous behavior. Non-browser clients (the CLI) send no Origin and are
// always allowed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Pages allowed to show the walkie inside an <iframe> (for example a Home
// Assistant dashboard). Space- or comma-separated origins, e.g.
// "https://ha.example.ts.net:8444". Unset keeps the old behavior: no framing.
// Each entry must be a bare http(s) origin (no path, quotes or ';'), so a typo
// or hostile value can never inject another CSP directive; "*" is never valid.
const FRAME_ORIGIN_RE = /^https?:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const FRAME_ANCESTORS = [];
for (const o of (process.env.FRAME_ANCESTORS || '').split(/[\s,]+/).filter(Boolean)) {
  if (FRAME_ORIGIN_RE.test(o)) FRAME_ANCESTORS.push(o);
  else log.warn('frame-ancestors-ignored', { reason: 'not a plain http(s) origin' });
}

// Whoever joins with this token is marked priority and can preempt a
// non-priority speaker. Leave unset to disable priority entirely.
let PRIORITY_TOKEN = process.env.PRIORITY_TOKEN || null;
if (PRIORITY_TOKEN && (PRIORITY_TOKEN.length < MIN_TOKEN_LENGTH || PLACEHOLDER_TOKENS.has(PRIORITY_TOKEN.toLowerCase()))) {
  log.error('priority-disabled', {
    reason: `PRIORITY_TOKEN is a placeholder or shorter than ${MIN_TOKEN_LENGTH} characters`,
    fix: 'generate one with: openssl rand -hex 24',
  });
  PRIORITY_TOKEN = null;
}
const PRIORITY_DIGEST = PRIORITY_TOKEN ? sha256(PRIORITY_TOKEN) : null;

// Admin page (public/admin.html) and its read-only API (lib/admin.js).
// ADMIN_TOKEN unset: open to whoever can reach the server. Set: every API
// request needs it. A token that is set but unusable closes the API rather
// than silently leaving it open.
let ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
let ADMIN_DISABLED = null;
if (ADMIN_TOKEN && (ADMIN_TOKEN.length < MIN_TOKEN_LENGTH || PLACEHOLDER_TOKENS.has(ADMIN_TOKEN.toLowerCase()))) {
  log.error('admin-disabled', {
    reason: `ADMIN_TOKEN is a placeholder or shorter than ${MIN_TOKEN_LENGTH} characters`,
    fix: 'generate one with: openssl rand -hex 24 (or unset it to leave the admin page open)',
  });
  ADMIN_TOKEN = null;
  ADMIN_DISABLED = 'bad-token';
}
// Transmissions closer together than this belong to one conversation.
const CONVERSATION_GAP_S = Math.max(1, Number(process.env.CONVERSATION_GAP_S) || 60);

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest();
}

function tokenMatches(candidate) {
  if (!PRIORITY_DIGEST || typeof candidate !== 'string') return false;
  return crypto.timingSafeEqual(sha256(candidate), PRIORITY_DIGEST);
}

function detectLocalAddresses() {
  const ips = new Set(['127.0.0.1']);
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface || []) {
      if (addr.family === 'IPv4' && !addr.internal) ips.add(addr.address);
    }
  }
  return [...ips];
}

function ensureCert() {
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) return;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  log.info('cert-generate', {});

  // Autodetection sees whatever network namespace this process runs in.
  // Inside Docker that's the container's internal identity (e.g. 172.18.0.2),
  // not the LAN address people actually visit — so let it be overridden.
  const extraHosts = (process.env.CERT_HOSTNAMES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const extraIps = (process.env.CERT_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const hostname = os.hostname();
  const ips = new Set([...detectLocalAddresses(), ...extraIps]);
  const sanEntries = [
    'DNS:localhost',
    `DNS:${hostname}`,
    ...extraHosts.map((h) => `DNS:${h}`),
    ...[...ips].map((ip) => `IP:${ip}`),
  ].join(',');

  log.info('cert-names', { covers: sanEntries });
  // execFileSync, not execSync: hostnames and CERT_* values go in as argv
  // entries and never touch a shell.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', KEY_PATH, '-out', CERT_PATH,
    '-days', '3650', '-nodes',
    '-subj', `/CN=${hostname}`,
    '-addext', `subjectAltName=${sanEntries}`,
  ]);
  try { fs.chmodSync(KEY_PATH, 0o600); } catch { /* best effort (Windows) */ }
}

// Display names are peer-supplied and end up in other users' UIs, terminals
// and our own logs. Slice by code point first, then strip control, format,
// surrogate and line/paragraph-separator characters and the priority star,
// so a name can neither forge the priority marker nor smuggle escapes.
function cleanName(value) {
  if (typeof value !== 'string') return 'Anon';
  const sliced = Array.from(value).slice(0, NAME_MAX_CHARS).join('');
  const cleaned = sliced.replace(/[\p{C}\p{Zl}\p{Zp}⭐]/gu, '').trim();
  return cleaned || 'Anon';
}

// Optional fields of `join`, used only for the usage records.
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ROLES = ['browser', 'cli', 'gateway'];
// A client that sends no (or a bad) device id still gets a stable one, as long
// as its name and user agent stay the same.
function deviceIdFor(value, name, ua) {
  if (typeof value === 'string' && DEVICE_RE.test(value)) return value;
  return 'auto-' + sha256(`${name}|${ua || ''}`).toString('hex').slice(0, 16);
}
// Older clients send no role: a browser always sends an Origin header, the CLI never does.
function roleFor(value, origin) {
  if (ROLES.includes(value)) return value;
  return origin ? 'browser' : 'cli';
}

ensureCert();

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; connect-src 'self' wss:; media-src 'self' blob: mediastream:; " +
      "img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors " +
      (FRAME_ANCESTORS.length ? FRAME_ANCESTORS.join(' ') : "'none'"),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  // X-Frame-Options cannot express an allow-list; with FRAME_ANCESTORS set the
  // CSP directive above is the only framing rule.
  if (!FRAME_ANCESTORS.length) res.set('X-Frame-Options', 'DENY');
  next();
});
app.use('/api/admin', createAdminRouter({
  store, log, token: ADMIN_TOKEN, disabledReason: ADMIN_DISABLED, conversationGapS: CONVERSATION_GAP_S,
  throttle: createKeyedThrottle(10000),
}));
app.use(express.static(path.join(__dirname, 'public')));

const server = https.createServer(
  {
    key: fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH),
  },
  app
);

const remoteIp = (req) => String((req && req.socket && req.socket.remoteAddress) || '?').replace(/^::ffff:/, '');
// One limit per source, so a noisy device cannot hide another device's problem.
const originThrottle = createKeyedThrottle(10000);
const fullThrottle = createKeyedThrottle(10000);
const tokenThrottle = createKeyedThrottle(10000);
const tlsThrottle = createKeyedThrottle(5000);

const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_MESSAGE_BYTES,
  verifyClient: ({ origin, req }) => {
    if (!ALLOWED_ORIGINS.length || !origin) return true;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    originThrottle(remoteIp(req), (suppressed) => log.warn('reject-origin', { ip: remoteIp(req), origin, suppressed }));
    return false;
  },
});

// A browser that refuses the certificate, or something probing the port without
// speaking TLS, never reaches the app; without this nothing would show it.
server.on('tlsClientError', (err, socket) => {
  tlsThrottle(remoteIp({ socket }), (suppressed) => log.info('tls-error', { ip: remoteIp({ socket }), code: err && err.code, suppressed }));
  socket.destroy();
});

const clients = new Map(); // id -> { ws, name, priority, joined }
let floorHolder = null; // id of whoever currently has permission to transmit
let floorTimer = null;
let floorSince = 0;
let floorTx = null; // id of the current transmission, sent in `floor` and used as its database key

// Sortable by time, unique, and safe as a file name (recordings will use it).
const newTxId = () => 't' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

// Who is there to hear a transmission: every joined client but the speaker,
// and of those the ones a person can actually hear it on (not a gateway, and
// playing audio, which a phone with a locked screen is not).
function listenerCounts(holderId) {
  let all = 0;
  let audible = 0;
  for (const [cid, c] of clients) {
    if (!c.joined || cid === holderId) continue;
    all += 1;
    if (c.role !== 'gateway' && c.audible) audible += 1;
  }
  return { all, audible };
}

function endTransmission(reason, holderId, preemptedBy) {
  if (!floorTx) return;
  store.txEnd({ tx: floorTx, reason, preemptedBy, listenersAudible: listenerCounts(holderId).audible });
  floorTx = null;
}

// A client that stops reading must not make the server buffer for it without
// limit (inbound is capped per message and per second, outbound was not).
const MAX_OUTBOUND_BYTES = 512 * 1024;

// Relayed WebRTC messages (offer/answer/ice) are small in real use (a few KB). Without
// limits one sender could fill another client's outbound queue, and the cutoff above would
// then disconnect the VICTIM (for example the radio gateway) instead of the sender.
const MAX_RELAY_SDP_BYTES = 16 * 1024;
const MAX_RELAY_ICE_BYTES = 4 * 1024;
// Overridable (RELAY_BYTES_PER_SECOND) so tests can exercise the outbound cutoff on its own.
const MAX_RELAY_BYTES_PER_SECOND = Number(process.env.RELAY_BYTES_PER_SECOND) || 256 * 1024;

function send(ws, msg) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const data = JSON.stringify(msg);
  if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_OUTBOUND_BYTES) {
    log.warn('slow-consumer', { buffered: ws.bufferedAmount, limit: MAX_OUTBOUND_BYTES });
    ws.terminate();
    return;
  }
  ws.send(data, (err) => { if (err) ws.terminate(); });
}

function broadcastFloor() {
  const holder = floorHolder ? clients.get(floorHolder) : null;
  for (const [, c] of clients) {
    if (!c.joined) continue;
    send(c.ws, { type: 'floor', holder: floorHolder, name: holder?.name || null, priority: !!holder?.priority, tx: floorTx });
  }
}

function grantFloor(id) {
  const tx = newTxId();
  if (floorHolder !== null) endTransmission('preempted', floorHolder, tx); // taken over by a priority speaker
  floorHolder = id;
  floorSince = Date.now();
  floorTx = tx;
  const holder = clients.get(id);
  log.info('floor-granted', { id: shortId(id), name: holder?.name, priority: !!holder?.priority });
  const heard = listenerCounts(id);
  store.txStart({
    tx, connId: id, name: holder?.name, role: holder?.role, priority: !!holder?.priority,
    listeners: heard.all, listenersAudible: heard.audible, ts: floorSince,
  });
  store.event('floor-granted', id, { tx, name: holder?.name, priority: !!holder?.priority, listeners: heard.all, listeners_audible: heard.audible }, floorSince);
  broadcastFloor();
  clearTimeout(floorTimer);
  // Safety net: a frozen tab, a dead battery, or a crashed CLI client should
  // never be able to lock the channel forever.
  floorTimer = setTimeout(() => {
    if (floorHolder === id) {
      log.warn('floor-timeout', { id: shortId(id), name: clients.get(id)?.name, held_ms: Date.now() - floorSince, limit_ms: MAX_TRANSMIT_MS });
      store.event('floor-timeout', id, { tx: floorTx, held_ms: Date.now() - floorSince });
      endTransmission('timeout', id);
      floorHolder = null;
      broadcastFloor();
    }
  }, MAX_TRANSMIT_MS);
}

// `who` is passed on disconnect, when the client is already gone from `clients`.
function releaseFloorIfHeldBy(id, reason, who) {
  if (floorHolder === id) {
    log.info('floor-released', { id: shortId(id), name: (who || clients.get(id))?.name, reason, held_ms: Date.now() - floorSince });
    store.event('floor-released', id, { tx: floorTx, reason, held_ms: Date.now() - floorSince });
    endTransmission(reason, id);
    floorHolder = null;
    clearTimeout(floorTimer);
    broadcastFloor();
  }
}

const joinedCount = () => [...clients.values()].filter((c) => c.joined).length;

function broadcastPeerList() {
  const list = [...clients.entries()]
    .filter(([, c]) => c.joined)
    .map(([id, c]) => ({ id, name: c.name, priority: c.priority }));
  for (const [id, c] of clients) {
    if (!c.joined) continue;
    send(c.ws, { type: 'peers', peers: list.filter((p) => p.id !== id) });
  }
}

wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CLIENTS) {
    // Without a listener, a bad frame sent while this socket is closing
    // (invalid UTF-8, oversize) is an unhandled 'error' and kills the process.
    ws.on('error', () => ws.terminate());
    fullThrottle(remoteIp(req), (suppressed) => log.warn('reject-full', { ip: remoteIp(req), max_clients: MAX_CLIENTS, suppressed }));
    ws.close(1013, 'server full');
    return;
  }

  const id = crypto.randomBytes(8).toString('hex');
  const me = {
    ws, name: 'Anon', priority: false, joined: false, alive: true, missedPongs: 0, lastPong: Date.now(), appPing: false, lastMsg: Date.now(),
    connectedAt: Date.now(), endReason: null, ip: remoteIp(req), relayWindowStart: 0, relayBytes: 0,
    // For the usage records. A client is taken as on screen and audible until it says otherwise.
    device: null, role: null, visible: true, audible: true,
    // Per-connection limits on log lines a misbehaving client could repeat; freed with the connection.
    frameThrottle: createThrottle(5000), deniedThrottle: createThrottle(1000), errorThrottle: createThrottle(1000),
  };
  clients.set(id, me);
  log.info('connect', {
    id: shortId(id), ip: me.ip, origin: req.headers.origin, ua: req.headers['user-agent'], clients: clients.size,
  });
  store.sessionStart({ connId: id, ip: me.ip, ua: req.headers['user-agent'], origin: req.headers.origin, ts: me.connectedAt });
  store.event('connect', id, { ip: me.ip, origin: req.headers.origin, ua: req.headers['user-agent'], clients: clients.size }, me.connectedAt);

  // Without a listener, an 'error' event (invalid UTF-8, oversize frame,
  // reset) is thrown by EventEmitter and takes the whole process down.
  ws.on('error', (err) => {
    me.endReason = me.endReason || 'socket-error';
    me.errorThrottle((suppressed) => log.warn('socket-error', { id: shortId(id), code: err && err.code, error: err && err.message, suppressed }));
    ws.terminate();
  });
  ws.on('pong', () => { me.alive = true; me.missedPongs = 0; me.lastPong = Date.now(); });

  send(ws, { type: 'welcome', id, rogerBeep: ROGER_BEEP });

  let windowStart = Date.now();
  let windowCount = 0;

  function handle(msg) {
    // Application-level liveness. Needed because a reverse proxy (e.g.
    // Tailscale Serve) answers protocol pings itself, which would hide a dead
    // phone behind it. Browsers send this every few seconds.
    if (msg.type === 'ping') {
      me.appPing = true;
      send(ws, { type: 'pong' });
      return;
    }

    if (msg.type === 'join') {
      const again = me.joined;
      me.name = cleanName(msg.name);
      me.priority = tokenMatches(msg.token);
      me.joined = true;
      // Never the token itself, only that one was offered and why it did not count.
      if (typeof msg.token === 'string' && msg.token && !me.priority) {
        tokenThrottle(`${me.ip}|${me.name}`, (suppressed) =>
          log.warn('priority-denied', { id: shortId(id), name: me.name, reason: PRIORITY_DIGEST ? 'wrong-token' : 'priority-disabled-on-server', suppressed }));
      }
      log.info('join', { id: shortId(id), name: me.name, priority: me.priority, again, clients: joinedCount() });
      me.device = deviceIdFor(msg.device, me.name, req.headers['user-agent']);
      me.role = roleFor(msg.role, req.headers.origin);
      store.sessionJoin({ connId: id, deviceId: me.device, name: me.name, role: me.role, ua: req.headers['user-agent'] });
      store.event('join', id, { name: me.name, device: me.device, role: me.role, priority: me.priority, again, clients: joinedCount() });
      broadcastPeerList();
      // A late joiner (e.g. the gateway reconnecting) must learn who is talking
      // now; otherwise it stays unaware until the next floor change. Sent only
      // while the floor is held, and without re-granting or re-arming the timer.
      if (floorHolder !== null) {
        const holder = clients.get(floorHolder);
        send(ws, { type: 'floor', holder: floorHolder, name: holder?.name || null, priority: !!holder?.priority, tx: floorTx });
      }
      return;
    }

    if (!me.joined) {
      log.debug('ignored-before-join', { id: shortId(id), type: msg.type });
      return;
    }

    // Whether the page is on screen and playing received audio. Only changes
    // are recorded. `audible` is optional and defaults to `visible`.
    if (msg.type === 'presence') {
      if (typeof msg.visible !== 'boolean') return;
      const audible = typeof msg.audible === 'boolean' ? msg.audible : msg.visible;
      if (msg.visible === me.visible && audible === me.audible) return;
      me.visible = msg.visible;
      me.audible = audible;
      log.debug('presence', { id: shortId(id), name: me.name, visible: me.visible, audible: me.audible });
      store.presence({ connId: id, visible: me.visible, audible: me.audible });
      store.event('presence', id, { visible: me.visible, audible: me.audible });
      return;
    }

    if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') {
      if (typeof msg.target !== 'string') return;
      const target = clients.get(msg.target);
      if (target && target.joined && msg.target !== id) {
        log.debug('relay', { type: msg.type, from: shortId(id), to: shortId(msg.target) });
        // Whitelist the relayed fields; `from` and `name` are always ours.
        const relayed = {
          type: msg.type,
          target: msg.target,
          sdp: msg.sdp,
          candidate: msg.candidate,
          from: id,
          name: me.name,
        };
        const size = Buffer.byteLength(JSON.stringify(relayed));
        const limit = msg.type === 'ice' ? MAX_RELAY_ICE_BYTES : MAX_RELAY_SDP_BYTES;
        if (size > limit) {
          me.frameThrottle((suppressed) =>
            log.warn('relay-too-large', { id: shortId(id), type: msg.type, bytes: size, limit, suppressed }));
          return;
        }
        const nowMs = Date.now();
        if (nowMs - me.relayWindowStart >= 1000) {
          me.relayWindowStart = nowMs;
          me.relayBytes = 0;
        }
        me.relayBytes += size;
        if (me.relayBytes > MAX_RELAY_BYTES_PER_SECOND) {
          // The sender is the problem, not the recipient: cut the sender off.
          me.endReason = 'relay-flood';
          log.warn('relay-flood', { id: shortId(id), name: me.name, limit_bytes_per_s: MAX_RELAY_BYTES_PER_SECOND });
          ws.terminate();
          return;
        }
        send(target.ws, relayed);
      } else {
        log.debug('relay-dropped', { type: msg.type, from: shortId(id), to: shortId(msg.target) });
      }
      return;
    }

    if (msg.type === 'ptt-start') {
      // Already the holder: nothing to do. Re-granting would re-arm the
      // transmit timer and let a client keep the floor forever.
      if (floorHolder === id) {
        log.debug('ptt-start-ignored', { id: shortId(id), reason: 'already-holder' });
        return;
      }

      const holder = floorHolder ? clients.get(floorHolder) : null;
      if (floorHolder === null) {
        grantFloor(id);
      } else if (me.priority && !holder?.priority) {
        log.info('floor-preempted', { by_id: shortId(id), by: me.name, from_id: shortId(floorHolder), from: holder?.name });
        store.event('floor-preempted', id, { tx: floorTx, by: me.name, from_conn: floorHolder, from: holder?.name });
        if (holder) send(holder.ws, { type: 'floor-preempted', by: me.name });
        grantFloor(id);
      } else {
        send(ws, { type: 'floor-denied', holder: floorHolder, name: holder?.name });
        // Recorded at the same limited rate as the log line, so a client that
        // hammers the button cannot fill the database.
        me.deniedThrottle((suppressed) => {
          log.info('floor-denied', { id: shortId(id), name: me.name, holder_id: shortId(floorHolder), holder: holder?.name, suppressed });
          store.denied({ connId: id, holderTx: floorTx });
          store.event('floor-denied', id, { name: me.name, holder_tx: floorTx, holder: holder?.name, suppressed });
        });
      }
      return;
    }

    if (msg.type === 'ptt-stop') {
      if (floorHolder === id) releaseFloorIfHeldBy(id, 'ptt-stop', me);
      else log.debug('ptt-stop-ignored', { id: shortId(id), reason: 'not-holder' });
      return;
    }

    log.debug('unknown-message', { id: shortId(id), type: msg.type });
  }

  ws.on('message', (raw) => {
    const now = Date.now();
    me.alive = true;
    me.lastMsg = now;
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > MAX_MESSAGES_PER_SECOND) {
      if (!me.endReason) {
        me.endReason = 'flood';
        log.warn('flood', { id: shortId(id), name: me.name, limit_per_s: MAX_MESSAGES_PER_SECOND });
      }
      ws.terminate();
      return;
    }

    let msg;
    // Only the size and kind of a bad frame are logged, never its content.
    const bad = (reason) =>
      me.frameThrottle((suppressed) => log.warn('invalid-frame', { id: shortId(id), reason, bytes: raw.length, suppressed }));
    try {
      msg = JSON.parse(raw);
    } catch {
      bad('not-json');
      return;
    }
    // JSON.parse('null') is valid JSON; so are arrays and bare strings.
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      bad('not-an-object');
      return;
    }

    try {
      handle(msg);
    } catch (err) {
      // Drop the bad message, keep the process (and everyone else's channel).
      me.errorThrottle((suppressed) =>
        log.error('message-error', { id: shortId(id), type: msg.type, error: err && err.message, suppressed }));
    }
  });

  ws.on('close', (code) => {
    clients.delete(id);
    releaseFloorIfHeldBy(id, 'disconnect', me);
    broadcastPeerList();
    log.info('leave', {
      id: shortId(id), name: me.joined ? me.name : undefined, joined: me.joined,
      reason: me.endReason || 'closed', code, duration_s: Math.round((Date.now() - me.connectedAt) / 1000), clients: clients.size,
    });
    store.sessionEnd({ connId: id, reason: me.endReason || 'closed', code });
    store.event('leave', id, { name: me.joined ? me.name : undefined, joined: me.joined, reason: me.endReason || 'closed', code, clients: clients.size });
  });
});

// A client that does not answer protocol pings is dropped after this many
// checks in a row with no answer, not after one: a pause of a few seconds on
// the server (a stalled disk) or on the way (Wi-Fi, a Tailscale path change)
// is not a dead connection. Browsers are judged on their own app-level ping.
const MISSED_PONGS_LIMIT = Math.max(1, Number(process.env.MISSED_PONGS_LIMIT) || 2);
// A check that runs this much later than it should means this process was
// stalled, so what looks like silence may be replies it had not read yet.
const LAG_SKIP_MS = Math.max(250, HEARTBEAT_MS / 5);
let lastBeat = Date.now();
const lagThrottle = createThrottle(60000);

const heartbeat = setInterval(() => {
  const now = Date.now();
  const lag = now - lastBeat - HEARTBEAT_MS;
  lastBeat = now;
  if (lag > LAG_SKIP_MS) {
    // Judge nobody this round, and ping again so the answers can come in.
    lagThrottle((suppressed) => log.warn('event-loop-lag', { lag_ms: Math.round(lag), clients: clients.size, suppressed }));
    store.event('event-loop-lag', null, { lag_ms: Math.round(lag), clients: clients.size });
    for (const c of clients.values()) {
      c.alive = false;
      try { c.ws.ping(); } catch { /* socket already going away */ }
    }
    return;
  }
  for (const [id, c] of clients) {
    // Browsers ping at the application level, so judge them on that;
    // everyone else on protocol-level pongs.
    if (!c.appPing && !c.alive) c.missedPongs += 1;
    const stale = c.appPing ? now - c.lastMsg > 2 * HEARTBEAT_MS + 1000 : c.missedPongs >= MISSED_PONGS_LIMIT;
    if (stale) {
      const detail = {
        name: c.joined ? c.name : undefined,
        check: c.appPing ? 'app-ping' : 'protocol-ping',
        silent_s: Math.round((now - c.lastMsg) / 1000),
        since_pong_s: Math.round((now - c.lastPong) / 1000),
      };
      c.endReason = 'dead-connection';
      log.warn('dead-connection', { id: shortId(id), ...detail });
      store.event('dead-connection', id, detail);
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    try { c.ws.ping(); } catch { /* socket already going away */ }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = detectLocalAddresses().find((ip) => ip !== '127.0.0.1') || 'localhost';
  log.info('config', {
    version: require('./package.json').version,
    node: process.version,
    pid: process.pid,
    port: PORT,
    max_clients: MAX_CLIENTS,
    max_transmit_ms: MAX_TRANSMIT_MS,
    heartbeat_ms: HEARTBEAT_MS,
    priority: PRIORITY_TOKEN ? 'enabled' : 'disabled',
    roger_beep: ROGER_BEEP ? 'on' : 'off',
    allowed_origins: ALLOWED_ORIGINS.length,
    frame_ancestors: FRAME_ANCESTORS.length,
    log_level: log.level,
    log_format: log.format,
    stats_ms: LOG_STATS_MS,
    stats_db: store.enabled ? 'on' : store.reason,
    admin: ADMIN_DISABLED ? 'disabled' : ADMIN_TOKEN ? 'token' : 'open',
    conversation_gap_s: CONVERSATION_GAP_S,
    event_retention_days: EVENT_RETENTION_DAYS,
  });
  // Said out loud once per start, so an open admin page is a choice, not an accident.
  if (store.enabled && !ADMIN_TOKEN && !ADMIN_DISABLED) {
    log.warn('admin-open', { note: 'usage statistics at /admin.html are readable by anyone who can reach this server; set ADMIN_TOKEN to require a token' });
  }
  store.event('server-start', null, { version: require('./package.json').version, node: process.version });
  if (store.enabled) {
    // Purge old raw events and write the daily backup. Checked hourly; the
    // backup itself only happens when today's file does not exist yet.
    const maintain = () => {
      const done = store.maintain();
      if (done && (done.purged || done.backup || done.removed)) log.info('store-maintenance', done);
    };
    maintain();
    setInterval(maintain, MAINTENANCE_MS).unref();
  }
  log.info('listening', { url: `https://${lanIp}:${PORT}` });
  if (LOG_STATS_MS > 0) {
    const stats = setInterval(() => {
      log.info('stats', {
        clients: clients.size,
        joined: joinedCount(),
        floor: floorHolder ? clients.get(floorHolder)?.name || 'unknown' : 'idle',
        uptime_s: Math.round((Date.now() - STARTED_AT) / 1000),
        rss_mb: Math.round(process.memoryUsage().rss / 1048576),
      });
    }, LOG_STATS_MS);
    stats.unref();
  }
});

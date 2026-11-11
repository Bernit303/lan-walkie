// Read-only JSON API over the usage database, for public/admin.html.
//
//   GET /api/admin/range?from=<ms>&to=<ms>   transmissions, sessions, conversations, per-device totals
//   GET /api/admin/devices                   every device ever seen, with all-time totals
//   GET /api/admin/export.csv?table=transmissions|sessions&from=<ms>&to=<ms>
//
// Nothing here writes. Access: with no token configured the API is open to
// whoever can reach the server; with a token, every request needs
// `Authorization: Bearer <token>`. The token is compared in constant time and
// is never logged.

const crypto = require('crypto');
const express = require('express');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 400 * DAY_MS;
const MAX_ROWS = 20000;

const TX_COLUMNS = [
  'id', 'session_id', 'device_id', 'name', 'role', 'priority', 'started_at', 'ended_at', 'held_ms', 'end_reason',
  'preempted_by', 'listeners', 'listeners_audible', 'listeners_audible_end', 'recording_bytes',
];
const SESSION_COLUMNS = [
  'id', 'conn_id', 'device_id', 'name', 'role', 'ip', 'ua', 'origin', 'connected_at', 'joined_at', 'left_at',
  'leave_reason', 'leave_code', 'duration_s',
];

// Groups transmissions (sorted by start) into conversations: a new one starts
// when the channel was quiet for more than `gapMs` since the previous
// transmission ended.
function groupConversations(transmissions, gapMs) {
  const out = [];
  let current = null;
  for (const t of transmissions) {
    const end = t.ended_at === null || t.ended_at === undefined ? t.started_at + (t.held_ms || 0) : t.ended_at;
    if (!current || t.started_at - current.ended_at > gapMs) {
      current = { started_at: t.started_at, ended_at: end, turns: 0, talk_ms: 0, people: new Map() };
      out.push(current);
    }
    current.ended_at = Math.max(current.ended_at, end);
    current.turns += 1;
    current.talk_ms += t.held_ms || 0;
    const key = t.device_id || t.name || '?';
    const person = current.people.get(key) || { device_id: t.device_id || null, name: t.name, role: t.role, turns: 0, talk_ms: 0 };
    person.name = t.name; // the latest name the device used
    person.turns += 1;
    person.talk_ms += t.held_ms || 0;
    current.people.set(key, person);
  }
  return out.map((c) => ({
    started_at: c.started_at,
    ended_at: c.ended_at,
    length_ms: c.ended_at - c.started_at,
    turns: c.turns,
    talk_ms: c.talk_ms,
    participants: [...c.people.values()].sort((a, b) => b.talk_ms - a.talk_ms),
  }));
}

// One CSV cell. Text that a spreadsheet would run as a formula is defused
// with a leading apostrophe: names and user agents come from peers.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

function createAdminRouter({ store, log, token = null, disabledReason = null, conversationGapS = 60, throttle = (key, emit) => emit(0), now = () => Date.now() }) {
  const router = express.Router();
  const digest = token ? crypto.createHash('sha256').update(token).digest() : null;
  const remoteIp = (req) => String((req.socket && req.socket.remoteAddress) || '?').replace(/^::ffff:/, '');

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'read-only' });
    // A token that was set but refused (too short, a placeholder) must not
    // leave the data open: fail closed.
    if (disabledReason) return res.status(403).json({ error: 'admin-disabled', reason: disabledReason });
    if (digest) {
      const header = String(req.headers.authorization || '');
      const offered = header.startsWith('Bearer ') ? header.slice(7) : '';
      const ok = offered && crypto.timingSafeEqual(crypto.createHash('sha256').update(offered).digest(), digest);
      if (!ok) {
        // Never the offered value, only that one was (or was not) sent.
        throttle(remoteIp(req), (suppressed) => log.warn('admin-denied', { ip: remoteIp(req), reason: offered ? 'wrong-token' : 'no-token', suppressed }));
        res.set('WWW-Authenticate', 'Bearer');
        return res.status(401).json({ error: 'token-required' });
      }
    }
    if (!store.enabled) return res.status(503).json({ error: 'stats-off', reason: store.reason });
    return next();
  });

  const all = (sql, ...args) => store.db.prepare(sql).all(...args).map((r) => ({ ...r }));

  // `from` and `to` are epoch milliseconds; the browser works out the day
  // boundaries in its own timezone.
  function readRange(req, res) {
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
      res.status(400).json({ error: 'bad-range', hint: 'from and to are epoch milliseconds, to after from' });
      return null;
    }
    if (to - from > MAX_RANGE_MS) {
      res.status(400).json({ error: 'range-too-long', max_days: MAX_RANGE_MS / DAY_MS });
      return null;
    }
    return { from, to };
  }

  // Transmissions that started inside the range. One still going on is given
  // its length so far.
  function transmissionsIn(from, to) {
    const ts = now();
    return all(`SELECT ${TX_COLUMNS.join(', ')} FROM transmissions WHERE started_at >= ? AND started_at < ? ORDER BY started_at LIMIT ?`, from, to, MAX_ROWS + 1)
      .map((t) => (t.ended_at === null ? { ...t, held_ms: Math.max(0, ts - t.started_at), live: true } : t));
  }

  // Sessions that were connected at any moment inside the range.
  function sessionsIn(from, to) {
    return all(`SELECT s.${SESSION_COLUMNS.join(', s.')}, d.kind AS kind FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
                WHERE s.connected_at < ? AND (s.left_at IS NULL OR s.left_at >= ?) ORDER BY s.connected_at LIMIT ?`, to, from, MAX_ROWS + 1);
  }

  function handle(fn) {
    return (req, res) => {
      try {
        fn(req, res);
      } catch (err) {
        log.error('admin-error', { path: req.path, error: err && err.message });
        if (!res.headersSent) res.status(500).json({ error: 'query-failed' });
      }
    };
  }

  router.get('/range', handle((req, res) => {
    const range = readRange(req, res);
    if (!range) return;
    const { from, to } = range;
    const ts = now();
    let transmissions = transmissionsIn(from, to);
    let sessions = sessionsIn(from, to);
    const truncated = transmissions.length > MAX_ROWS || sessions.length > MAX_ROWS;
    transmissions = transmissions.slice(0, MAX_ROWS);
    sessions = sessions.slice(0, MAX_ROWS);

    // Per-device totals. Connection time only counts the part inside the range.
    const devices = new Map();
    const device = (id, name, role, kind) => {
      const key = id || `name:${name}`;
      let d = devices.get(key);
      if (!d) {
        d = { device_id: id || null, name, role, kind: kind || null, talk_ms: 0, transmissions: 0, connected_ms: 0, sessions: 0, drops: 0 };
        devices.set(key, d);
      }
      if (name) d.name = name;
      if (kind) d.kind = kind;
      return d;
    };
    for (const s of sessions) {
      if (!s.joined_at) continue; // never joined: a probe, not a participant
      const d = device(s.device_id, s.name, s.role, s.kind);
      d.sessions += 1;
      d.connected_ms += Math.max(0, Math.min(s.left_at === null ? ts : s.left_at, to) - Math.max(s.connected_at, from));
      if (s.leave_reason === 'dead-connection') d.drops += 1;
    }
    let talkMs = 0;
    let longest = null;
    let unheardMs = 0;
    let unheard = 0;
    for (const t of transmissions) {
      const d = device(t.device_id, t.name, t.role, null);
      d.talk_ms += t.held_ms || 0;
      d.transmissions += 1;
      talkMs += t.held_ms || 0;
      if (!longest || (t.held_ms || 0) > longest.held_ms) longest = { id: t.id, name: t.name, started_at: t.started_at, held_ms: t.held_ms || 0 };
      if (t.role === 'gateway' && t.listeners_audible === 0) {
        unheard += 1;
        unheardMs += t.held_ms || 0;
      }
    }
    const joined = sessions.filter((s) => s.joined_at);
    res.json({
      from, to, now: ts, truncated,
      conversation_gap_s: conversationGapS,
      totals: {
        talk_ms: talkMs,
        transmissions: transmissions.length,
        longest,
        sessions: joined.length,
        drops: joined.filter((s) => s.leave_reason === 'dead-connection').length,
        unheard_gateway: unheard,
        unheard_gateway_ms: unheardMs,
      },
      devices: [...devices.values()].sort((a, b) => b.talk_ms - a.talk_ms || b.connected_ms - a.connected_ms),
      conversations: groupConversations(transmissions, conversationGapS * 1000),
      transmissions,
      sessions,
    });
  }));

  router.get('/devices', handle((req, res) => {
    res.json({
      now: now(),
      devices: all(`SELECT d.id, d.kind, d.last_name, d.last_ua, d.first_seen, d.last_seen,
          (SELECT COUNT(*) FROM sessions s WHERE s.device_id = d.id) AS sessions,
          (SELECT COUNT(*) FROM sessions s WHERE s.device_id = d.id AND s.leave_reason = 'dead-connection') AS drops,
          (SELECT COUNT(*) FROM transmissions t WHERE t.device_id = d.id) AS transmissions,
          (SELECT COALESCE(SUM(t.held_ms), 0) FROM transmissions t WHERE t.device_id = d.id) AS talk_ms
        FROM devices d ORDER BY d.last_seen DESC LIMIT ?`, MAX_ROWS),
    });
  }));

  router.get('/export.csv', handle((req, res) => {
    const table = String(req.query.table || '');
    if (table !== 'transmissions' && table !== 'sessions') {
      res.status(400).json({ error: 'bad-table', hint: 'table is transmissions or sessions' });
      return;
    }
    const range = readRange(req, res);
    if (!range) return;
    const rows = table === 'transmissions' ? transmissionsIn(range.from, range.to) : sessionsIn(range.from, range.to);
    const columns = table === 'transmissions' ? TX_COLUMNS : [...SESSION_COLUMNS, 'kind'];
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="walkie-${table}.csv"`,
    });
    res.send(toCsv(columns, rows.slice(0, MAX_ROWS)));
  }));

  router.use((req, res) => res.status(404).json({ error: 'not-found' }));
  return router;
}

module.exports = { createAdminRouter, groupConversations, toCsv, csvCell };

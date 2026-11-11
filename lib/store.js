// Usage database for server.js: who connected, who talked, for how long, and
// whether anyone could hear it. SQLite through node:sqlite, no dependencies.
//
// Rule: the database is never allowed to affect the channel. Every write is
// wrapped; a failure writes one throttled `store-error` log line and is then
// forgotten. If node:sqlite is missing (older Node) or the file cannot be
// opened, the store turns itself off and every call does nothing.
//
// Times are INTEGER epoch milliseconds (UTC). Schema changes must be additive.

const fs = require('fs');
const path = require('path');
const { createThrottle, cleanString } = require('./logger');

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_name TEXT,
  last_ua TEXT,
  kind TEXT NOT NULL              -- phone | desktop | gateway | other
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  conn_id TEXT NOT NULL UNIQUE,   -- the id the server gave this connection
  device_id TEXT,
  name TEXT,
  role TEXT,                      -- browser | cli | gateway
  ip TEXT,
  ua TEXT,
  origin TEXT,
  connected_at INTEGER NOT NULL,
  joined_at INTEGER,
  left_at INTEGER,
  leave_reason TEXT,
  leave_code INTEGER,
  duration_s INTEGER
);
CREATE TABLE IF NOT EXISTS transmissions (
  id TEXT PRIMARY KEY,            -- the tx id sent in floor messages
  session_id INTEGER,
  device_id TEXT,
  name TEXT,
  role TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  held_ms INTEGER,
  end_reason TEXT,                -- ptt-stop | disconnect | timeout | preempted | server-restart
  preempted_by TEXT,              -- tx id of the transmission that took over
  listeners INTEGER,              -- joined clients other than the holder, at the start
  listeners_audible INTEGER,      -- of those: not a gateway and playing audio, at the start
  listeners_audible_end INTEGER,  -- the same count when the transmission ended
  recording_path TEXT,
  recording_bytes INTEGER
);
CREATE TABLE IF NOT EXISTS denied (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id INTEGER,
  holder_tx TEXT
);
CREATE TABLE IF NOT EXISTS presence (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id INTEGER,
  visible INTEGER NOT NULL,
  audible INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  conn_id TEXT,
  data TEXT                       -- JSON
);
CREATE INDEX IF NOT EXISTS sessions_connected_at ON sessions (connected_at);
CREATE INDEX IF NOT EXISTS sessions_device ON sessions (device_id);
CREATE INDEX IF NOT EXISTS transmissions_started_at ON transmissions (started_at);
CREATE INDEX IF NOT EXISTS transmissions_device ON transmissions (device_id);
CREATE INDEX IF NOT EXISTS denied_ts ON denied (ts);
CREATE INDEX IF NOT EXISTS presence_session ON presence (session_id, ts);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
`;

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_RE = /^walkie-\d{8}\.db$/;

// What a device is, for the per-device tables: decided from its role and user agent.
function deviceKind(role, ua) {
  if (role === 'gateway') return 'gateway';
  if (role !== 'browser') return 'other';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(String(ua || '')) ? 'phone' : 'desktop';
}

// Text from a peer (names, user agents, origins): cleaned and capped like the log does.
const text = (value, max = 300) => (value === undefined || value === null ? null : cleanString(value, max));
const int = (value) => (Number.isFinite(value) ? Math.trunc(value) : null);
const flag = (value) => (value ? 1 : 0);

function disabledStore(reason) {
  const nothing = () => {};
  return {
    enabled: false, reason, db: null, file: null,
    sessionStart: nothing, sessionJoin: nothing, sessionEnd: nothing, presence: nothing,
    txStart: nothing, txEnd: nothing, denied: nothing, event: nothing,
    maintain: nothing, close: nothing,
  };
}

function createStore({ enabled = true, dir, log, retentionDays = 400, keepBackups = 7, now = () => Date.now() } = {}) {
  if (!enabled) return disabledStore('off');

  let db;
  const file = path.join(dir, 'walkie.db');
  const backupDir = path.join(dir, 'backups');
  try {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;');
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } catch (err) {
    log.error('store-disabled', { dir, error: err && err.message, fix: 'needs Node 22.13+ and a writable DATA_DIR; the channel works without it' });
    try { if (db) db.close(); } catch { /* nothing to close */ }
    return disabledStore('open-failed');
  }

  const errorThrottle = createThrottle(60000);
  // Runs one database operation. Never throws.
  function safe(op, fn) {
    try {
      return fn();
    } catch (err) {
      errorThrottle((suppressed) => log.error('store-error', { op, error: err && err.message, suppressed }));
      return undefined;
    }
  }

  // Prepared once, on first use.
  const statements = new Map();
  function sql(text_) {
    let st = statements.get(text_);
    if (!st) {
      st = db.prepare(text_);
      statements.set(text_, st);
    }
    return st;
  }

  // A previous run that ended without saying goodbye (crash, power cut, kill)
  // leaves sessions and transmissions open. Close them at the last moment the
  // old process is known to have been alive.
  safe('recover', () => {
    const row = sql('SELECT MAX(ts) AS ts FROM events').get();
    const last = row && row.ts ? row.ts : now();
    sql(`UPDATE transmissions SET ended_at = MAX(started_at, ?), held_ms = MAX(0, ? - started_at), end_reason = 'server-restart'
         WHERE ended_at IS NULL`).run(last, last);
    sql(`UPDATE sessions SET left_at = MAX(connected_at, ?), leave_reason = 'server-restart',
         duration_s = MAX(0, (? - connected_at) / 1000) WHERE left_at IS NULL`).run(last, last);
  });

  const store = {
    enabled: true,
    reason: null,
    db,
    file,

    // Raw, append-only copy of everything that happened: the source of truth for analysis.
    event(event, connId, data, ts = now()) {
      safe('event', () => sql('INSERT INTO events (ts, event, conn_id, data) VALUES (?, ?, ?, ?)')
        .run(ts, String(event), text(connId, 64), data === undefined ? null : JSON.stringify(data)));
    },

    sessionStart({ connId, ip, ua, origin, ts = now() }) {
      safe('session-start', () => sql('INSERT INTO sessions (conn_id, ip, ua, origin, connected_at) VALUES (?, ?, ?, ?, ?)')
        .run(connId, text(ip, 64), text(ua), text(origin), ts));
    },

    sessionJoin({ connId, deviceId, name, role, ua, ts = now() }) {
      safe('session-join', () => {
        sql(`INSERT INTO devices (id, first_seen, last_seen, last_name, last_ua, kind) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen, last_name = excluded.last_name,
               last_ua = excluded.last_ua, kind = excluded.kind`)
          .run(deviceId, ts, ts, text(name, 64), text(ua), deviceKind(role, ua));
        sql('UPDATE sessions SET device_id = ?, name = ?, role = ?, joined_at = COALESCE(joined_at, ?) WHERE conn_id = ?')
          .run(deviceId, text(name, 64), role, ts, connId);
      });
    },

    sessionEnd({ connId, reason, code, ts = now() }) {
      safe('session-end', () => {
        sql(`UPDATE sessions SET left_at = ?, leave_reason = ?, leave_code = ?, duration_s = MAX(0, (? - connected_at) / 1000)
             WHERE conn_id = ?`).run(ts, text(reason, 64), int(code), ts, connId);
        sql('UPDATE devices SET last_seen = ? WHERE id = (SELECT device_id FROM sessions WHERE conn_id = ?)').run(ts, connId);
      });
    },

    presence({ connId, visible, audible, ts = now() }) {
      safe('presence', () => sql('INSERT INTO presence (ts, session_id, visible, audible) VALUES (?, (SELECT id FROM sessions WHERE conn_id = ?), ?, ?)')
        .run(ts, connId, flag(visible), flag(audible)));
    },

    txStart({ tx, connId, name, role, priority, listeners, listenersAudible, ts = now() }) {
      safe('tx-start', () => sql(`INSERT INTO transmissions
          (id, session_id, device_id, name, role, priority, started_at, listeners, listeners_audible)
          VALUES (?, (SELECT id FROM sessions WHERE conn_id = ?), (SELECT device_id FROM sessions WHERE conn_id = ?), ?, ?, ?, ?, ?, ?)`)
        .run(tx, connId, connId, text(name, 64), text(role, 16), flag(priority), ts, int(listeners), int(listenersAudible)));
    },

    txEnd({ tx, reason, preemptedBy, listenersAudible, ts = now() }) {
      safe('tx-end', () => sql(`UPDATE transmissions SET ended_at = ?, held_ms = MAX(0, ? - started_at), end_reason = ?,
          preempted_by = ?, listeners_audible_end = ? WHERE id = ? AND ended_at IS NULL`)
        .run(ts, ts, text(reason, 32), text(preemptedBy, 64), int(listenersAudible), tx));
    },

    denied({ connId, holderTx, ts = now() }) {
      safe('denied', () => sql('INSERT INTO denied (ts, session_id, holder_tx) VALUES (?, (SELECT id FROM sessions WHERE conn_id = ?), ?)')
        .run(ts, connId, text(holderTx, 64)));
    },

    // Housekeeping, safe to call often: drops raw events older than the
    // retention, and once per (UTC) day writes a compact copy of the database,
    // keeping the newest `keepBackups`. Returns what it did, for the log.
    maintain(ts = now()) {
      const done = { purged: 0, backup: null, removed: 0 };
      safe('purge', () => {
        const r = sql('DELETE FROM events WHERE ts < ?').run(ts - retentionDays * DAY_MS);
        done.purged = Number(r.changes) || 0;
      });
      safe('backup', () => {
        const name = `walkie-${new Date(ts).toISOString().slice(0, 10).replace(/-/g, '')}.db`;
        const target = path.join(backupDir, name);
        fs.mkdirSync(backupDir, { recursive: true });
        if (!fs.existsSync(target)) {
          db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
          done.backup = name;
        }
        const old = fs.readdirSync(backupDir).filter((f) => BACKUP_RE.test(f)).sort().reverse().slice(keepBackups);
        for (const f of old) {
          fs.unlinkSync(path.join(backupDir, f));
          done.removed += 1;
        }
      });
      return done;
    },

    close() {
      safe('close', () => {
        statements.clear();
        db.close();
      });
    },
  };
  return store;
}

module.exports = { createStore, deviceKind, SCHEMA_VERSION };

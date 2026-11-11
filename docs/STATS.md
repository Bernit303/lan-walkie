# Usage database

The server records what happens on the channel in a SQLite file: who connected,
who talked, when, for how long, and whether anyone could hear it. No audio is
stored.

The database can never affect the channel. If it cannot be opened, the server
logs `store-disabled` and runs without it. If a write fails, the server logs
`store-error` (at most once a minute) and carries on.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `STATS` | `on` | `off` turns the database off. Nothing is opened or written. |
| `DATA_DIR` | `data/` next to `server.js` (`/app/data` in Docker) | Where `walkie.db` and `backups/` live. |
| `EVENT_RETENTION_DAYS` | `400` | Rows of the raw `events` table older than this are deleted. The other tables are kept without limit. |

It needs Node 22.13 or newer (`node:sqlite`). On an older Node the server works
and the database is off.

In Docker the files are in the `lan-walkie-data` volume. The container's file
system is read-only, so without that volume the database is off.

## Tables

Times are integers: milliseconds since 1970, UTC.

| Table | One row per | Columns |
|---|---|---|
| `devices` | device | `id`, `first_seen`, `last_seen`, `last_name`, `last_ua`, `kind` (`phone`, `desktop`, `gateway`, `other`) |
| `sessions` | connection | `id`, `conn_id`, `device_id`, `name`, `role`, `ip`, `ua`, `origin`, `connected_at`, `joined_at`, `left_at`, `leave_reason`, `leave_code`, `duration_s` |
| `transmissions` | time someone held the channel | `id`, `session_id`, `device_id`, `name`, `role`, `priority`, `started_at`, `ended_at`, `held_ms`, `end_reason`, `preempted_by`, `listeners`, `listeners_audible`, `listeners_audible_end`, `recording_path`, `recording_bytes` |
| `denied` | refused talk request | `id`, `ts`, `session_id`, `holder_tx` |
| `presence` | change of "on screen" or "playing audio" | `id`, `ts`, `session_id`, `visible`, `audible` |
| `events` | everything, raw | `id`, `ts`, `event`, `conn_id`, `data` (JSON) |

Notes:

- `transmissions.id` is the `tx` value sent in `floor` messages.
- `end_reason` is `ptt-stop`, `disconnect`, `timeout`, `preempted` or
  `server-restart`.
- `listeners` counts joined clients other than the speaker when the
  transmission started. `listeners_audible` counts those that are not a gateway
  and were playing audio. `listeners_audible_end` is the same count when it
  ended, so a listener who dropped halfway shows up.
- A phone with a locked screen is not audible. A desktop tab in the background
  is audible when "Play audio in the background" is on.
- A client that never reports presence (the CLI, older browsers) is counted as
  audible.
- `denied` is limited to one row per second per client, like the log line.
- `recording_path` and `recording_bytes` are empty; they are for audio
  recording, which does not exist yet.
- After a crash, sessions and transmissions that were still open are closed at
  the time of the last recorded event, with the reason `server-restart`.

## Device ids

Each client sends a device id in `join` (see [PROTOCOL.md](PROTOCOL.md)).

- Browser: a random id kept in the browser's storage. Clearing site data, a
  private window or another browser gives a new device.
- CLI and gateway: a hash of the host name and `--name`.
- A client that sends none gets `auto-` plus a hash of its name and user agent.

## Backups

Once a day (UTC) the server writes a compact copy to
`backups/walkie-YYYYMMDD.db` and keeps the newest 7. It checks once an hour and
at start. To copy the data off the host, copy one of those files; they are
complete databases.

## Example queries

Open the file with `sqlite3`. In Docker:

```bash
docker run --rm -it -v lan-walkie-data:/data alpine sh -c "apk add -q sqlite && sqlite3 /data/walkie.db"
```

Minutes talked per device, last 7 days:

```sql
SELECT d.last_name, d.kind, COUNT(*) AS times, ROUND(SUM(t.held_ms) / 60000.0, 1) AS minutes
FROM transmissions t JOIN devices d ON d.id = t.device_id
WHERE t.started_at > (unixepoch() - 7 * 86400) * 1000
GROUP BY t.device_id ORDER BY minutes DESC;
```

Radio calls nobody could hear:

```sql
SELECT datetime(started_at / 1000, 'unixepoch', 'localtime') AS at, name, held_ms / 1000 AS seconds
FROM transmissions
WHERE role = 'gateway' AND listeners_audible = 0
ORDER BY started_at DESC;
```

How phone sessions ended, per day:

```sql
SELECT date(connected_at / 1000, 'unixepoch', 'localtime') AS day, leave_reason, COUNT(*) AS sessions
FROM sessions s JOIN devices d ON d.id = s.device_id
WHERE d.kind = 'phone'
GROUP BY day, leave_reason ORDER BY day DESC;
```

## What is stored about people

Names, IP addresses, user agents and the times they connected and talked. The
priority token is never stored. Anyone who can read the data directory can read
all of it; there is no page or API that serves it.

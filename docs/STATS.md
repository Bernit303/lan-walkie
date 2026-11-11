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

## Usage page

`https://<server>:8443/admin.html` shows one day at a time (the day runs from
midnight to midnight in the browser's timezone):

- totals: minutes talked, transmissions, longest transmission, busiest hour,
  connections and drops;
- minutes talked per day for the last 30 days (click a bar to open that day);
- radio calls nobody could hear;
- conversations: transmissions less than `CONVERSATION_GAP_S` (60) seconds
  apart, with who took part and for how long;
- a timeline of connections per device, with dropped ones marked;
- totals per device, and every transmission;
- CSV export of the day's transmissions and connections.

The page only reads. It gets its data from three endpoints:

| Endpoint | Returns |
|---|---|
| `GET /api/admin/range?from=<ms>&to=<ms>` | Transmissions that started in the range, sessions connected during it, conversations, per-device totals, overall totals. At most 400 days and 20000 rows of each. |
| `GET /api/admin/devices` | Every device ever seen, with all-time totals. |
| `GET /api/admin/export.csv?table=transmissions\|sessions&from=<ms>&to=<ms>` | The same rows as CSV. Text that a spreadsheet would treat as a formula gets a leading `'`. |

### Access

| `ADMIN_TOKEN` | Result |
|---|---|
| unset | Open to anyone who can reach the server. The server logs `admin-open` at start. |
| 16 or more characters | Every API request needs `Authorization: Bearer <token>`. The page asks for it once and keeps it until the tab is closed. It is never put in a URL and never logged. |
| shorter, or a placeholder | The API answers 403 to everyone and the server logs `admin-disabled`. |

Generate one with `openssl rand -hex 24`. The page's own files (`admin.html`,
`admin.js`, `admin.css`) are always served; they contain no data.

## What is stored about people

Names, IP addresses, user agents and the times they connected and talked. The
priority token is never stored. Anyone who can read the data directory can read
all of it, and so can anyone who can open the usage page: it shows names and
times, and the CSV export includes IP addresses and user agents. Set
`ADMIN_TOKEN` if not everyone on the network should see that.

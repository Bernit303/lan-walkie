# LAN Walkie

**A push-to-talk walkie-talkie for your own network.** Open a web page, hold a
button, talk. Everyone else on the channel hears you.

[![CI](https://github.com/Bernit303/lan-walkie/actions/workflows/ci.yml/badge.svg)](https://github.com/Bernit303/lan-walkie/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/node-20%2B-339933)

It runs on your own hardware. There are no accounts, no cloud service and no
media server: audio travels directly between devices over encrypted WebRTC.
Machines without a screen can join through a headless client, and a handheld
radio can be bridged onto the channel with an [AIOC](https://github.com/skuep/AIOC)
USB cable.

> [!WARNING]
> There is no login. Anyone who can reach the port can join, listen and talk.
> Run it on a trusted LAN or behind a VPN such as Tailscale, never on the open
> internet. See [Security](#security).

## Features

- **Any browser, any phone.** Plain HTML, CSS and JavaScript with no build
  step. It can be installed to a phone's home screen.
- **Peer-to-peer audio.** The server only sets up connections and decides who
  may talk. It never sees the audio.
- **One speaker at a time**, with a server-side timeout so a stuck client
  cannot lock the channel.
- **Optional priority user** who can interrupt the current speaker.
- **Headless client** for machines with no browser (runs under systemd).
- **Radio gateway.** LAN speech keys a handheld radio and received radio audio
  goes back to the LAN.
- **Usage page** at `/admin.html`: minutes talked per day, who talked and for
  how long, connections and drops, conversations, and radio calls nobody could
  hear.
- **Operations tools:** structured logs, phone alerts through
  [ntfy](https://ntfy.sh) when the radio path breaks, and restart-from-your-phone
  commands protected by a one-time code.

## Quick start

### Docker

```bash
git clone https://github.com/Bernit303/lan-walkie.git
cd lan-walkie
# edit docker-compose.yml: set CERT_HOSTNAMES / CERT_IPS to how you reach this host
docker compose up -d --build
```

### Node

Needs Node.js 20 or newer and `openssl` on the path. The usage database needs
Node.js 22.13 or newer; on an older version the server runs without it.

```bash
npm ci
npm start
# ... INFO  listening url="https://<your-ip>:8443"
```

### Join

Open `https://<your-ip>:8443` on any device on the network, accept the
self-signed certificate warning once, enter a name and hold the button.

Browsers only allow microphone access over HTTPS (or `localhost`), which is why
the server is HTTPS-only. To skip the certificate warning, put it behind
[Tailscale Serve](docs/DEPLOYMENT.md#trusted-https-with-tailscale-serve).

### On a phone

The page only works while it is on screen: when the phone locks, received audio
is muted and the server drops the phone a few seconds later. To avoid that, the
app keeps the screen on while it is open. The "Keep screen on" selector under
the channel list has three choices:

- **Always while open** (default). Best for a phone on a charger.
- **During conversations.** On while someone talks and for 10 minutes after the
  last activity, then the phone may sleep.
- **Off.**

Limits:

- It only stops the automatic screen timeout. The power button, switching to
  another app and incoming calls still hide the page.
- Android Chrome supports it. iPhones need a recent iOS; a browser without
  support shows a hint, and the fix there is a longer screen timeout in the
  phone's settings.
- Battery saver modes can refuse it. The app says so and asks again on the next
  touch.
- Inside an iframe (for example a Home Assistant dashboard) the frame needs
  `allow="screen-wake-lock"`.

### On a desktop

A tab in the background keeps playing received audio ("Play audio in the
background", on by default, desktop only). When someone talks while the tab is
hidden, the tab title changes to "● Name talking" and stays as "● Name called"
until you look at the tab. An installed app also gets a badge on its icon where
the browser supports it.

## Ways to talk

| Client | How |
|---|---|
| Browser | Hold the on-screen button or the Space bar |
| Headless CLI (`cli/`) | Press Space in a terminal to toggle talking |
| Radio gateway (`cli/`, `--aioc`) | Automatic: LAN speech keys the radio, radio audio goes to the LAN |

The headless client and gateway are documented in [cli/README.md](cli/README.md).
The radio hardware setup is in [docs/AIOC.md](docs/AIOC.md).

## How it works

```
   browser ◄──────── WebRTC audio (direct, encrypted) ────────► browser
      │                                                            │
      └──────────────┐                              ┌──────────────┘
                     ▼                              ▼
              ┌──────────────────────────────────────────┐
              │ server.js: HTTPS + WebSocket signaling   │   never sees audio
              │ SDP/ICE relay, who holds the floor       │
              └──────────────────────────────────────────┘
                     ▲
      headless CLI ──┘          AIOC ◄──► handheld radio (gateway mode)
```

Every participant keeps a WebSocket to the server and a direct WebRTC
connection to every other participant (a full mesh). That is plenty for a
household or small group. Beyond roughly 6 to 8 people talking at once you
would want a media server (SFU) instead.

## Configuration

Everything is an optional environment variable on the server.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8443` | HTTPS and WebSocket port |
| `CERT_HOSTNAMES` | unset | Extra DNS names for the self-signed certificate |
| `CERT_IPS` | unset | Extra IPs for the self-signed certificate |
| `MAX_TRANSMIT_MS` | `60000` | Release the floor after this long without a release |
| `MAX_CLIENTS` | `32` | Maximum simultaneous connections |
| `PRIORITY_TOKEN` | unset | Shared secret (16+ characters) that grants priority. Unset disables priority |
| `ALLOWED_ORIGINS` | unset | Comma-separated browser origins allowed to open the WebSocket |
| `FRAME_ANCESTORS` | unset | Origins allowed to embed the page in an iframe (for example a Home Assistant dashboard). Unset means framing is denied |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `LOG_FORMAT` | `text` | `text`, or `json` for one JSON object per line |
| `LOG_STATS_MS` | `300000` | Interval of the one-line `stats` summary. `0` turns it off |
| `ROGER_BEEP` | `off` | `on` plays a short beep on every client when the channel is released. Restart to change |
| `STATS` | `on` | Usage database (who talked, when, how long, who could hear it). `off` disables it. See [docs/STATS.md](docs/STATS.md) |
| `DATA_DIR` | `data/` | Where the usage database and its backups are kept |
| `EVENT_RETENTION_DAYS` | `400` | Days of raw events to keep in the usage database |
| `ADMIN_TOKEN` | unset | Token (16+ characters) required by the usage page's API. Unset leaves the page open to anyone who can reach the server |
| `CONVERSATION_GAP_S` | `60` | Transmissions closer together than this many seconds count as one conversation on the usage page |

Generate a priority token with `openssl rand -hex 24`. Short or placeholder
values are refused: the server logs an error and runs with priority disabled.
Logging details are in [docs/LOGGING.md](docs/LOGGING.md).

## Security

- **No authentication.** The security boundary is network reachability. Keep
  it on a trusted LAN or behind a VPN.
- **Audio is encrypted** between peers (WebRTC DTLS-SRTP) and signaling runs
  over TLS.
- **Names are cosmetic.** Priority comes from the token, not the name, and
  clients draw the priority marker from a flag, not from the name text.
- **Floor control is cooperative.** The server enforces who may transmit, but a
  modified client can still open its own microphone.
- **The CLI verifies TLS by default** and never sends the priority token over
  an unverified connection. For a self-signed server use `--ca-file` or
  `--pin-sha256`.
- The server caps message size, message rate and connection count, and
  tolerates malformed input.

Found a problem? See [SECURITY.md](SECURITY.md).

## Status

Early and hobby-grade, but working end to end. The server, browser mesh and
radio gateway have run on real hardware (Ubuntu 24.04, an AIOC, a Baofeng
handheld, Chrome and Firefox peers) and have automated tests.

| Area | State |
|---|---|
| Server (floor control, priority, input hardening) | Automated tests (`npm test`) |
| Browser client | Used on desktop and phones, no automated tests |
| Headless CLI | Verified against the real server with synthetic audio |
| AIOC radio gateway | Run on real hardware and unit-tested, plus Linux probes in `tools/` for memory and audio negotiation. No multi-day soak test yet |
| Roaming between Wi-Fi access points | Reconnect logic exists. Weak spots on phones were seen and are not fully understood |

Known limits: audio is half-duplex (one speaker at a time), a denied request
is dropped rather than queued, and the browser and CLI use a public Google STUN
server by default (set an empty STUN setting on a LAN or VPN to avoid it).

## Documentation

- [docs/PROTOCOL.md](docs/PROTOCOL.md): the signaling protocol, every message
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Docker, systemd, Tailscale Serve
- [docs/AIOC.md](docs/AIOC.md): radio gateway hardware, behaviour and safety
- [cli/README.md](cli/README.md): headless client and gateway reference
- [docs/STATS.md](docs/STATS.md): the usage database, its tables and example queries
- [docs/ALERTS.md](docs/ALERTS.md): phone alerts and remote commands
- [docs/LOGGING.md](docs/LOGGING.md): log events and fields
- [CHANGELOG.md](CHANGELOG.md): what changed

## Development

```bash
npm ci
npm test                                             # server tests (node:test)
python3 -m unittest discover -s cli -p "test_*.py"   # CLI logic tests
```

The CLI tests stub GStreamer and pyserial, so they run on any OS. CI runs both
on every push. Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

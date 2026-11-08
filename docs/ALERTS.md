# Phone alerts

`tools/alert_watch.py` sends a push notification to your phone when the radio path breaks, so you
find out within seconds instead of when someone at the site cannot be reached. It uses
[ntfy](https://ntfy.sh): free, no account, and the phone app shows ordinary notifications.

Two watchers, because they see different failures:

| Where | Watches | Alerts when |
|---|---|---|
| gateway machine (gateway-host) | the gateway's journal | the radio input stalls (`0 level readings`), the watchdog fires, a fatal error or traceback, the service exits or restarts, or it stops reporting for 60 s. Sends "back to normal" when readings return. |
| server machine (server-host) | the signaling server's container log | the radio gateway left the server and has not come back for 60 s (machine off, offline, or the service down). |

## 1. Phone

1. Install **ntfy** (App Store / Google Play).
2. Make a topic name nobody can guess and subscribe to it in the app. Generate it on a computer:
   `echo "ipwalkie-$(openssl rand -hex 12)"`. Anyone who knows the topic can read and post to it, so
   never reuse an example from this page and never commit your real one.
3. Allow notifications. On iOS keep the default `ntfy.sh` server: it forwards through Apple's push
   service, which is what makes alerts instant. On Android you can turn on "Instant delivery" for
   alerts that must never be delayed.

## 2. Test it

On either machine:

```bash
NTFY_URL=https://ntfy.sh/<your-topic> python3 tools/alert_watch.py --test
```

The phone should buzz within a few seconds.

## 3. Install the watchers

Put the topic in an env file (readable only by root and the service user; it is a secret):

```bash
sudo install -m 640 -o root -g $USER /dev/null /etc/lan-walkie-alert.env
echo 'NTFY_URL=https://ntfy.sh/<your-topic>' | sudo tee /etc/lan-walkie-alert.env
```

Gateway machine:

```bash
sudo sed -e "s|@USER@|$USER|" -e "s|@REPO@|$HOME/lan-walkie|" deploy/lan-walkie-alert-gateway.service | sudo tee /etc/systemd/system/lan-walkie-alert-gateway.service
sudo systemctl daemon-reload && sudo systemctl enable --now lan-walkie-alert-gateway
```

Server machine (the user must be in the `docker` group):

```bash
sudo sed -e "s|@USER@|$USER|" -e "s|@REPO@|$HOME/lan-walkie|" deploy/lan-walkie-alert-server.service | sudo tee /etc/systemd/system/lan-walkie-alert-server.service
sudo systemctl daemon-reload && sudo systemctl enable --now lan-walkie-alert-server
```

Check them with `systemctl status lan-walkie-alert-gateway` (or `-server`) and
`journalctl -u lan-walkie-alert-gateway -f`: every alert is also printed there.

## What it does not cover

- If the machine running a watcher is itself off, that watcher is silent. The server watcher covers
  the gateway machine dying. Nothing covers the server machine dying; add an uptime check on it (for
  example another phone or a service that pings it) if that matters.
- Messages go through the public ntfy.sh server. They contain short status text only (no tokens,
  names or audio), but the topic name is the only secret. You can self-host ntfy on the server
  machine instead; on iPhone that makes notifications slower.
- A repeated alert is held back for 5 minutes. A deliberate `systemctl stop` does not trigger the
  silence alert, but restarting the service sends one low-priority "restarted" notice.

## Remote commands (restart from your phone)

You can also send commands from the ntfy app. The app's message box posts to the topic, and a
listener (`tools/remote_commands.py`) acts on messages in a **separate command topic**.

| Send | Machine | Does |
|---|---|---|
| `123456 restart gateway` | gateway | restarts the gateway service, then reports its state |
| `123456 reboot gateway` | gateway | reboots the whole machine (it tells you first) |
| `123456 restart server` | server | restarts the signaling server container |
| `123456 status` | both | service state, the last level-reading line, uptime |
| `help` | both | lists the commands |

`123456` is the **current code from an authenticator app**. A topic name is readable and writable
by anyone who knows it, so a static word like `restart` would let anyone cut your radio link. The
code changes every 30 s and works once. A wrong code does nothing except raise an alert (at most one
per 5 minutes). Restart and reboot are limited to one per 2 minutes. Replies go to the alerts topic.

### Setup (both machines unless stated)

1. Make a **second, different** private topic for commands:
   `echo "ipwalkie-cmd-$(openssl rand -hex 12)"` and subscribe to it in the ntfy app.
2. Make the secret once: `python3 tools/remote_commands.py --new-secret`. In an authenticator app
   (Google Authenticator, Aegis, ...) choose *Enter a setup key*, name it `LAN Walkie`, paste the key,
   time-based. Use the **same key on both machines**.
3. Add three lines to `/etc/lan-walkie-alert.env` (keep the existing `NTFY_URL` line):
   ```
   NTFY_COMMAND_URL=https://ntfy.sh/<your-command-topic>
   COMMAND_TOTP_SECRET=<the key>
   ```
4. **Gateway machine only:** allow exactly two privileged commands, nothing else:
   ```bash
   echo "$USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart lan-walkie-gateway, /usr/bin/systemctl reboot" | sudo tee /etc/sudoers.d/lan-walkie-remote
   sudo chmod 440 /etc/sudoers.d/lan-walkie-remote && sudo visudo -c
   ```
   `visudo -c` must say the files are OK. The **server machine** needs no sudo, only a login in the
   `docker` group.
5. Install the service (`@ROLE@` is `gateway` or `server`):
   ```bash
   sudo sed -e "s|@USER@|$USER|" -e "s|@REPO@|$HOME/lan-walkie|" -e "s|@ROLE@|gateway|" deploy/lan-walkie-commands.service | sudo tee /etc/systemd/system/lan-walkie-commands.service
   sudo systemctl daemon-reload && sudo systemctl enable --now lan-walkie-commands
   ```
6. In the ntfy app, open the command topic and send `help`.

Keep both topics and the secret out of the repository and out of chat.

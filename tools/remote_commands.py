#!/usr/bin/env python3
"""
Control LAN Walkie from your phone. Send a message to a private ntfy topic ("command topic") and
this listener acts on it, then reports back on the alerts topic.

    <code> restart gateway     restart the radio gateway service            (gateway machine)
    <code> reboot gateway      reboot the whole gateway machine             (gateway machine)
    <code> restart server      restart the signaling server container       (server machine)
    <code> status              report what this machine is doing            (both)
    help                       list the commands

<code> is the 6-digit one-time code from an authenticator app (Google Authenticator, Aegis, ...).
It changes every 30 s and works once, so it is safe even though a topic is readable by anyone who
knows its name. A message without a valid code does nothing except (at most once per 5 minutes)
raise an alert that someone tried. Restart/reboot are limited to one per 2 minutes.

Run one listener per machine; each only acts on its own targets:

    COMMAND_ROLE=gateway   (gateway-host)          COMMAND_ROLE=server   (server-host)

Settings (environment, from /etc/lan-walkie-alert.env):
    NTFY_COMMAND_URL     command topic, e.g. https://ntfy.sh/ipwalkie-cmd-<long-random>
    NTFY_URL             alerts topic (replies go here; same as the alerts watcher)
    COMMAND_TOTP_SECRET  base32 secret shared with the authenticator app
    COMMAND_ROLE         gateway | server

    python3 tools/remote_commands.py --new-secret     print a new secret and how to add it to the app
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import struct
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from alert_watch import send_ntfy  # noqa: E402

STEP = 30
MAX_MESSAGE_AGE = 90  # seconds: older messages (a replay, a backlog) are ignored
ACTION_COOLDOWN = 120  # between restarts/reboots
BAD_CODE_ALERT_COOLDOWN = 300
GATEWAY_SERVICE = "lan-walkie-gateway"
SERVER_CONTAINER = "lan-walkie"

HELP = {
    "gateway": "Commands: '<code> restart gateway', '<code> reboot gateway', '<code> status'.",
    "server": "Commands: '<code> restart server', '<code> status'.",
}


def totp(secret_b32, unix_time, digits=6):
    key = base64.b32decode(secret_b32.replace(" ", "").upper() + "=" * (-len(secret_b32.replace(" ", "")) % 8))
    counter = int(unix_time // STEP)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return f"{value:0{digits}d}"


def new_secret():
    return base64.b32encode(secrets.token_bytes(20)).decode()


def run_command(cmd, timeout=30):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except Exception as e:
        return 1, str(e)


class Commander:
    """All the rules, with injected I/O (run, notify, clock) so they can be tested."""

    def __init__(self, role, secret, run, notify, wall=time.time, mono=time.monotonic, sleep=time.sleep):
        self.role = role
        self.secret = secret
        self.run = run  # run(cmd_list) -> (returncode, text)
        self.notify = notify  # notify(title, body, priority, tags)
        self.wall = wall
        self.mono = mono
        self.sleep = sleep
        self.last_counter = 0
        self.last_action = None
        self.last_bad = None

    def _code_ok(self, code):
        now = self.wall()
        base = int(now // STEP)
        for counter in (base, base - 1, base + 1):  # allow a little clock drift
            if counter > self.last_counter and hmac.compare_digest(code, totp(self.secret, counter * STEP)):
                self.last_counter = counter  # one use only
                return True
        return False

    def handle(self, text, msg_time):
        text = (text or "").strip()
        if not text:
            return
        if self.wall() - msg_time > MAX_MESSAGE_AGE:
            return
        words = text.lower().split()
        if words[0] in ("help", "?"):
            self.notify("Commands", HELP[self.role], "low", "information_source")
            return
        if not re.fullmatch(r"\d{6}", words[0]):
            return  # ordinary chatter: ignore
        if not self._code_ok(words[0]):
            now = self.mono()
            if self.last_bad is None or now - self.last_bad > BAD_CODE_ALERT_COOLDOWN:
                self.last_bad = now
                self.notify("Command refused", "A command arrived with a wrong or reused code.", "high", "warning")
            return
        action = " ".join(words[1:])
        if action == "status":
            return self._status()
        if self.role == "gateway" and action == "restart gateway":
            return self._guarded(self._restart_gateway)
        if self.role == "gateway" and action == "reboot gateway":
            return self._guarded(self._reboot_gateway)
        if self.role == "server" and action == "restart server":
            return self._guarded(self._restart_server)
        if action.split(" ")[-1:] in (["gateway"], ["server"]) and action.split(" ")[-1] != self.role:
            return  # meant for the other machine
        self.notify("Unknown command", f"{HELP[self.role]}", "low", "question")

    def _guarded(self, fn):
        now = self.mono()
        if self.last_action is not None and now - self.last_action < ACTION_COOLDOWN:
            self.notify("Command ignored", "A restart or reboot was already done in the last 2 minutes.", "default", "hourglass")
            return
        self.last_action = now
        fn()

    def _gateway_state(self):
        _, active = self.run(["systemctl", "is-active", GATEWAY_SERVICE])
        _, journal = self.run(["journalctl", "-u", GATEWAY_SERVICE, "-n", "60", "--no-pager", "-o", "cat"])
        status = [ln for ln in journal.splitlines() if "[vox] status:" in ln]
        last = status[-1] if status else "no status line yet"
        last = re.sub(r"^.*?\[vox\] status: ", "", last)[:200]
        return active.strip() or "unknown", last

    def _status(self):
        _, up = self.run(["uptime", "-p"])
        if self.role == "gateway":
            active, last = self._gateway_state()
            self.notify("Gateway status", f"service: {active}\n{last}\nmachine {up}", "default", "bar_chart")
        else:
            rc, out = self.run(["docker", "ps", "--filter", f"name={SERVER_CONTAINER}", "--format", "{{.Status}}"])
            self.notify("Server status", f"container: {out.strip() or 'not running'}\nmachine {up}", "default", "bar_chart")

    def _restart_gateway(self):
        rc, out = self.run(["sudo", "-n", "systemctl", "restart", GATEWAY_SERVICE])
        if rc != 0:
            self.notify("Gateway restart FAILED", out[:200], "urgent", "rotating_light")
            return
        self.sleep(10)
        active, last = self._gateway_state()
        self.notify("Gateway restarted", f"service: {active}\n{last}", "default", "white_check_mark")

    def _reboot_gateway(self):
        self.notify("Rebooting the gateway machine", "Back in about 1-2 minutes. You will get an alert if it does not return.", "high", "arrows_counterclockwise")
        self.sleep(3)  # let that notification leave first
        rc, out = self.run(["sudo", "-n", "systemctl", "reboot"])
        if rc != 0:
            self.notify("Reboot FAILED", out[:200], "urgent", "rotating_light")

    def _restart_server(self):
        rc, out = self.run(["docker", "restart", SERVER_CONTAINER], timeout=60)
        if rc != 0:
            self.notify("Server restart FAILED", out[:200], "urgent", "rotating_light")
            return
        self.notify("Server restarted", "The signaling server container was restarted. Phones reconnect by themselves.", "default", "white_check_mark")


def listen(url, handle, stop=lambda: False):
    """Follow the topic's JSON stream; reconnect forever. Messages older than the start are skipped."""
    since = int(time.time())
    seen = set()
    backoff = 2
    while not stop():
        try:
            req = urllib.request.Request(f"{url.rstrip('/')}/json?since={since}")
            with urllib.request.urlopen(req, timeout=100) as resp:
                backoff = 2
                for raw in resp:
                    try:
                        ev = json.loads(raw)
                    except ValueError:
                        continue
                    if ev.get("event") != "message" or ev.get("id") in seen:
                        continue
                    seen.add(ev.get("id"))
                    if len(seen) > 500:
                        seen.clear()
                    since = max(since, int(ev.get("time", since)))
                    handle(ev.get("message", ""), float(ev.get("time", 0)))
        except Exception as e:
            print(f"[commands] connection problem: {e}; retrying in {backoff}s", file=sys.stderr, flush=True)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--new-secret", action="store_true")
    args = ap.parse_args()
    if args.new_secret:
        s = new_secret()
        print("Secret (setup key):", s)
        print("In your authenticator app choose 'Enter a setup key', name it LAN Walkie, paste the key,")
        print("type: time-based. Put the same key in /etc/lan-walkie-alert.env as COMMAND_TOTP_SECRET=...")
        return 0

    url = os.environ.get("NTFY_COMMAND_URL", "").strip()
    alerts = os.environ.get("NTFY_URL", "").strip()
    secret = os.environ.get("COMMAND_TOTP_SECRET", "").strip()
    role = os.environ.get("COMMAND_ROLE", "").strip().lower()
    if not (url and alerts and secret) or role not in ("gateway", "server"):
        print("Set NTFY_COMMAND_URL, NTFY_URL, COMMAND_TOTP_SECRET and COMMAND_ROLE=gateway|server", file=sys.stderr)
        return 2
    host = socket.gethostname()

    def notify(title, body, priority="default", tags=""):
        print(f"[commands] {title}: {body}", flush=True)
        send_ntfy(alerts, f"LAN Walkie: {title}", f"{body}\n({host})", priority, tags)

    cmd = Commander(role, secret, run_command, notify)
    print(f"[commands] listening as {role}", flush=True)
    listen(url, cmd.handle)
    return 0


if __name__ == "__main__":
    sys.exit(main())

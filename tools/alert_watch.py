#!/usr/bin/env python3
"""
Phone alerts for LAN Walkie. Reads a log stream on standard input and pushes a notification
(through ntfy, https://ntfy.sh, free, no account) when something is wrong.

Two modes:

  gateway   on the gateway machine (gateway-host). Watches the gateway's own log:
              journalctl -u lan-walkie-gateway -f -n0 -o short-iso | python3 tools/alert_watch.py --mode gateway
            Alerts on: the radio input stalling ("0 level readings"), the watchdog firing,
            fatal errors, tracebacks, the process exiting or restarting, and the gateway going
            silent (no status line for 60 s). Sends "back to normal" when readings return.

  server    on the machine that runs the signaling server (server-host). Watches the server log:
              docker logs -f --since 0s lan-walkie 2>&1 | python3 tools/alert_watch.py --mode server
            Alerts when the radio gateway has left and not come back for 60 s. That is what
            you see when the gateway machine is off, offline or the service is down.

Settings (environment): NTFY_URL, the full topic address, e.g. https://ntfy.sh/<long-random-topic>.
Anyone who knows the topic can read and post to it, so make it long and random and keep it out
of the repository (the systemd units read it from an env file). Messages contain only short
status text, never tokens, names or audio.

    python3 tools/alert_watch.py --test      # send a test notification and exit
"""
import argparse
import os
import re
import socket
import sys
import threading
import time
import urllib.request

COOLDOWN_SECONDS = 300  # the same alert is not repeated more often than this

# (pattern, key, title, priority, tags): the gateway's log lines that deserve a phone alert.
GATEWAY_RULES = [
    (re.compile(r"\[watchdog\]"), "watchdog", "Gateway watchdog fired", "urgent", "rotating_light"),
    (re.compile(r"\[fatal\]"), "fatal", "Gateway hit a fatal error", "urgent", "rotating_light"),
    (re.compile(r"UNKEY FAILED"), "unkey", "RADIO MAY BE STUCK KEYED (unkey failed)", "urgent", "rotating_light"),
    (re.compile(r"Traceback \(most recent call last\)"), "traceback", "Gateway crashed with a Python error", "high", "warning"),
    (re.compile(r"Main process exited|Failed with result"), "exited", "Gateway process exited (systemd restarts it)", "high", "warning"),
    (re.compile(r"Started lan-walkie-gateway"), "started", "Gateway (re)started", "low", "arrows_counterclockwise"),
]
STATUS_RE = re.compile(r"\[vox\] status: (\d+) level readings")


def _ascii(text):
    return text.encode("ascii", "replace").decode("ascii")


def send_ntfy(url, title, body, priority="default", tags=""):
    """Never raises: a failed notification must not take the watcher down."""
    def go():
        try:
            req = urllib.request.Request(
                url,
                data=body.encode("utf-8"),
                headers={"Title": _ascii(title), "Priority": priority, "Tags": tags},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as e:
            print(f"[alert] could not send the notification: {e}", file=sys.stderr, flush=True)
    threading.Thread(target=go, daemon=True).start()


class Monitor:
    """The rules, with no I/O: feed() takes a log line, tick() takes the time; both take `now`
    (seconds, monotonic) so tests can drive it."""

    def __init__(self, mode, notify, radio_name="Radio", offline_after=60, silent_after=60, cooldown=COOLDOWN_SECONDS):
        self.mode = mode
        self.notify = notify  # notify(title, body, priority, tags)
        self.radio_name = radio_name
        self.offline_after = offline_after
        self.silent_after = silent_after
        self.cooldown = cooldown
        self._last = {}
        # gateway mode
        self.last_status = None
        self.expect_status = False
        self.in_stall = False
        # server mode
        self.offline_since = None
        self.offline_alerted = False
        self._join = re.compile(r'\bjoin\b.*\bname="' + re.escape(radio_name) + '"')
        self._leave = re.compile(r'\bleave\b.*\bname="' + re.escape(radio_name) + '"')

    def _alert(self, key, now, title, body, priority, tags):
        last = self._last.get(key)
        if last is not None and now - last < self.cooldown:
            return
        self._last[key] = now
        self.notify(title, body, priority, tags)

    def feed(self, line, now):
        if self.mode == "gateway":
            self._feed_gateway(line, now)
        else:
            self._feed_server(line, now)

    def _feed_gateway(self, line, now):
        m = STATUS_RE.search(line)
        if m:
            self.last_status = now
            self.expect_status = True
            if int(m.group(1)) == 0:
                if not self.in_stall:
                    self.in_stall = True
                self._alert("stall", now, "Gateway is DEAF: radio input stopped",
                            "0 level readings in 5 s. Nothing from the radio reaches the phones. "
                            "The watchdog restarts it after 15 s.", "urgent", "rotating_light")
            elif self.in_stall:
                self.in_stall = False
                self.notify("Gateway radio input is back", "Level readings are flowing again.", "default", "white_check_mark")
            return
        if "Stopping lan-walkie-gateway" in line or "Stopped lan-walkie-gateway" in line:
            self.expect_status = False  # a deliberate stop: do not report silence
        for pattern, key, title, priority, tags in GATEWAY_RULES:
            if pattern.search(line):
                self._alert(key, now, title, _short(line), priority, tags)
                break

    def _feed_server(self, line, now):
        if self._join.search(line):
            if self.offline_alerted:
                self.notify("Radio gateway is back online", "It reconnected to the server.", "default", "white_check_mark")
            self.offline_since = None
            self.offline_alerted = False
        elif self._leave.search(line):
            if self.offline_since is None:
                self.offline_since = now

    def tick(self, now):
        if self.mode == "gateway":
            if self.expect_status and self.last_status is not None and now - self.last_status > self.silent_after:
                self.expect_status = False  # once per silence
                self._alert("silent", now, "Gateway stopped reporting",
                            f"No status line for {self.silent_after} s: it is hung, stopped or the log is not flowing.",
                            "high", "warning")
        elif self.offline_since is not None and not self.offline_alerted and now - self.offline_since > self.offline_after:
            self.offline_alerted = True
            self._alert("offline", now, "Radio gateway is OFFLINE",
                        f"'{self.radio_name}' left the server {self.offline_after} s ago and has not come back. "
                        "The site cannot be reached.", "urgent", "rotating_light")


def _short(line, limit=240):
    return re.sub(r"\s+", " ", line).strip()[:limit]


def read_lines(fd=0):
    """Yield complete lines and None on timeouts, without losing data to stdio buffering."""
    import select
    buf = b""
    while True:
        ready, _, _ = select.select([fd], [], [], 1.0)
        if not ready:
            yield None
            continue
        chunk = os.read(fd, 65536)
        if not chunk:
            return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            yield line.decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=("gateway", "server"), default="gateway")
    ap.add_argument("--radio-name", default="Radio", help="server mode: the gateway's name on the server")
    ap.add_argument("--test", action="store_true", help="send one test notification and exit")
    args = ap.parse_args()

    url = os.environ.get("NTFY_URL", "").strip()
    if not url:
        print("NTFY_URL is not set (for example https://ntfy.sh/<your-long-random-topic>)", file=sys.stderr)
        return 2
    host = socket.gethostname()

    def notify(title, body, priority="default", tags=""):
        print(f"[alert] {title}: {body}", flush=True)
        send_ntfy(url, f"LAN Walkie: {title}", f"{body}\n({host})", priority, tags)

    if args.test:
        notify("test", "If you can read this on your phone, alerts work.", "default", "white_check_mark")
        time.sleep(3)  # let the sender thread finish
        return 0

    mon = Monitor(args.mode, notify, radio_name=args.radio_name)
    print(f"[alert] watching in {args.mode} mode", flush=True)
    for line in read_lines():
        now = time.monotonic()
        if line is not None:
            mon.feed(line, now)
        mon.tick(now)
    return 0


if __name__ == "__main__":
    sys.exit(main())

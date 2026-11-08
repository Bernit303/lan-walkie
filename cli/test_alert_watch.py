import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("alert_watch", os.path.join(HERE, "..", "tools", "alert_watch.py"))
aw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aw)


def make(mode, **kw):
    sent = []
    mon = aw.Monitor(mode, lambda title, body, priority="default", tags="": sent.append((title, priority)), **kw)
    return mon, sent


def status(n):
    return f"Nov 07 02:07:40 gateway-host python3[1]: [vox] status: {n} level readings in 5 s, input peak -63.9 dBFS"


class GatewayRules(unittest.TestCase):
    def test_a_stall_alerts_once_and_says_when_it_is_over(self):
        mon, sent = make("gateway")
        mon.feed(status(250), 0)
        self.assertEqual(sent, [])
        mon.feed(status(0), 5)
        mon.feed(status(0), 10)
        mon.feed(status(0), 15)
        self.assertEqual([t for t, _ in sent], ["Gateway is DEAF: radio input stopped"])
        self.assertEqual(sent[0][1], "urgent")
        mon.feed(status(250), 20)
        self.assertEqual(sent[-1][0], "Gateway radio input is back")

    def test_watchdog_fatal_and_unkey_failures_are_urgent(self):
        for text in ("[watchdog] no radio-input level readings for 15 s", "[fatal] sound device error", "[radio: UNKEY FAILED (x); retrying in 1 s]"):
            mon, sent = make("gateway")
            mon.feed("Nov 07 python3[1]: " + text, 0)
            self.assertEqual(len(sent), 1, text)
            self.assertEqual(sent[0][1], "urgent", text)

    def test_normal_lines_do_not_alert(self):
        mon, sent = make("gateway")
        for line in ("-> Eugenio joined", "[radio: TX keyed]", "[ice:abc] GST_WEBRTC_ICE_CONNECTION_STATE_COMPLETED", status(250), "[connected]"):
            mon.feed(line, 0)
        self.assertEqual(sent, [])

    def test_the_same_alert_is_not_repeated_inside_the_cooldown(self):
        mon, sent = make("gateway", cooldown=300)
        mon.feed("[watchdog] x", 0)
        mon.feed("[watchdog] x", 100)
        self.assertEqual(len(sent), 1)
        mon.feed("[watchdog] x", 400)
        self.assertEqual(len(sent), 2)

    def test_silence_alerts_but_a_deliberate_stop_does_not(self):
        mon, sent = make("gateway", silent_after=60)
        mon.feed(status(250), 0)
        mon.tick(30)
        self.assertEqual(sent, [])
        mon.tick(61)
        self.assertEqual(sent[0][0], "Gateway stopped reporting")
        mon.tick(200)
        self.assertEqual(len(sent), 1, "silence must be reported once")

        mon, sent = make("gateway", silent_after=60)
        mon.feed(status(250), 0)
        mon.feed("systemd[1]: Stopping lan-walkie-gateway.service - LAN Walkie radio gateway (AIOC)...", 10)
        mon.tick(500)
        self.assertEqual(sent, [])

    def test_exit_and_restart_lines(self):
        mon, sent = make("gateway")
        mon.feed("systemd[1]: lan-walkie-gateway.service: Main process exited, code=exited, status=1/FAILURE", 0)
        mon.feed("systemd[1]: Started lan-walkie-gateway.service - LAN Walkie radio gateway (AIOC).", 1)
        self.assertEqual([p for _, p in sent], ["high", "low"])


class ServerRules(unittest.TestCase):
    JOIN = '2026-11-07T16:00:00.000Z INFO  join id="a1b2c3d4" name="Radio" priority=false again=false clients=2'
    LEAVE = '2026-11-07T16:05:00.000Z INFO  leave id="a1b2c3d4" name="Radio" joined=true reason="closed" code=1006 duration_s=300 clients=1'

    def test_radio_gone_for_a_minute_alerts_and_return_is_announced(self):
        mon, sent = make("server", offline_after=60)
        mon.feed(self.JOIN, 0)
        mon.feed(self.LEAVE, 100)
        mon.tick(130)
        self.assertEqual(sent, [])
        mon.tick(161)
        self.assertEqual(sent[0][0], "Radio gateway is OFFLINE")
        mon.tick(300)
        self.assertEqual(len(sent), 1)
        mon.feed(self.JOIN, 400)
        self.assertEqual(sent[-1][0], "Radio gateway is back online")

    def test_a_quick_reconnect_is_silent(self):
        mon, sent = make("server", offline_after=60)
        mon.feed(self.LEAVE, 0)
        mon.feed(self.JOIN, 10)
        mon.tick(500)
        self.assertEqual(sent, [])

    def test_other_clients_leaving_does_not_matter(self):
        mon, sent = make("server", offline_after=60)
        mon.feed(self.LEAVE.replace('"Radio"', '"Eugenio"'), 0)
        mon.tick(500)
        self.assertEqual(sent, [])


class Sending(unittest.TestCase):
    def test_a_failing_send_never_raises(self):
        aw.send_ntfy("http://127.0.0.1:9/unreachable", "t", "b")  # nothing listens there

    def test_titles_are_ascii_safe(self):
        self.assertEqual(aw._ascii("Radio café"), "Radio caf?")


if __name__ == "__main__":
    unittest.main()

import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(HERE, "..", "tools")
sys.path.insert(0, TOOLS)
spec = importlib.util.spec_from_file_location("remote_commands", os.path.join(TOOLS, "remote_commands.py"))
rc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rc)

SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # "12345678901234567890", the RFC 6238 test key


class Totp(unittest.TestCase):
    def test_rfc6238_vector(self):
        # RFC 6238 appendix B, SHA-1: T=59 -> 94287082, so the 6-digit code is 287082.
        self.assertEqual(rc.totp(SECRET, 59), "287082")
        self.assertEqual(rc.totp(SECRET, 1111111109), "081804")

    def test_new_secret_is_usable(self):
        s = rc.new_secret()
        self.assertEqual(len(rc.totp(s, 12345)), 6)


class Harness:
    def __init__(self, role, clock=1_000_000.0):
        self.clock = clock
        self.mono = 0.0
        self.sent = []
        self.ran = []
        self.fail = False

        def run(cmd, timeout=30):
            self.ran.append(cmd)
            if cmd[:2] == ["systemctl", "is-active"]:
                return 0, "active\n"
            if cmd[0] == "journalctl":
                return 0, "x\n[vox] status: 250 level readings in 5 s, input peak -64.0 dBFS, pipeline playing\n"
            if cmd[0] == "uptime":
                return 0, "up 3 hours"
            if cmd[0] == "docker" and cmd[1] == "ps":
                return 0, "Up 2 days"
            return (1, "denied") if self.fail else (0, "")

        self.c = rc.Commander(role, SECRET, run, lambda t, b, p="default", g="": self.sent.append((t, p)),
                              wall=lambda: self.clock, mono=lambda: self.mono, sleep=lambda s: None)

    def code(self, offset=0):
        return rc.totp(SECRET, self.clock + offset * rc.STEP)

    def say(self, text):
        self.c.handle(text, self.clock)


class Gateway(unittest.TestCase):
    def test_restart_with_a_valid_code(self):
        h = Harness("gateway")
        h.say(f"{h.code()} restart gateway")
        self.assertIn(["sudo", "-n", "systemctl", "restart", "lan-walkie-gateway"], h.ran)
        self.assertEqual(h.sent[-1][0], "Gateway restarted")

    def test_no_code_or_a_wrong_code_does_nothing(self):
        h = Harness("gateway")
        h.say("restart gateway")
        h.say("123456 restart gateway")
        self.assertFalse([c for c in h.ran if c[0] == "sudo"])
        self.assertEqual([t for t, _ in h.sent], ["Command refused"])  # the wrong code is reported, chatter is not

    def test_a_code_works_only_once(self):
        h = Harness("gateway")
        code = h.code()
        h.say(f"{code} status")
        h.say(f"{code} restart gateway")
        self.assertFalse([c for c in h.ran if c[0] == "sudo"])
        self.assertEqual(h.sent[-1][0], "Command refused")

    def test_old_messages_are_ignored(self):
        h = Harness("gateway")
        h.c.handle(f"{h.code()} restart gateway", h.clock - rc.MAX_MESSAGE_AGE - 5)
        self.assertEqual(h.ran, [])

    def test_codes_from_the_neighbouring_step_are_accepted_but_not_older(self):
        h = Harness("gateway")
        h.say(f"{h.code(-1)} status")
        self.assertEqual(h.sent[-1][0], "Gateway status")
        h2 = Harness("gateway")
        h2.say(f"{h2.code(-3)} status")
        self.assertEqual(h2.sent[-1][0], "Command refused")

    def test_restarts_are_rate_limited(self):
        h = Harness("gateway")
        h.say(f"{h.code()} restart gateway")
        h.clock += rc.STEP
        h.mono += 40
        h.say(f"{h.code()} restart gateway")
        self.assertEqual(h.sent[-1][0], "Command ignored")
        self.assertEqual(len([c for c in h.ran if c[:3] == ["sudo", "-n", "systemctl"]]), 1)
        h.clock += rc.STEP
        h.mono += 100
        h.say(f"{h.code()} restart gateway")
        self.assertEqual(len([c for c in h.ran if c[:3] == ["sudo", "-n", "systemctl"]]), 2)

    def test_reboot_announces_first_then_reboots(self):
        h = Harness("gateway")
        h.say(f"{h.code()} reboot gateway")
        self.assertEqual(h.sent[0][0], "Rebooting the gateway machine")
        self.assertIn(["sudo", "-n", "systemctl", "reboot"], h.ran)

    def test_failed_restart_is_reported_urgently(self):
        h = Harness("gateway")
        h.fail = True
        h.say(f"{h.code()} restart gateway")
        self.assertEqual(h.sent[-1], ("Gateway restart FAILED", "urgent"))

    def test_status_reports_the_service_and_the_last_reading(self):
        h = Harness("gateway")
        h.say(f"{h.code()} status")
        self.assertEqual(h.sent[-1][0], "Gateway status")

    def test_commands_for_the_other_machine_are_ignored_quietly(self):
        h = Harness("gateway")
        h.say(f"{h.code()} restart server")
        self.assertEqual(h.sent, [])
        self.assertEqual([c for c in h.ran if c[0] in ("docker", "sudo")], [])

    def test_help_needs_no_code(self):
        h = Harness("gateway")
        h.say("help")
        self.assertEqual(h.sent[-1][0], "Commands")


class Server(unittest.TestCase):
    def test_restart_server_uses_docker_and_gateway_commands_are_ignored(self):
        h = Harness("server")
        h.say(f"{h.code()} restart server")
        self.assertIn(["docker", "restart", "lan-walkie"], h.ran)
        self.assertEqual(h.sent[-1][0], "Server restarted")
        h.clock += rc.STEP
        h.say(f"{h.code()} reboot gateway")
        self.assertFalse([c for c in h.ran if c[0] == "sudo"])


if __name__ == "__main__":
    unittest.main()

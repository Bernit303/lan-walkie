#!/usr/bin/env python3
"""
Reproduce, on demand, the situation that preceded every "gateway goes deaf" incident:
a phone joins, its media connection never completes (ICE stays in CHECKING), and it
leaves a few seconds later.

It is a fake phone, not a browser: it joins the real signaling server, starts or answers the
call (whichever the ids call for) with a made-up SDP and one unreachable ICE candidate, holds
for a few seconds and disconnects. No audio is involved and nothing is transmitted.

Run it on the gateway machine (it needs the `websockets` package the gateway already uses):

    python3 tools/stuck_peer_repro.py                 # one round
    python3 tools/stuck_peer_repro.py --rounds 5      # five rounds, 25 s apart

While it runs, watch the gateway in another terminal:

    sudo journalctl -u lan-walkie-gateway --utc -f | grep -vE "status: 2[0-9]{2} level"

A deaf gateway shows up as `status: 0 level readings` or `[watchdog] quiet ...` lines after
the "left" line. For a few seconds the fake peer appears in the phones' list as
"Fake-Stuck-Peer". Do not run it while someone is using the radio: if the gateway does stall,
the watchdog restarts it, which cuts the radio for about 20 seconds.
"""
import argparse
import asyncio
import json
import os
import ssl
import sys
import time

import websockets

OFFER_KEEP = ("v=", "s=", "t=", "a=group:", "m=", "a=rtcp-mux", "a=rtpmap:", "a=fmtp:", "a=mid:")


def utc():
    return time.strftime("%H:%M:%S", time.gmtime())


def make_answer(offer_sdp):
    """An answer that is well-formed but cannot complete: random DTLS fingerprint, no reachable path."""
    fingerprint = ":".join(f"{b:02X}" for b in os.urandom(32))
    injected = [
        "a=ice-ufrag:fake" + os.urandom(2).hex(),
        "a=ice-pwd:" + os.urandom(12).hex(),
        "a=fingerprint:sha-256 " + fingerprint,
        "a=setup:active",
        "a=sendrecv",
    ]
    out, in_media = [], False
    for line in offer_sdp.replace("\r", "").split("\n"):
        if line.startswith("o="):
            out.append("o=- 1 1 IN IP4 127.0.0.1")
        elif line.startswith(OFFER_KEEP):
            out.append(line)
            if line.startswith("m="):
                in_media = True
                out.append("c=IN IP4 0.0.0.0")
                out.extend(injected)
    if not in_media:
        raise ValueError("the offer has no media section")
    return "\r\n".join(out) + "\r\n"


CRLF = chr(13) + chr(10)


def make_offer():
    """A browser-style offer (Opus 111) that is well-formed but cannot complete."""
    fingerprint = ":".join(f"{b:02X}" for b in os.urandom(32))
    return CRLF.join([
        "v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0",
        "a=ice-ufrag:fake" + os.urandom(2).hex(), "a=ice-pwd:" + os.urandom(12).hex(),
        "a=fingerprint:sha-256 " + fingerprint, "a=setup:actpass", "a=mid:0", "a=sendrecv",
        "a=rtcp-mux", "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1", "",
    ])


BOGUS_CANDIDATE = {"candidate": "candidate:1 1 UDP 2122252543 203.0.113.9 9 typ host", "sdpMid": "0", "sdpMLineIndex": 0}


async def one_round(args, ctx):
    async with websockets.connect(args.url, ssl=ctx) as ws:
        my_id = None
        gateway_id = None
        deadline = time.monotonic() + 20
        answered = False
        offered = False
        while time.monotonic() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2)
            except asyncio.TimeoutError:
                continue
            msg = json.loads(raw)
            kind = msg.get("type")
            if kind == "welcome":
                my_id = msg["id"]
                await ws.send(json.dumps({"type": "join", "name": "Fake-Stuck-Peer"}))
            elif kind == "peers":
                for p in msg["peers"]:
                    if p.get("name") == args.gateway_name:
                        gateway_id = p["id"]
                if gateway_id and my_id and my_id < gateway_id and not offered:
                    # Like a browser whose id sorts first: we send the offer, the gateway answers.
                    offered = True
                    await ws.send(json.dumps({"type": "offer", "target": gateway_id, "sdp": {"type": "offer", "sdp": make_offer()}}))
                    await ws.send(json.dumps({"type": "ice", "target": gateway_id, "candidate": BOGUS_CANDIDATE}))
            elif (kind == "answer" and offered and msg.get("from") == gateway_id) or (
                kind == "offer" and msg.get("from") == gateway_id
            ):
                if kind == "offer":
                    # The gateway starts the call: answer it with made-up data.
                    answer = make_answer(msg["sdp"]["sdp"])
                    await ws.send(json.dumps({"type": "answer", "target": gateway_id, "sdp": {"type": "answer", "sdp": answer}}))
                    await ws.send(json.dumps({"type": "ice", "target": gateway_id, "candidate": dict(BOGUS_CANDIDATE, sdpMid="audio0")}))
                print(f"[{utc()} UTC] {'got the gateway answer' if offered else 'answered the gateway offer'}; "
                      f"holding {args.hold:g} s with no media path", flush=True)
                answered = True
                await asyncio.sleep(args.hold)
                break
        if not answered:
            raise RuntimeError("the gateway never answered or offered (is it running and connected to this server?)")
    print(f"[{utc()} UTC] left", flush=True)
    return "done"


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="wss://localhost:8443", help="the signaling server the gateway uses")
    ap.add_argument("--gateway-name", default="Radio")
    ap.add_argument("--hold", type=float, default=6.0, help="seconds to stay connected before leaving")
    ap.add_argument("--rounds", type=int, default=1)
    ap.add_argument("--pause", type=float, default=25.0, help="seconds between rounds")
    args = ap.parse_args()

    ctx = ssl.create_default_context()
    ctx.check_hostname = False  # a test tool for your own server, which uses a self-signed certificate
    ctx.verify_mode = ssl.CERT_NONE

    for n in range(1, args.rounds + 1):
        print(f"--- round {n}/{args.rounds}", flush=True)
        await one_round(args, ctx)
        if n < args.rounds:
            await asyncio.sleep(args.pause)
    print("finished. Now check the gateway log for 'status: 0 level readings' or '[watchdog]'.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

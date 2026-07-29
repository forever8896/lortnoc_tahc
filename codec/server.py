#!/usr/bin/env python3
"""
lortnoc_tahc codec service (PRD §7) — dependency-free stdlib HTTP server.

    POST /encode  { "ciphertext": base64 }  -> { "coverText": string }
    POST /decode  { "coverText": string }   -> { "ciphertext": base64 }
    GET  /health                            -> { "model", "digest", "ready" }

One warm process serves BOTH ends of a conversation, so encode and decode share the
exact same coder (reversibility guaranteed). Sees ciphertext only — never plaintext,
never a key (invariant §4).

Run:  python3 server.py            # binds 127.0.0.1:8080
      PORT=9000 HOST=0.0.0.0 python3 server.py
Expose for the two-laptop demo via a tunnel, e.g.:  cloudflared tunnel --url http://localhost:8080
"""
import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import auth
import codec
import coder  # for NotCoverText — the single condition that earns a 422

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = 256 * 1024  # generous cap for chat-sized payloads

# ---- Paused mode -----------------------------------------------------------------------------
# Flipped with `fly secrets set CODEC_PAUSED=1` — no redeploy, and `fly secrets unset` undoes it.
#
# Deliberately NOT the same thing as scaling the machine to zero. A dead host gives the client a
# connection timeout, and a timeout is indistinguishable from bad wifi or a broken extension: people
# file issues, or quietly conclude the project is abandoned. An immediate, worded 503 is the thing
# that actually manages expectations.
PAUSED = os.environ.get("CODEC_PAUSED", "") == "1"
PAUSED_URL = os.environ.get("CODEC_PAUSED_URL", "https://lortnoctahc.com")
PAUSED_MESSAGE = os.environ.get(
    "CODEC_PAUSED_MESSAGE",
    "The hosted codec is paused during the closed alpha. "
    "Join at lortnoctahc.com — or run your own: git clone, cd codec, python3 server.py",
)
# What /health reports as its `model` while paused.
#
# This string is load-bearing and it is worth knowing why. Already-installed extensions cannot be
# updated remotely, and their popup prints /health's `model` field VERBATIM:
#
#     if (res.ok && res.data.ready) setChip(status, res.data.model ?? 'codec ok', ...)
#
# So this is the ONLY channel that reaches someone running an older build. Keep it short enough to
# fit the popup chip, and keep it accurate.
PAUSED_MODEL = os.environ.get("CODEC_PAUSED_MODEL", "paused — alpha signup at lortnoctahc.com")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---- CORS (belt-and-suspenders; the SW path bypasses CORS via host_permissions) ----
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT")
        self.send_header("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        # PNA/LNA transition hedge (harmless if unused):
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code, obj, headers=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _membership_url(self):
        """Best-effort absolute URL of this resource (x402 `resource` field)."""
        host = self.headers.get("Host", f"{HOST}:{PORT}")
        proto = self.headers.get("X-Forwarded-Proto", "https" if ":" not in host or host.endswith(":443") else "http")
        return f"{proto}://{host}/membership"

    def _membership(self):
        """x402 resource: sells a membership token. No X-PAYMENT → 402 with payment
        requirements; valid X-PAYMENT → settle + mint a token (§7/§8)."""
        resource = self._membership_url()
        xp = self.headers.get("X-PAYMENT")
        if not xp:
            return self._json(402, auth.x402_402_body(resource, "lortnoc membership", "payment required"))
        settlement = auth.verify_payment(xp, auth.x402_requirements(resource, "lortnoc membership"))
        if not settlement:
            return self._json(402, auth.x402_402_body(resource, "lortnoc membership", "payment invalid or unsettled"))
        # Mint the bearer token. NOTE (§8): the clean version binds a Semaphore NULLIFIER here,
        # not the payer address — payer is a placeholder until the join()-on-pay path is wired.
        token = auth.sign_token(settlement.get("payer", ""))
        return self._json(
            200,
            {"token": token, "member": True, "expiresIn": auth.TOKEN_TTL},
            headers={"X-PAYMENT-RESPONSE": auth.x402_settle_header(settlement)},
        )

    def _paused_body(self):
        """503 body for /encode and /decode while paused.

        503 rather than 402 (which the extension maps to the paywall) or 500 (which reads as a
        crash). `paused: true` is the machine-readable flag a newer client keys off; `message` and
        `url` are what an older one can at least surface as an error string.
        """
        return {"paused": True, "error": PAUSED_MESSAGE, "message": PAUSED_MESSAGE, "url": PAUSED_URL}

    def _read_json(self):
        n = int(self.headers.get("Content-Length", "0"))
        if n <= 0 or n > MAX_BODY:
            raise ValueError("bad content length")
        return json.loads(self.rfile.read(n).decode())

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.rstrip("/") == "/membership":
            return self._membership()
        if self.path.rstrip("/") == "/health":
            # /health stays 200 while paused, ON PURPOSE. It is the only channel that reaches an
            # already-installed extension (see PAUSED_MODEL above), and a non-200 would make the
            # popup show a bare "offline" instead of the message.
            #
            # `ready: true` alongside a 503 on /encode is internally inconsistent, and that is a
            # knowing trade: the alternative reaches nobody. `paused: true` is the honest field for
            # any client new enough to read it.
            return self._json(
                200,
                {
                    "model": PAUSED_MODEL if PAUSED else codec.MODEL,
                    "digest": codec.DIGEST,
                    "ready": True,
                    "paused": PAUSED,
                    **({"message": PAUSED_MESSAGE, "url": PAUSED_URL} if PAUSED else {}),
                    "select": codec.select_info(),
                    "auth": auth.status(),
                },
            )
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.rstrip("/")
        if path == "/membership":  # x402 clients may POST the paid request
            return self._membership()
        if PAUSED and path in ("/encode", "/decode"):
            # Before the body is read: fail fast and cheap, and never spend model time while paused.
            return self._json(503, self._paused_body(), headers={"Retry-After": "3600"})
        try:
            req = self._read_json()
            if path == "/encode":
                ct = base64.b64decode(req["ciphertext"], validate=True)
                fast = bool(req.get("fast", False))  # handshake frames skip best-of-N

                # Capability gate (§7/§9). Handshake frames (fast) carry only pubkeys — never
                # metered, so key exchange is never blocked. Reading (/decode) is always free.
                #
                # RESERVE now, COMMIT after a successful encode. authorize() used to be a pure
                # check, with the ~seconds-long model call sitting between it and spend() — so
                # on a threaded server, N concurrent requests from one handle at remaining=1 all
                # passed before any of them spent, and all N got cover text.
                verdict = {"member": False, "remaining": -1}
                reserved = False
                if auth.ENFORCE and not fast:
                    verdict = auth.reserve(req.get("handle"), req.get("membership"))
                    if not verdict["allow"]:
                        # x402-shaped 402: `accepts` lets an x402 client pay for membership
                        # inline; `upgrade` is the simple funnel for a non-x402 client.
                        body = auth.x402_402_body(self._membership_url(), "lortnoc membership", "free limit reached")
                        body.update({"upgrade": auth.UPGRADE_URL, "remaining": 0})
                        return self._json(402, body)
                    reserved = not verdict["member"]

                try:
                    cover, select = codec.encode(ct, fast=fast)
                except Exception:
                    # A failed encode must not cost the user a free send.
                    if reserved:
                        auth.release(req.get("handle"))
                    raise

                return self._json(
                    200,
                    {
                        "coverText": cover,
                        "remaining": verdict["remaining"],
                        "member": verdict["member"],
                        # Honest per-request signal: "0g-testnet"/"0g-router" if 0G really
                        # judged this cover, "fallback" if 0G was unreachable, "single" if
                        # selection was skipped (handshake frames).
                        "select": select,
                        # Which backend actually produced this cover (§6.2). The dispatcher
                        # falls back silently gpt2 -> markov -> wordmap, and the client used to
                        # announce "GPT-2 · hiding it as chatter" regardless — claiming a model
                        # that never ran. Same honesty rule as `select`: say what happened.
                        "model": codec.MODEL,
                    },
                )
            if path == "/decode":
                ct = codec.decode(req["coverText"])
                return self._json(200, {"ciphertext": base64.b64encode(ct).decode()})
            return self._json(404, {"error": "not found"})
        except coder.NotCoverText:
            # THE ONLY path to 422. The extension caches a 422 permanently as "definitely not
            # ours" and never retries that bubble, so this must mean exactly "ordinary
            # chatter" — never "the request was malformed" and never "something broke in
            # here", both of which would silently swallow a real message forever.
            return self._json(422, {"error": "not codec cover text"})
        except (KeyError, ValueError) as e:
            # Malformed request (missing field, bad base64, oversized payload). A client bug,
            # not a verdict about the cover text — so 400, which the extension retries.
            return self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 - anything unexpected is ours, not the caller's
            return self._json(500, {"error": str(e)})

    def log_message(self, *_):  # quiet; no request logging (gateway hygiene)
        pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"codec ({codec.MODEL} {codec.DIGEST}) listening on http://{HOST}:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()

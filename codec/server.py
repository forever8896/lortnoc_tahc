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

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = 256 * 1024  # generous cap for chat-sized payloads


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
            return self._json(
                200,
                {
                    "model": codec.MODEL,
                    "digest": codec.DIGEST,
                    "ready": True,
                    "select": codec.select_info(),
                    "auth": auth.status(),
                },
            )
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.rstrip("/")
        if path == "/membership":  # x402 clients may POST the paid request
            return self._membership()
        try:
            req = self._read_json()
            if path == "/encode":
                ct = base64.b64decode(req["ciphertext"], validate=True)
                fast = bool(req.get("fast", False))  # handshake frames skip best-of-N

                # Capability gate (§7/§9). Handshake frames (fast) carry only pubkeys — never
                # metered, so key exchange is never blocked. Reading (/decode) is always free.
                verdict = {"member": False, "remaining": -1}
                if auth.ENFORCE and not fast:
                    verdict = auth.authorize(req.get("handle"), req.get("membership"))
                    if not verdict["allow"]:
                        # x402-shaped 402: `accepts` lets an x402 client pay for membership
                        # inline; `upgrade` is the simple funnel for a non-x402 client.
                        body = auth.x402_402_body(self._membership_url(), "lortnoc membership", "free limit reached")
                        body.update({"upgrade": auth.UPGRADE_URL, "remaining": 0})
                        return self._json(402, body)

                cover = codec.encode(ct, fast=fast)

                # Spend a free send only after a successful encode (members are unlimited).
                if auth.ENFORCE and not fast and not verdict["member"]:
                    verdict["remaining"] = max(0, auth.FREE_LIMIT - auth.spend(req.get("handle")))
                return self._json(
                    200,
                    {"coverText": cover, "remaining": verdict["remaining"], "member": verdict["member"]},
                )
            if path == "/decode":
                ct = codec.decode(req["coverText"])
                return self._json(200, {"ciphertext": base64.b64encode(ct).decode()})
            return self._json(404, {"error": "not found"})
        except (KeyError, ValueError) as e:
            # KeyError: unknown cover word; ValueError: coder rejected the tokens.
            # Both mean "not one of ours" -> fail closed. (base64/json errors on /encode
            # also raise ValueError, but /encode never hits this in normal use.)
            if path == "/decode":
                return self._json(422, {"error": "not codec cover text"})
            return self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 - surface any other error as 400
            return self._json(400, {"error": str(e)})

    def log_message(self, *_):  # quiet; no request logging (gateway hygiene)
        pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"codec ({codec.MODEL} {codec.DIGEST}) listening on http://{HOST}:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()

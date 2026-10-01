"""
codec2 HTTP service: short, natural cover text for a POINTER.

    GET  /health                                         -> { model, ready, temperature, top_p }
    POST /hide    { platform, thread?, opener?, nbytes?, tries? } -> { text, opener, payload, locator, token }
    POST /reveal  { text, platform, nbits? }              -> { locators: [hex] }   usually 0 or 1
    POST /drop    { locator, token, frame }               -> 201 stored | 409 taken | 403 bad token
    GET  /drop/<locator>                                  -> { frame }   ALWAYS: a decoy if unknown

payload = base64 locator; locator/token = hex; frame = base64. The locator is H(token) (drops.py),
so only the writer who got the token from /hide can store a frame under it.

A reply is OPENER + CARRIER (stego.py). `thread` (title + parent comment) only shapes the opener,
which carries no bits; reading needs the reply text and the platform, nothing else from the page.

Sees only random locators and public page context, never a message or a key. One model, one
process, requests serialised: both ends of every round trip run the identical computation, which
is the determinism the coder relies on (see stego.py).
"""
import base64
import json
import binascii
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from drops import DropStore, locator_for, new_token
from stego import Model, best_of, opener, reveal_reply, valid_opener

MODEL = os.environ.get("CODEC2_MODEL", "Qwen/Qwen3-0.6B-Base")
PORT = int(os.environ.get("PORT", "8090"))
MAX_BODY = 16 * 1024
PLATFORMS = {"reddit", "x", "news"}
HEX = re.compile(r"[0-9a-f]{8,32}")
DROP_RATE = int(os.environ.get("DROP_RATE", "30"))  # writes per minute per client

model = None
lock = threading.Lock()
drops = DropStore(os.environ.get("DROP_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "drops")))
writes: dict[str, list[float]] = {}  # in memory only, never logged (CLAUDE.md §8 Layer 4)


def limited(ip: str) -> bool:
    now = time.time()
    recent = [t for t in writes.get(ip, []) if now - t < 60]
    if len(writes) > 10_000:
        writes.clear()
    writes[ip] = recent + [now]
    return len(recent) >= DROP_RATE


def unhex(v) -> bytes | None:
    v = str(v or "").lower()
    return bytes.fromhex(v) if HEX.fullmatch(v) and len(v) % 2 == 0 else None


def load():
    global model
    model = Model(MODEL, temperature=float(os.environ.get("TEMP", "0.9")), top_p=float(os.environ.get("TOPP", "0.92")))


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path.startswith("/drop/"):
            loc = unhex(self.path[len("/drop/"):])
            if not loc or len(loc) < 4:
                return self._send(400, {"error": "bad locator"})
            return self._send(200, {"frame": base64.b64encode(drops.get(loc)).decode()})
        if self.path == "/health":
            return self._send(200, {"model": MODEL, "ready": model is not None,
                                    "temperature": model and model.temperature, "top_p": model and model.top_p})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        if n > MAX_BODY:
            return self._send(413, {"error": "too large"})
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._send(400, {"error": "bad json"})
        if self.path == "/drop":
            return self._drop(req)
        if model is None:
            return self._send(503, {"error": "loading"})
        platform = req.get("platform") if req.get("platform") in PLATFORMS else "news"
        t0 = time.time()
        if self.path == "/hide":
            nbytes = int(req.get("nbytes") or 8)
            if not 4 <= nbytes <= 16:
                return self._send(400, {"error": "nbytes must be 4..16"})
            given = " ".join(str(req.get("opener") or "").split())
            if given and not valid_opener(given):
                return self._send(400, {"error": "opener: one plain sentence, ending in . ! or ?"})
            thread = str(req.get("thread") or "")[:1200]
            tokens = {}
            for _ in range(max(1, min(6, int(req.get("tries") or 3)))):
                tok = new_token()
                tokens[locator_for(tok, nbytes)] = tok
            with lock:
                first = given or (opener(model, platform, thread) if thread.strip() else "")
                payload, text = best_of(model, platform, first, nbytes, payloads=list(tokens))
            if not text:
                return self._send(500, {"error": "no cover found, try again"})
            return self._send(200, {"text": text, "opener": first, "payload": base64.b64encode(payload).decode(),
                                    "locator": payload.hex(), "token": tokens[payload].hex(),
                                    "ms": int((time.time() - t0) * 1000)})
        if self.path == "/reveal":
            text = str(req.get("text") or "").strip()
            nbits = int(req.get("nbits") or 64)
            if not text or len(text) > 2000 or nbits % 8 or not 32 <= nbits <= 128:
                return self._send(400, {"error": "bad request"})
            with lock:
                got = reveal_reply(model, text, platform, nbits)
            return self._send(200, {"locators": [g.hex() for g in got], "ms": int((time.time() - t0) * 1000)})
        self._send(404, {"error": "not found"})

    def _drop(self, req):
        if limited(self.client_address[0]):
            return self._send(429, {"error": "slow down"})
        loc, tok = unhex(req.get("locator")), unhex(req.get("token"))
        try:
            frame = base64.b64decode(str(req.get("frame") or ""), validate=True)
        except (binascii.Error, ValueError):
            frame = b""
        if not loc or not tok:
            return self._send(400, {"error": "bad request"})
        got = drops.put(loc, frame, tok)
        code = {"stored": 201, "exists": 409, "forbidden": 403, "invalid": 400}[got]
        return self._send(code, {"result": got})

    def log_message(self, *_):  # no request logging
        pass


if __name__ == "__main__":
    threading.Thread(target=load, daemon=True).start()
    print(f"codec2 on :{PORT} loading {MODEL}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()

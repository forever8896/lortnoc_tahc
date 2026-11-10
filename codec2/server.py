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
import hmac
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from drops import DropStore, locator_for, new_token
from stego import Model, best_of, opener, reveal_reply, valid_opener

MODEL = os.environ.get("CODEC2_MODEL", "Qwen/Qwen3-0.6B-Base")
# Pinned weights: a different revision gives different tables, and every stored reply stops decoding.
REVISION = os.environ.get("CODEC2_REVISION") or None
PORT = int(os.environ.get("PORT", "8090"))
MAX_BODY = 16 * 1024
PLATFORMS = {"reddit", "x", "news"}
HEX = re.compile(r"[0-9a-f]{8,32}")
# Per client per minute. /hide holds the one model for ~20 s and /reveal for a few, and requests are
# serialised — so without these one client could keep everyone else waiting.
DROP_RATE = int(os.environ.get("DROP_RATE", "30"))
HIDE_RATE = int(os.environ.get("HIDE_RATE", "10"))
REVEAL_RATE = int(os.environ.get("REVEAL_RATE", "40"))
# Behind the boat front door (door/): only requests carrying this secret are served, and the client
# IP comes from the door's header. Unset (local, Fly): no check, IP from Fly-Client-IP or the socket.
DOOR_SECRET = os.environ.get("DOOR_SECRET", "").encode()

model = None
arch = None  # archive.Archive when WALRUS is set
lock = threading.Lock()
drops = DropStore(os.environ.get("DROP_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "drops")))
writes: dict[str, list[float]] = {}  # in memory only, never logged (CLAUDE.md §8 Layer 4)


def limited(ip: str, bucket: str = "drop") -> bool:
    rate = {"drop": DROP_RATE, "hide": HIDE_RATE, "reveal": REVEAL_RATE}[bucket]
    key, now = f"{bucket}:{ip}", time.time()
    recent = [t for t in writes.get(key, []) if now - t < 60]
    if len(writes) > 10_000:
        writes.clear()
    writes[key] = recent + [now]
    return len(recent) >= rate


def unhex(v) -> bytes | None:
    v = str(v or "").lower()
    return bytes.fromhex(v) if HEX.fullmatch(v) and len(v) % 2 == 0 else None


def load():
    global model
    model = Model(MODEL, temperature=float(os.environ.get("TEMP", "0.9")), top_p=float(os.environ.get("TOPP", "0.92")),
                  revision=REVISION)


class H(BaseHTTPRequestHandler):
    def _client(self) -> str:
        # Behind a proxy every request comes from the proxy; it names the real client in a header.
        if DOOR_SECRET:
            return self.headers.get("X-Client-IP") or "door"
        return self.headers.get("Fly-Client-IP") or self.client_address[0]

    def _door_ok(self) -> bool:
        if not DOOR_SECRET:
            return True
        return hmac.compare_digest(self.headers.get("X-Door-Secret", "").encode(), DOOR_SECRET)

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
        if not self._door_ok():
            return self._send(403, {"error": "forbidden"})
        if self.path.startswith("/drop/"):
            loc = unhex(self.path[len("/drop/"):])
            if not loc or len(loc) < 4:
                return self._send(400, {"error": "bad locator"})
            return self._send(200, {"frame": base64.b64encode(drops.get(loc)).decode()})
        if self.path == "/health":
            return self._send(200, {"model": MODEL, "revision": REVISION, "ready": model is not None,
                                    "temperature": model and model.temperature, "top_p": model and model.top_p,
                                    # the door only puts the machine to sleep when nothing is mid-flight
                                    "busy": lock.locked() or bool(arch and arch.flushing),
                                    "pending": len(arch.pending()) if arch else None,
                                    "pendingAge": arch and arch.oldest_age(),
                                    "flushInterval": arch and arch.interval})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._door_ok():
            return self._send(403, {"error": "forbidden"})
        n = int(self.headers.get("content-length") or 0)
        if n > MAX_BODY:
            return self._send(413, {"error": "too large"})
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._send(400, {"error": "bad json"})
        if self.path == "/drop":
            return self._drop(req)
        if self.path in ("/hide", "/reveal") and limited(self._client(), self.path[1:]):
            return self._send(429, {"error": "slow down"})
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
            if not given and not thread.strip():
                return self._send(400, {"error": "thread or opener required"})
            with lock:
                # The opener is what ties a reply to its thread: the carrier after it sees only the
                # opener, so with no opener it can wander anywhere ("the three-part column on the
                # Constitution", posted on r/fruit). Never post without one: if the page context gave
                # none, try the title alone (its first block); if that fails too, refuse.
                first = given or opener(model, platform, thread)
                if not first:
                    first = opener(model, platform, thread.split("\n\n")[0])
                if not first:
                    return self._send(500, {"error": "no reply that fits this thread, try again"})
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
        if limited(self._client()):
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


def start_archive():
    """WALRUS=testnet|mainnet: also keep every post on Walrus (archive.py). Off when unset."""
    net = os.environ.get("WALRUS", "").strip()
    if not net:
        print("codec2: Walrus archive OFF (posts live on this disk only)", flush=True)
        return
    global arch
    from archive import Archive
    if not os.environ.get("DROP_SECRET"):
        # On a disk that can be lost (boat deletes a stopped disk after 14+ days), a secret kept only
        # on it would take the Walrus index key with it: every archived post unrecoverable.
        print("codec2: WARNING DROP_SECRET unset; the secret lives only on this disk", flush=True)
    arch = Archive(drops, network=net, epochs=int(os.environ.get("WALRUS_EPOCHS", "53")),
                   interval=float(os.environ.get("FLUSH_INTERVAL", "600")))
    if not os.path.exists(arch.path) and os.environ.get("WALRUS_RECOVER", "1") != "0":
        try:                                   # fresh disk: rebuild the index from Walrus first
            print(f"codec2: recovered {arch.recover()} post(s) from Walrus", flush=True)
        except Exception as e:
            print(f"codec2: recovery skipped: {str(e)[-300:]}", flush=True)
    arch.start()
    print(f"codec2: Walrus archive ON ({net}, {arch.epochs} epochs, flush every {arch.interval:.0f}s)", flush=True)


if __name__ == "__main__":
    start_archive()
    threading.Thread(target=load, daemon=True).start()
    print(f"codec2 on :{PORT} loading {MODEL}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()

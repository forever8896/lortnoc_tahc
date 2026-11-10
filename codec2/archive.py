"""
Walrus archive for the drop store: sealed posts go to Walrus in batches (Quilts); the local disk
becomes a cache that can be lost.

    write   a post lands in the local store (drops.py) and is readable at once, as before
    flush   every FLUSH_INTERVAL seconds, or as soon as BATCH_MAX are waiting, the waiting posts are
            uploaded as ONE quilt (walrus/flush.mjs) and recorded in index.json
    read    a locator not on disk but in the index is fetched from a public aggregator and cached
    boot    no index.json but a wallet with quilts? walrus/recover.mjs rebuilds it from Walrus

What Walrus sees: a quilt of uniformly random, bucket-sized blobs under random names, plus one
encrypted index file. The locator (what a reply decodes to) never appears in public — if it did,
anyone could check a reply against Walrus and tell real posts from decoys. The index key is derived
from the drop store's secret, so ONE secret (drops/.secret) plus the wallet address recovers it all.

Why batches: every Walrus blob bills a ~63 MiB encoded floor whatever its size, so one blob per
256-byte post would cost ~600× more than a full quilt (CLAUDE.md §6.4; priced live 2026-10-12).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import threading
import time
import urllib.request

from drops import BUCKETS, DropStore

HERE = os.path.dirname(os.path.abspath(__file__))
AGGREGATORS = {"testnet": "https://aggregator.walrus-testnet.walrus.space",
               "mainnet": "https://aggregator.walrus-mainnet.walrus.space"}
BATCH_MAX = 600            # a quilt holds up to 666 files; one slot is the index


class Archive:
    def __init__(self, store: DropStore, network="testnet", epochs=53, interval=600.0,
                 flush_cmd=None, recover_cmd=None, fetch=None):
        self.store = store
        self.network = network
        self.epochs = epochs
        self.interval = interval
        self.flush_cmd = flush_cmd or ["node", os.path.join(HERE, "walrus", "flush.mjs")]
        self.recover_cmd = recover_cmd or ["node", os.path.join(HERE, "walrus", "recover.mjs")]
        self.aggregator = os.environ.get("WALRUS_AGGREGATOR") or AGGREGATORS[network]
        self.fetch = fetch or self._fetch_http
        self.path = os.path.join(store.root, "index.json")
        self.lock = threading.Lock()
        self.index: dict[str, dict] = {}
        self.last_flush = time.time()
        self.last_error: str | None = None
        self.flushing = False
        if os.path.exists(self.path):
            with open(self.path) as f:
                self.index = json.load(f)
        store.archive = self                         # drops.py consults us on misses

    # ------------------------------------------------------------------ keys + env
    def _env(self) -> dict:
        key = hmac.new(self.store.secret, b"lortnoc/codec2/walrus-index/v1", hashlib.sha256).hexdigest()
        return {**os.environ, "INDEX_KEY": key, "WALRUS_NETWORK": self.network}

    def _save(self):
        tmp = f"{self.path}.{secrets.token_hex(4)}.tmp"
        with open(tmp, "w") as f:
            json.dump(self.index, f)
        os.replace(tmp, self.path)

    # ------------------------------------------------------------------ write side
    def pending(self) -> list[str]:
        """Locators stored locally but not yet on Walrus, oldest first."""
        names = [n for n in os.listdir(self.store.root) if len(n) % 2 == 0 and all(c in "0123456789abcdef" for c in n)]
        with self.lock:
            todo = [n for n in names if n not in self.index]
        return sorted(todo, key=lambda n: os.path.getmtime(os.path.join(self.store.root, n)))

    def flush(self) -> int:
        """Upload up to BATCH_MAX waiting posts as one quilt. Returns how many were archived."""
        todo = self.pending()[:BATCH_MAX]
        if not todo:
            return 0
        items, names = [], {}
        for loc in todo:
            with open(os.path.join(self.store.root, loc), "rb") as f:
                data = f.read()
            if len(data) not in BUCKETS:             # pre-v2 test posts: never publish an odd size
                continue
            names[loc] = "f" + secrets.token_hex(8)  # random: the name must say nothing about the post
            items.append({"name": names[loc], "b64": base64.b64encode(data).decode()})
        if not items:
            return 0
        payload = json.dumps({"items": items, "index": names, "epochs": self.epochs})
        p = subprocess.run(self.flush_cmd, input=payload, capture_output=True, text=True, env=self._env(), timeout=600)
        if p.returncode != 0:
            self.last_error = (p.stderr or p.stdout).strip()[-500:]
            raise RuntimeError(f"walrus flush failed: {self.last_error}")
        res = json.loads(p.stdout)
        with self.lock:
            for loc, name in names.items():
                assert name in res["patches"], f"walrus returned no patch for {name}"
                self.index[loc] = {"b": res["blobId"], "n": name}
            self._save()
        self.last_flush, self.last_error = time.time(), None
        return len(names)

    def oldest_age(self) -> float | None:
        """Seconds the oldest not-yet-archived post has waited, or None. The door uses it to wake a
        sleeping machine in time for the upload."""
        todo = self.pending()
        return time.time() - os.path.getmtime(os.path.join(self.store.root, todo[0])) if todo else None

    def due(self) -> bool:
        # Timed by the OLDEST waiting post, not by process uptime: on a machine that sleeps between
        # uses (boat), every wake is a fresh process, and an uptime clock would never reach 6 h.
        todo = self.pending()
        if len(todo) >= BATCH_MAX:
            return True
        if not todo:
            return False
        return time.time() - os.path.getmtime(os.path.join(self.store.root, todo[0])) >= self.interval

    def run_forever(self, tick=10.0):
        while True:
            try:
                while self.due():
                    self.flushing = True             # /health says busy: the door must not stop us now
                    try:
                        if not self.flush():
                            break
                    finally:
                        self.flushing = False
            except Exception as e:                   # keep serving; posts stay local and retry next tick
                self.last_error = str(e)[-500:]
                print(f"[archive] {self.last_error}", flush=True)
            time.sleep(tick)

    def start(self):
        threading.Thread(target=self.run_forever, daemon=True).start()

    # ------------------------------------------------------------------ read side
    def has(self, loc: str) -> bool:
        with self.lock:
            return loc in self.index

    def get(self, loc: str) -> bytes | None:
        with self.lock:
            entry = self.index.get(loc)
        if not entry:
            return None
        data = self.fetch(entry["b"], entry["n"])
        if data is None or len(data) not in BUCKETS:
            return None
        self.store.cache(bytes.fromhex(loc), data)   # next read is local
        return data

    def _fetch_http(self, blob_id: str, name: str) -> bytes | None:
        # a browser-like UA: the public testnet aggregator answers Python's default with 403 (measured)
        req = urllib.request.Request(f"{self.aggregator}/v1/blobs/by-quilt-id/{blob_id}/{name}",
                                     headers={"User-Agent": "lortnoc-codec2/1"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception:
            return None

    # ------------------------------------------------------------------ recovery
    def recover(self) -> int:
        """Rebuild index.json from the wallet's quilts on Walrus. Returns the number of posts found."""
        p = subprocess.run(self.recover_cmd, capture_output=True, text=True, env=self._env(), timeout=1800)
        if p.returncode != 0:
            raise RuntimeError(f"walrus recover failed: {(p.stderr or p.stdout).strip()[-500:]}")
        found = json.loads(p.stdout)
        with self.lock:
            self.index.update(found)
            self._save()
        return len(found)

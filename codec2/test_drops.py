"""Gate pointer store: first write wins, only the token holder writes, GET always answers.

    .venv/bin/python -m unittest test_drops -v
"""
import base64
import json
import os
import tempfile
import threading
import unittest
import urllib.error

F1, F2 = os.urandom(256), os.urandom(512)   # sealed v2 frames are always bucket-sized
import urllib.request

from drops import BUCKETS, DropStore, locator_for, new_token


class Store(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.s = DropStore(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def test_put_get(self):
        tok = new_token()
        loc = locator_for(tok, 8)
        self.assertEqual(self.s.put(loc, F1, tok), "stored")
        self.assertEqual(self.s.get(loc), F1)

    def test_first_write_wins(self):
        tok = new_token()
        loc = locator_for(tok, 8)
        self.s.put(loc, F1, tok)
        self.assertEqual(self.s.put(loc, F2, tok), "exists")
        self.assertEqual(self.s.get(loc), F1)

    def test_concurrent_writers_one_winner(self):
        tok = new_token()
        loc = locator_for(tok, 8)
        results = []
        ts = [threading.Thread(target=lambda i=i: results.append(self.s.put(loc, bytes([i]) * 256, tok))) for i in range(16)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(results.count("stored"), 1)
        self.assertEqual(results.count("exists"), 15)
        self.assertEqual([f for f in os.listdir(self.dir.name) if f.endswith(".tmp")], [])

    def test_locator_needs_its_token(self):
        """A reader who decoded the locator cannot write to it — or probe it by write-then-read."""
        loc = locator_for(new_token(), 8)
        self.assertEqual(self.s.put(loc, F2, new_token()), "forbidden")
        self.assertEqual(self.s.put(loc, F2, loc), "forbidden")
        self.assertNotEqual(self.s.get(loc), F2)

    def test_decoy_deterministic_and_random_looking(self):
        loc = os.urandom(8)
        a, b = self.s.get(loc), self.s.get(loc)
        self.assertEqual(a, b)
        self.assertIn(len(a), BUCKETS)
        self.assertNotEqual(a, self.s.get(os.urandom(8)))
        self.assertGreater(len(set(a)), len(a) // 3)  # not a constant / low-entropy filler

    def test_decoy_stable_across_restart(self):
        loc = os.urandom(8)
        self.assertEqual(self.s.get(loc), DropStore(self.dir.name).get(loc))

    def test_decoy_sizes_follow_the_buckets(self):
        sizes = [len(self.s.get(os.urandom(8))) for _ in range(400)]
        self.assertTrue(set(sizes) <= set(BUCKETS))
        self.assertGreater(sizes.count(256) / len(sizes), 0.8)   # where nearly every real post is

    def test_decoy_differs_per_secret(self):
        loc = os.urandom(8)
        with tempfile.TemporaryDirectory() as other:
            self.assertNotEqual(self.s.get(loc), DropStore(other).get(loc))

    def test_invalid(self):
        tok = new_token()
        self.assertEqual(self.s.put(locator_for(tok, 8), b"", tok), "invalid")
        self.assertEqual(self.s.put(locator_for(tok, 8), b"x" * 5000, tok), "invalid")
        self.assertEqual(self.s.put(locator_for(tok, 8), b"x" * 150, tok), "invalid")   # not a bucket: a tell
        self.assertEqual(self.s.put(locator_for(tok, 2), b"x", tok), "invalid")


class Http(unittest.TestCase):
    """The routes, over a real socket. No model needed: /drop never touches it."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        os.environ["DROP_DIR"] = cls.dir.name
        os.environ["DROP_RATE"] = "1000"
        import server

        cls.server = server
        server.drops = DropStore(cls.dir.name)
        server.DROP_RATE = 1000
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.dir.cleanup()

    def call(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data, {"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_round_trip(self):
        tok = new_token()
        loc = locator_for(tok, 8).hex()
        frame = base64.b64encode(os.urandom(256)).decode()
        self.assertEqual(self.call("/drop", {"locator": loc, "token": tok.hex(), "frame": frame})[0], 201)
        self.assertEqual(self.call(f"/drop/{loc}"), (200, {"frame": frame}))
        other = base64.b64encode(os.urandom(256)).decode()
        self.assertEqual(self.call("/drop", {"locator": loc, "token": tok.hex(), "frame": other})[0], 409)
        self.assertEqual(self.call(f"/drop/{loc}")[1]["frame"], frame)

    def test_unknown_always_answers(self):
        loc = os.urandom(8).hex()
        s1, a = self.call(f"/drop/{loc}")
        s2, b = self.call(f"/drop/{loc.upper()}")
        self.assertEqual((s1, s2), (200, 200))
        self.assertEqual(a, b)
        self.assertIn(len(base64.b64decode(a["frame"])), BUCKETS)

    def test_wrong_token_forbidden(self):
        loc = locator_for(new_token(), 8).hex()
        frame = base64.b64encode(F2).decode()
        self.assertEqual(self.call("/drop", {"locator": loc, "token": new_token().hex(), "frame": frame})[0], 403)

    def test_bad_requests(self):
        self.assertEqual(self.call("/drop/zz")[0], 400)
        self.assertEqual(self.call("/drop", {"locator": "nothex", "token": "00", "frame": "AA=="})[0], 400)
        tok = new_token()
        loc = locator_for(tok, 8).hex()
        self.assertEqual(self.call("/drop", {"locator": loc, "token": tok.hex(), "frame": "!!"})[0], 400)

    def test_model_routes_rate_limited_per_client(self):
        """/hide holds the single model for ~20 s; one client must not be able to queue everyone else out.
        The limit applies before the model is even needed (here it is never loaded)."""
        self.server.HIDE_RATE = 2
        try:
            codes = [self.call("/hide", {"platform": "x", "thread": "t"})[0] for _ in range(3)]
            self.assertEqual(codes[:2], [503, 503])   # under the limit: reaches "model loading"
            self.assertEqual(codes[2], 429)
        finally:
            self.server.HIDE_RATE = 10
            self.server.writes.clear()

    def test_rate_limit(self):
        self.server.DROP_RATE = 2
        try:
            codes = [self.call("/drop", {"locator": "00" * 8, "token": "00" * 16, "frame": "AA=="})[0] for _ in range(4)]
            self.assertEqual(codes[-1], 429)
        finally:
            self.server.DROP_RATE = 1000
            self.server.writes.clear()


if __name__ == "__main__":
    unittest.main()

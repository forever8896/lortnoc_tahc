"""Walrus archive (archive.py) with a fake uploader: batching, naming, reads after the disk is lost,
first-write-wins across the archive, and nothing odd-sized or locator-named ever leaving the box.

    .venv/bin/python -m unittest test_archive -v
"""
import base64
import json
import os
import sys
import tempfile
import unittest

from archive import Archive
from drops import DropStore, locator_for, new_token

FAKE_FLUSH = r'''
import json, sys, os
req = json.load(sys.stdin)
log = os.environ["FAKE_LOG"]
with open(log, "a") as f:
    f.write(json.dumps(req) + "\n")
blob = "B%d" % sum(1 for _ in open(log))
print(json.dumps({"blobId": blob, "blobObjectId": "0x1", "endEpoch": 9,
                  "patches": {it["name"]: blob + it["name"] for it in req["items"]}}))
'''


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = DropStore(self.dir.name)
        self.log = os.path.join(self.dir.name, "..", f"flushlog-{os.getpid()}-{id(self)}")
        self.script = os.path.join(self.dir.name, "..", f"fakeflush-{os.getpid()}-{id(self)}.py")
        open(self.script, "w").write(FAKE_FLUSH)
        os.environ["FAKE_LOG"] = self.log
        self.remote = {}                                     # (blob, name) -> bytes, what "Walrus" holds
        self.arch = Archive(self.store, flush_cmd=[sys.executable, self.script], fetch=self._fetch)

    def tearDown(self):
        for p in (self.log, self.script):
            if os.path.exists(p):
                os.remove(p)
        self.dir.cleanup()

    def _fetch(self, blob, name):
        return self.remote.get((blob, name))

    def _requests(self):
        return [json.loads(l) for l in open(self.log)] if os.path.exists(self.log) else []

    def _post(self, size=256):
        tok = new_token()
        loc = locator_for(tok, 8)
        frame = os.urandom(size)
        self.assertEqual(self.store.put(loc, frame, tok), "stored")
        return loc, frame

    def _upload_to_fake_walrus(self):
        # what the fake flush "stored": each request's items, under the blob id it returned (B1, B2…)
        for i, req in enumerate(self._requests(), 1):
            for it in req["items"]:
                self.remote[(f"B{i}", it["name"])] = base64.b64decode(it["b64"])

    def test_one_quilt_per_batch(self):
        posts = [self._post() for _ in range(5)]
        self.assertEqual(self.arch.flush(), 5)
        reqs = self._requests()
        self.assertEqual(len(reqs), 1)                       # five posts, ONE upload
        self.assertEqual(len(reqs[0]["items"]), 5)
        self.assertEqual(self.arch.pending(), [])
        self.assertEqual(self.arch.flush(), 0)               # nothing new: no upload
        self.assertEqual(len(self._requests()), 1)
        for loc, _ in posts:
            self.assertTrue(self.arch.has(loc.hex()))

    def test_due_is_timed_by_the_oldest_post_not_uptime(self):
        """On boat every wake is a new process. An uptime clock restarts each time and, on a machine
        that never stays up 6 h, would never upload at all. The oldest waiting post decides."""
        self.arch.interval = 3600
        loc, _ = self._post()
        self.assertFalse(self.arch.due())                    # fresh post: wait
        old = os.path.getmtime(os.path.join(self.store.root, loc.hex())) - 7200
        os.utime(os.path.join(self.store.root, loc.hex()), (old, old))
        fresh = Archive(self.store, flush_cmd=self.arch.flush_cmd, fetch=self._fetch, interval=3600)
        self.assertTrue(fresh.due())                         # a just-woken process uploads at once

    def test_locators_never_leave_in_the_clear(self):
        """Quilt names are public. A locator there would let anyone tell a real reply from a decoy."""
        posts = [self._post() for _ in range(3)]
        self.arch.flush()
        req = self._requests()[0]
        names = [it["name"] for it in req["items"]]
        for loc, _ in posts:
            self.assertNotIn(loc.hex(), json.dumps(req["items"]))
            self.assertNotIn(loc.hex(), names)
        self.assertEqual(len(set(names)), 3)
        # the locator→name map is handed to the uploader, which ENCRYPTS it (walrus/common.mjs)
        self.assertEqual(set(req["index"]), {loc.hex() for loc, _ in posts})

    def test_disk_lost_reads_come_from_walrus(self):
        loc, frame = self._post()
        self.arch.flush()
        self._upload_to_fake_walrus()
        os.remove(os.path.join(self.store.root, loc.hex()))  # the disk copy is gone
        self.assertEqual(self.store.get(loc), frame)         # …but the post still resolves
        self.assertTrue(os.path.exists(os.path.join(self.store.root, loc.hex())))  # and is cached again

    def test_first_write_wins_across_the_archive(self):
        tok = new_token()
        loc = locator_for(tok, 8)
        self.store.put(loc, os.urandom(256), tok)
        self.arch.flush()
        os.remove(os.path.join(self.store.root, loc.hex()))
        self.assertEqual(self.store.put(loc, os.urandom(256), tok), "exists")

    def test_unknown_locator_is_still_a_decoy(self):
        self.arch.flush()
        loc = os.urandom(8)
        self.assertEqual(self.store.get(loc), self.store.decoy(loc))

    def test_odd_sized_legacy_files_are_never_published(self):
        with open(os.path.join(self.store.root, "ab" * 8), "wb") as f:
            f.write(os.urandom(150))                         # a pre-v2 test post
        loc, _ = self._post()
        self.arch.flush()
        sizes = {len(base64.b64decode(it["b64"])) for it in self._requests()[0]["items"]}
        self.assertEqual(sizes, {256})

    def test_failed_upload_keeps_posts_pending(self):
        self.arch.flush_cmd = [sys.executable, "-c", "import sys; sys.exit('relay down')"]
        loc, _ = self._post()
        with self.assertRaises(RuntimeError):
            self.arch.flush()
        self.assertEqual(self.arch.pending(), [loc.hex()])   # retried next tick, nothing lost

    def test_index_survives_restart(self):
        loc, _ = self._post()
        self.arch.flush()
        again = Archive(DropStore(self.dir.name), flush_cmd=self.arch.flush_cmd, fetch=self._fetch)
        self.assertTrue(again.has(loc.hex()))


if __name__ == "__main__":
    unittest.main()

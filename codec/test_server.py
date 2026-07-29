"""
HTTP surface tests for the codec service (server.py) — CLAUDE.md §6.2.

Spins the real ThreadingHTTPServer in-process on an ephemeral port and speaks to it over
real HTTP, so routing, status codes, CORS and the x402 paywall are exercised exactly as the
extension's service worker exercises them. No external process, no network.

The status codes are load-bearing and easy to break silently:
  * 422 on /decode means "ordinary chatter" — the extension CACHES that verdict and never
    retries the bubble. If a transient failure ever returned 422, a real message would be
    permanently swallowed.
  * anything else on /decode means "transient" — the extension retries.
  * 402 on /encode is the paywall and must carry a spec-shaped x402 body.

Run:  python3 -m unittest test_server -v      (or ./run_tests.py)
"""
import base64
import json
import os
import threading
import unittest
import urllib.error
import urllib.request

# The backend is chosen at import time. wordmap is dependency-free and instant, and the
# properties under test here are the HTTP contract, not the quality of the cover text.
os.environ.setdefault("CODEC_BACKEND", "wordmap")

import auth  # noqa: E402
import codec  # noqa: E402
import coder  # noqa: E402
import server  # noqa: E402

from http.server import ThreadingHTTPServer  # noqa: E402


def _post(url, obj, headers=None):
    req = urllib.request.Request(
        url, data=json.dumps(obj).encode(), method="POST",
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode()), dict(r.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw), dict(e.headers)
        except json.JSONDecodeError:
            return e.code, raw, dict(e.headers)


def _get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode()), dict(r.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw), dict(e.headers)
        except json.JSONDecodeError:
            return e.code, raw, dict(e.headers)


class ServerTestCase(unittest.TestCase):
    """Base: one shared server for the whole module."""

    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        auth._counts.clear()
        self._enforce, self._secret, self._limit = auth.ENFORCE, auth.SECRET, auth.FREE_LIMIT
        auth.ENFORCE = False

    def tearDown(self):
        auth.ENFORCE, auth.SECRET, auth.FREE_LIMIT = self._enforce, self._secret, self._limit

    def encode(self, data: bytes, **kw):
        return _post(f"{self.base}/encode", {"ciphertext": base64.b64encode(data).decode(), **kw})

    def decode(self, cover: str):
        return _post(f"{self.base}/decode", {"coverText": cover})


class HealthTests(ServerTestCase):
    def test_health_reports_model_digest_and_readiness(self):
        status, body, _ = _get(f"{self.base}/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ready"])
        self.assertEqual(body["model"], codec.MODEL)
        self.assertEqual(body["digest"], codec.DIGEST)

    def test_health_pins_the_model_so_both_ends_can_assert_they_agree(self):
        # §6.2: reversibility requires a byte-identical model on both ends.
        _, body, _ = _get(f"{self.base}/health")
        self.assertTrue(body["digest"], "the model digest is empty — the pin is meaningless")
        _, again, _ = _get(f"{self.base}/health")
        self.assertEqual(body["digest"], again["digest"], "the digest is not stable across calls")

    def test_health_exposes_the_selection_method(self):
        _, body, _ = _get(f"{self.base}/health")
        self.assertIn("select", body)

    def test_unknown_paths_404(self):
        self.assertEqual(_get(f"{self.base}/nope")[0], 404)
        self.assertEqual(_post(f"{self.base}/nope", {})[0], 404)


class RoundTripTests(ServerTestCase):
    def test_encode_decode_round_trips_exactly(self):
        for payload in [b"", b"\x00", bytes(range(256)), os.urandom(16), os.urandom(300)]:
            status, body, _ = self.encode(payload)
            self.assertEqual(status, 200, body)
            back_status, back, _ = self.decode(body["coverText"])
            self.assertEqual(back_status, 200, back)
            self.assertEqual(base64.b64decode(back["ciphertext"]), payload)

    def test_cover_text_is_plain_lowercase_ascii(self):
        # Invariant §4 — Telegram must not normalise the cover text.
        _, body, _ = self.encode(os.urandom(32))
        cover = body["coverText"]
        self.assertTrue(cover.isascii())
        self.assertEqual(cover, cover.strip(), "cover text has edge whitespace")
        self.assertNotIn("  ", cover)
        self.assertTrue(all(c.islower() or c == " " for c in cover), f"non-plain cover: {cover!r}")

    def test_ordinary_chatter_is_422_the_cacheable_not_ours_verdict(self):
        for chatter in ["hey are you free tonight", "ok", "see you at 8!!", "ç'est la vie"]:
            status, _, _ = self.decode(chatter)
            self.assertEqual(status, 422, f"{chatter!r} did not return the not-ours verdict")

    def test_empty_cover_text_does_not_500(self):
        self.assertIn(self.decode("")[0], (200, 422))

    def test_a_truncated_cover_text_never_leaks_a_5xx(self):
        # Backend-dependent by design: the block coder carries a length header, so a truncated
        # cover is detected and 422s; wordmap is a pure byte<->word map with no header, so a
        # truncation simply yields fewer bytes and decodes "successfully". Either is fine —
        # the AES-SIV tag is the real detector and rejects the short result client-side. What
        # must never happen is a 5xx, which the extension would treat as transient and retry
        # forever.
        _, body, _ = self.encode(os.urandom(48))
        truncated = " ".join(body["coverText"].split()[:3])
        status, _, _ = self.decode(truncated)
        self.assertIn(status, (200, 422), f"a truncated cover produced {status}")

    def test_invalid_base64_on_encode_is_a_400_not_a_crash(self):
        status, _, _ = _post(f"{self.base}/encode", {"ciphertext": "!!!not-base64!!!"})
        self.assertEqual(status, 400)

    def test_a_malformed_encode_request_is_a_400(self):
        self.assertEqual(_post(f"{self.base}/encode", {})[0], 400)

    def test_a_malformed_decode_request_is_400_not_the_cacheable_422(self):
        # CODEC-3. 422 is the extension's CACHEABLE "definitely not ours" verdict: it records
        # the bubble and never retries it. A missing field is a client bug, not a verdict
        # about anyone's cover text, so it must not earn a 422.
        self.assertEqual(_post(f"{self.base}/decode", {})[0], 400)

    def test_only_NotCoverText_earns_a_422(self):
        # The invariant behind CODEC-3, asserted directly: an unexpected internal failure must
        # surface as 5xx (which the extension retries), never as 422 (which it caches, thereby
        # swallowing a real message forever).
        original = codec.decode
        try:
            codec.decode = lambda cover: (_ for _ in ()).throw(RuntimeError("model exploded"))
            status, _, _ = self.decode("some plausible cover text here")
            self.assertEqual(status, 500, "an internal error was cached as 'not ours'")

            codec.decode = lambda cover: (_ for _ in ()).throw(ValueError("bad framing"))
            self.assertEqual(self.decode("x y z")[0], 400, "a plain ValueError leaked a 422")

            codec.decode = lambda cover: (_ for _ in ()).throw(coder.NotCoverText("chatter"))
            self.assertEqual(self.decode("x y z")[0], 422, "genuine chatter no longer 422s")
        finally:
            codec.decode = original

    def test_genuine_chatter_still_422s_through_the_real_backend(self):
        self.assertEqual(self.decode("hey are you free tonight")[0], 422)

    def test_the_response_reports_which_backend_actually_ran(self):
        # HONESTY-1: the dispatcher falls back silently gpt2 -> markov -> wordmap, and the
        # client used to announce "GPT-2" regardless. It can only stop doing that if the
        # server says which one ran.
        _, body, _ = self.encode(os.urandom(16))
        self.assertEqual(body["model"], codec.MODEL)
        self.assertTrue(body["model"])

    def test_the_server_never_sees_plaintext_only_base64_ciphertext(self):
        # Structural: /encode's only input field is `ciphertext`. If a `plaintext` field were
        # ever honoured, invariant §4 would be broken at the API level.
        status, body, _ = _post(f"{self.base}/encode", {"plaintext": "meet at 8"})
        self.assertEqual(status, 400, f"the server accepted a plaintext field: {body}")


class CorsTests(ServerTestCase):
    def test_preflight_is_answered(self):
        req = urllib.request.Request(f"{self.base}/encode", method="OPTIONS")
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertEqual(r.status, 204)
            self.assertEqual(r.headers["Access-Control-Allow-Origin"], "*")

    def test_the_payment_headers_are_allowed_and_exposed(self):
        # x402 rides on X-PAYMENT / X-PAYMENT-RESPONSE; a missing expose header makes the
        # settlement receipt unreadable from a page context.
        req = urllib.request.Request(f"{self.base}/encode", method="OPTIONS")
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertIn("X-PAYMENT", r.headers["Access-Control-Allow-Headers"])
            self.assertIn("X-PAYMENT-RESPONSE", r.headers["Access-Control-Expose-Headers"])


class PaywallTests(ServerTestCase):
    """§7/§9 — server-side enforcement at the one server we run."""

    def setUp(self):
        super().setUp()
        auth.ENFORCE = True
        auth.SECRET = b"test-secret"
        auth.FREE_LIMIT = 3

    def test_free_sends_are_allowed_then_the_paywall_fires(self):
        for i in range(3):
            status, body, _ = self.encode(os.urandom(16), handle="alice")
            self.assertEqual(status, 200, f"blocked on free send {i}: {body}")
            self.assertEqual(body["remaining"], 2 - i)
        status, body, _ = self.encode(os.urandom(16), handle="alice")
        self.assertEqual(status, 402)
        self.assertEqual(body["x402Version"], 1)
        self.assertEqual(body["remaining"], 0)
        self.assertIn("upgrade", body)
        self.assertEqual(len(body["accepts"]), 1)

    def test_a_failed_encode_does_not_cost_a_free_send(self):
        _post(f"{self.base}/encode", {"ciphertext": "!!!bad!!!", "handle": "alice"})
        self.assertEqual(auth._counts.get("@alice", 0), 0, "a rejected request consumed quota")

    def test_reading_is_always_free_even_past_the_limit(self):
        # §7: decrypting your own history is answered by keys you hold and is never metered.
        _, body, _ = self.encode(os.urandom(16), handle="bob")
        cover = body["coverText"]
        for _ in range(10):
            auth.spend("bob")
        self.assertEqual(self.decode(cover)[0], 200, "/decode was metered — reading must be free")

    def test_handshake_frames_are_never_metered(self):
        # §5.3: key exchange must never be blocked, or a blocked user cannot even connect.
        for _ in range(20):
            auth.spend("carol")
        status, body, _ = self.encode(os.urandom(41), handle="carol", fast=True)
        self.assertEqual(status, 200, "a handshake frame hit the paywall")
        self.assertEqual(body["select"], "single", "a fast/handshake encode ran best-of-N")
        self.assertEqual(auth._counts["@carol"], 20, "a handshake frame consumed free quota")

    def test_a_member_token_bypasses_the_paywall(self):
        token = auth.sign_token("nullifier-123")
        for _ in range(20):
            auth.spend("dave")
        status, body, _ = self.encode(os.urandom(16), handle="dave", membership=token)
        self.assertEqual(status, 200)
        self.assertTrue(body["member"])
        self.assertEqual(body["remaining"], -1)

    def test_a_forged_member_token_does_not_bypass_the_paywall(self):
        for _ in range(5):
            auth.spend("eve")
        status, _, _ = self.encode(os.urandom(16), handle="eve", membership="forged.token")
        self.assertEqual(status, 402)

    def test_quota_is_per_handle(self):
        for _ in range(3):
            self.encode(os.urandom(16), handle="alice")
        self.assertEqual(self.encode(os.urandom(16), handle="alice")[0], 402)
        self.assertEqual(self.encode(os.urandom(16), handle="frank")[0], 200)

    def test_the_402_body_never_leaks_the_signing_secret(self):
        for _ in range(4):
            self.encode(os.urandom(16), handle="grace")
        _, body, _ = self.encode(os.urandom(16), handle="grace")
        self.assertNotIn("test-secret", json.dumps(body))

    def test_enforcement_off_leaves_the_gate_open(self):
        # Default posture (CODEC_ENFORCE unset) so an un-updated client keeps working.
        auth.ENFORCE = False
        for _ in range(20):
            status, body, _ = self.encode(os.urandom(16), handle="heidi")
            self.assertEqual(status, 200)
            self.assertEqual(body["remaining"], -1)


class MembershipResourceTests(ServerTestCase):
    def setUp(self):
        super().setUp()
        auth.SECRET = b"test-secret"

    def test_unpaid_request_gets_a_spec_shaped_402(self):
        status, body, _ = _get(f"{self.base}/membership")
        self.assertEqual(status, 402)
        self.assertEqual(body["x402Version"], 1)
        self.assertEqual(body["accepts"][0]["scheme"], "exact")

    def test_an_invalid_payment_does_not_mint_a_token(self):
        original = auth._facilitator
        try:
            auth._facilitator = lambda path, b: {"isValid": False}
            payment = auth._b64u(json.dumps({"payload": {}}).encode())
            status, body, _ = _get(f"{self.base}/membership", headers={"X-PAYMENT": payment})
            self.assertEqual(status, 402)
            self.assertNotIn("token", body)
        finally:
            auth._facilitator = original

    def test_a_settled_payment_mints_a_usable_membership_token(self):
        original = auth.X402_DEV_ACCEPT
        try:
            auth.X402_DEV_ACCEPT = True
            payment = auth._b64u(json.dumps({"payload": {"authorization": {"from": "0xpayer"}}}).encode())
            status, body, headers = _get(f"{self.base}/membership", headers={"X-PAYMENT": payment})
            self.assertEqual(status, 200)
            self.assertTrue(body["member"])
            self.assertTrue(auth.verify_membership(body["token"]))
            self.assertIn("X-PAYMENT-RESPONSE", headers)
        finally:
            auth.X402_DEV_ACCEPT = original


class BodyLimitTests(ServerTestCase):
    def test_an_oversized_body_is_rejected_rather_than_buffered(self):
        oversized = base64.b64encode(os.urandom(200 * 1024)).decode()
        status, _, _ = _post(f"{self.base}/encode", {"ciphertext": oversized})
        self.assertEqual(status, 400)

    def test_a_payload_beyond_the_two_byte_length_header_fails_closed(self):
        # coder.py writes the payload length into 2 bytes, so >65535 bytes cannot be
        # represented. It must fail with a 4xx, never silently truncate to a wrong length.
        if codec._kind == "wordmap":
            self.skipTest("wordmap has no length header")
        status, _, _ = self.encode(os.urandom(70_000))
        self.assertIn(status // 100, (4,), "an over-long payload was not rejected")


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""
Capability gate tests (auth.py) — CLAUDE.md §7, §8, §9.

auth.py is the paywall: it decides who gets cover text. It had no tests at all, which is a
strange place for a project to have none, because every branch here is either "someone pays
who shouldn't have to" or "someone doesn't pay who should".

Config lands in module globals at import time, so these tests set the globals directly rather
than re-importing under a fresh environment. server.py reads `auth.ENFORCE` per request, so
patching the module attribute is exactly what the running service does.

Run:  python3 -m unittest test_auth -v      (or ./run_tests.py)
"""
import base64
import json
import time
import unittest

import auth


class TokenTests(unittest.TestCase):
    """Membership tokens: HMAC bearer capabilities carrying a nullifier, never a handle (§8)."""

    def setUp(self):
        self._secret = auth.SECRET
        auth.SECRET = b"test-secret-not-the-real-one"

    def tearDown(self):
        auth.SECRET = self._secret

    def test_roundtrip(self):
        self.assertTrue(auth.verify_membership(auth.sign_token("0xnullifier")))

    def test_carries_the_nullifier_not_the_handle(self):
        # §8: the codec must never learn which payment maps to which usage.
        token = auth.sign_token("12345678901234567890")
        body = json.loads(auth._unb64u(token.split(".")[0]))
        self.assertEqual(body["nul"], "12345678901234567890")
        self.assertNotIn("handle", body)
        self.assertNotIn("payer", body)

    def test_expired_token_is_rejected(self):
        self.assertFalse(auth.verify_membership(auth.sign_token("n", ttl=-1)))

    def test_token_expiring_this_second_is_rejected(self):
        payload = {"v": 1, "nul": "n", "exp": int(time.time()) - 1}
        self.assertFalse(auth.verify_membership(self._forge(payload, auth.SECRET)))

    def test_tampered_payload_is_rejected(self):
        token = auth.sign_token("n")
        body, sig = token.split(".", 1)
        forged = json.loads(auth._unb64u(body))
        forged["exp"] = forged["exp"] + 10_000_000  # extend the lifetime
        self.assertFalse(auth.verify_membership(f"{auth._b64u(json.dumps(forged).encode())}.{sig}"))

    def test_token_signed_with_a_different_secret_is_rejected(self):
        token = self._forge({"v": 1, "nul": "n", "exp": int(time.time()) + 600}, b"attacker-secret")
        self.assertFalse(auth.verify_membership(token))

    def test_token_without_a_nullifier_is_rejected(self):
        # A validly-signed token that binds nothing would be a free pass (§8).
        self.assertFalse(auth.verify_membership(self._forge({"v": 1, "nul": "", "exp": int(time.time()) + 600}, auth.SECRET)))

    def test_malformed_tokens_never_raise(self):
        for bad in ["", "no-dot", "a.b.c", "....", "!!!.???", None, 12345, "a." + "A" * 64]:
            self.assertFalse(auth.verify_membership(bad), f"accepted {bad!r}")

    def test_signing_without_a_secret_raises_rather_than_minting_garbage(self):
        auth.SECRET = b""
        with self.assertRaises(RuntimeError):
            auth.sign_token("n")

    def test_verification_without_a_secret_denies_everything(self):
        good = auth.sign_token("n")
        auth.SECRET = b""
        self.assertFalse(auth.verify_membership(good))

    @staticmethod
    def _forge(payload, secret):
        import hashlib
        import hmac

        body = auth._b64u(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
        sig = auth._b64u(hmac.new(secret, body.encode(), hashlib.sha256).digest())
        return f"{body}.{sig}"


class HandleBucketTests(unittest.TestCase):
    """Free metering is keyed by the client-asserted Telegram handle (§9)."""

    def setUp(self):
        auth._counts.clear()

    def test_normalisation_collapses_trivial_variants_into_one_bucket(self):
        # Otherwise "@Alice", "alice" and " alice " would each get a fresh free allowance.
        for variant in ["alice", "@alice", "@Alice", "  ALICE  ", "@ALICE"]:
            auth.spend(variant)
        self.assertEqual(auth._counts["@alice"], 5)
        self.assertEqual(len(auth._counts), 1)

    def test_absent_handle_falls_into_one_shared_anon_bucket(self):
        # Deliberate: an unidentified caller must not get an unlimited private allowance.
        auth.spend(None)
        auth.spend("")
        auth.spend("   ")
        self.assertEqual(auth._counts[auth._ANON], 3)

    def test_distinct_handles_get_distinct_allowances(self):
        auth.spend("alice")
        auth.spend("bob")
        self.assertEqual(auth._counts["@alice"], 1)
        self.assertEqual(auth._counts["@bob"], 1)


class AuthorizeTests(unittest.TestCase):
    def setUp(self):
        auth._counts.clear()
        self._secret, self._limit = auth.SECRET, auth.FREE_LIMIT
        auth.SECRET = b"test-secret"
        auth.FREE_LIMIT = 3

    def tearDown(self):
        auth.SECRET, auth.FREE_LIMIT = self._secret, self._limit

    def test_fresh_handle_is_allowed_with_the_full_allowance(self):
        v = auth.authorize("alice", None)
        self.assertEqual((v["allow"], v["member"], v["remaining"]), (True, False, 3))

    def test_allowance_is_consumed_only_by_spend_not_by_authorize(self):
        # authorize() is a check; the send is only charged after a SUCCESSFUL encode, so a
        # codec error must not cost the user a free message.
        for _ in range(10):
            auth.authorize("alice", None)
        self.assertEqual(auth.authorize("alice", None)["remaining"], 3)

    def test_blocks_exactly_at_the_limit(self):
        for i in range(3):
            self.assertTrue(auth.authorize("alice", None)["allow"], f"blocked early at {i}")
            auth.spend("alice")
        self.assertFalse(auth.authorize("alice", None)["allow"])
        self.assertEqual(auth.authorize("alice", None)["remaining"], 0)

    def test_a_member_is_unlimited_and_reports_remaining_minus_one(self):
        token = auth.sign_token("nullifier")
        for _ in range(50):
            auth.spend("alice")
        v = auth.authorize("alice", token)
        self.assertEqual((v["allow"], v["member"], v["remaining"]), (True, True, -1))

    def test_an_invalid_token_falls_back_to_the_free_tier_rather_than_denying(self):
        v = auth.authorize("alice", "garbage.token")
        self.assertTrue(v["allow"])
        self.assertFalse(v["member"])

    def test_one_handle_running_out_does_not_affect_another(self):
        for _ in range(5):
            auth.spend("alice")
        self.assertFalse(auth.authorize("alice", None)["allow"])
        self.assertTrue(auth.authorize("bob", None)["allow"])

    def test_authorize_stays_a_read_only_view(self):
        # authorize() is now the non-consuming view (tests, /health). The request path uses
        # reserve(). Calling it must never move the counter.
        for _ in range(10):
            auth.authorize("alice", None)
        self.assertEqual(auth._counts.get("@alice", 0), 0)


class ReserveTests(unittest.TestCase):
    """CODEC-2 — the free-send counter is claimed atomically, not check-then-act."""

    def setUp(self):
        auth._counts.clear()
        self._secret, self._limit = auth.SECRET, auth.FREE_LIMIT
        auth.SECRET = b"test-secret"
        auth.FREE_LIMIT = 3

    def tearDown(self):
        auth.SECRET, auth.FREE_LIMIT = self._secret, self._limit

    def test_reserve_claims_the_slot_immediately(self):
        first = auth.reserve("alice", None)
        self.assertEqual((first["allow"], first["remaining"]), (True, 2))
        self.assertEqual(auth._counts["@alice"], 1, "reserve did not claim the slot")

    def test_reserve_denies_past_the_limit(self):
        for i in range(3):
            self.assertTrue(auth.reserve("alice", None)["allow"], f"denied early at {i}")
        denied = auth.reserve("alice", None)
        self.assertEqual((denied["allow"], denied["remaining"]), (False, 0))

    def test_release_refunds_a_failed_encode(self):
        auth.reserve("alice", None)
        self.assertEqual(auth._counts["@alice"], 1)
        auth.release("alice")
        self.assertEqual(auth._counts["@alice"], 0, "a failed encode still cost a free send")

    def test_release_never_goes_negative(self):
        auth.release("alice")
        auth.release("alice")
        self.assertEqual(auth._counts["@alice"], 0)

    def test_members_are_not_metered_by_reserve(self):
        token = auth.sign_token("nullifier")
        for _ in range(20):
            v = auth.reserve("alice", token)
            self.assertTrue(v["allow"])
            self.assertEqual(v["remaining"], -1)
        self.assertEqual(auth._counts.get("@alice", 0), 0, "a member consumed free quota")

    def test_concurrent_reservations_never_exceed_the_limit(self):
        # The actual race. With the old check-then-spend, every one of these threads passed
        # the check before any of them charged, so all 40 were allowed against a limit of 3.
        import threading

        auth.FREE_LIMIT = 3
        allowed = []
        lock = threading.Lock()
        barrier = threading.Barrier(40)

        def worker():
            barrier.wait()  # maximise the overlap
            if auth.reserve("alice", None)["allow"]:
                with lock:
                    allowed.append(1)

        threads = [threading.Thread(target=worker) for _ in range(40)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(allowed), 3, f"{len(allowed)} sends allowed against a limit of 3")
        self.assertEqual(auth._counts["@alice"], 3)

    def test_reserve_and_release_are_consistent_under_concurrency(self):
        # Half the encodes "fail" and refund. The counter must land exactly on the successes.
        import threading

        auth.FREE_LIMIT = 100
        succeeded = []
        lock = threading.Lock()

        def worker(i):
            if not auth.reserve("bob", None)["allow"]:
                return
            if i % 2 == 0:
                auth.release("bob")  # simulate a failed encode
            else:
                with lock:
                    succeeded.append(i)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(60)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(auth._counts["bob".join(("@", ""))], len(succeeded))


class X402Tests(unittest.TestCase):
    """The paywall is a real x402 resource — the 402 body must match the spec shape."""

    def test_402_body_shape(self):
        body = auth.x402_402_body("https://codec/membership", "lortnoc membership", "payment required")
        self.assertEqual(body["x402Version"], 1)
        self.assertEqual(body["error"], "payment required")
        self.assertEqual(len(body["accepts"]), 1)
        entry = body["accepts"][0]
        for field in ("scheme", "network", "maxAmountRequired", "resource", "payTo", "asset", "maxTimeoutSeconds"):
            self.assertIn(field, entry)
        self.assertEqual(entry["scheme"], "exact")
        self.assertEqual(entry["resource"], "https://codec/membership")

    def test_eip712_domain_is_included_only_for_erc20_assets(self):
        original = auth.X402_ASSET
        try:
            auth.X402_ASSET = ""
            self.assertNotIn("extra", auth.x402_requirements("r", "d"))
            auth.X402_ASSET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
            self.assertEqual(auth.x402_requirements("r", "d")["extra"]["name"], auth.X402_ASSET_NAME)
        finally:
            auth.X402_ASSET = original

    def test_settlement_header_is_decodable_base64url_json(self):
        receipt = {"success": True, "payer": "0xabc", "txHash": "0xdef"}
        self.assertEqual(json.loads(auth._unb64u(auth.x402_settle_header(receipt))), receipt)

    def test_no_payment_header_is_never_accepted(self):
        self.assertIsNone(auth.verify_payment("", auth.x402_requirements("r", "d")))
        self.assertIsNone(auth.verify_payment(None, auth.x402_requirements("r", "d")))

    def test_malformed_payment_header_is_rejected_without_raising(self):
        # `_facilitator` is stubbed because a well-formed-but-unpaid header reaches it, and a
        # unit test must never make a real settlement call to x402.org — it is slow, flaky and
        # not ours. The stub returning None models "the facilitator rejected it".
        original = auth._facilitator
        try:
            auth._facilitator = lambda path, body: None
            for bad in ["not-base64!!", auth._b64u(b"not json"), "", "e30"]:
                self.assertIsNone(auth.verify_payment(bad, auth.x402_requirements("r", "d")))
        finally:
            auth._facilitator = original

    def test_an_unverified_payment_is_never_settled(self):
        # Guards the ordering: /verify must gate /settle. Settling first would hand out a
        # membership for a payment that was never valid.
        calls = []

        def fake(path, body):
            calls.append(path)
            return {"isValid": False}

        original = auth._facilitator
        try:
            auth._facilitator = fake
            payment = auth._b64u(json.dumps({"payload": {}}).encode())
            self.assertIsNone(auth.verify_payment(payment, auth.x402_requirements("r", "d")))
            self.assertEqual(calls, ["/verify"], "settlement was attempted on an invalid payment")
        finally:
            auth._facilitator = original

    def test_a_verified_payment_is_settled_and_yields_a_receipt(self):
        original = auth._facilitator
        try:
            auth._facilitator = lambda path, body: (
                {"isValid": True, "payer": "0xpayer"}
                if path == "/verify"
                else {"success": True, "payer": "0xpayer", "transaction": "0xtx"}
            )
            payment = auth._b64u(json.dumps({"payload": {}}).encode())
            receipt = auth.verify_payment(payment, auth.x402_requirements("r", "d"))
            self.assertEqual(receipt["payer"], "0xpayer")
            self.assertEqual(receipt["txHash"], "0xtx")
            self.assertNotIn("dev", receipt, "a production settlement was flagged as dev")
        finally:
            auth._facilitator = original

    def test_a_facilitator_outage_denies_rather_than_grants(self):
        original = auth._facilitator
        try:
            auth._facilitator = lambda path, body: (_ for _ in ()).throw(OSError("network down"))
            payment = auth._b64u(json.dumps({"payload": {}}).encode())
            self.assertIsNone(auth.verify_payment(payment, auth.x402_requirements("r", "d")))
        finally:
            auth._facilitator = original

    def test_dev_accept_short_circuits_only_when_explicitly_enabled(self):
        original = auth.X402_DEV_ACCEPT
        payment = auth._b64u(json.dumps({"payload": {"authorization": {"from": "0xpayer"}}}).encode())
        try:
            auth.X402_DEV_ACCEPT = True
            receipt = auth.verify_payment(payment, auth.x402_requirements("r", "d"))
            self.assertTrue(receipt["success"])
            self.assertEqual(receipt["payer"], "0xpayer")
            self.assertTrue(receipt["dev"], "a dev-accepted payment must be flagged as such")
        finally:
            auth.X402_DEV_ACCEPT = original

    def test_dev_accept_is_off_by_default(self):
        # A deploy that shipped with X402_DEV_ACCEPT on would give away memberships.
        import os

        self.assertEqual(os.environ.get("X402_DEV_ACCEPT", ""), "", "X402_DEV_ACCEPT is set in this environment")


class StatusTests(unittest.TestCase):
    def test_health_status_never_leaks_the_secret(self):
        original = auth.SECRET
        try:
            auth.SECRET = b"super-secret-value"
            blob = json.dumps(auth.status())
            self.assertNotIn("super-secret-value", blob)
            self.assertEqual(auth.status()["paid"], "hmac-token")
        finally:
            auth.SECRET = original

    def test_health_status_reports_payto_as_a_boolean_not_the_address(self):
        self.assertIsInstance(auth.status()["x402"]["payTo"], bool)


if __name__ == "__main__":
    unittest.main(verbosity=2)

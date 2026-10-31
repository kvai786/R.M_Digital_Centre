import os
import tempfile
import unittest
from datetime import timedelta
from hashlib import sha256

from cryptography.fernet import Fernet

_TMP = tempfile.TemporaryDirectory()
os.environ.update({
    "DATABASE_URL": f"sqlite:///{_TMP.name}/test.db",
    "DOCUMENT_ENCRYPTION_KEY": Fernet.generate_key().decode(),
    "UPLOAD_STORAGE_DIR": f"{_TMP.name}/docs",
    "CSRF_SECRET": "test-csrf-secret-" + "x" * 32,
})
os.environ.pop("RAILWAY_ENVIRONMENT", None)
os.environ.pop("APP_ENV", None)

import ocr_server as server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

MOBILE = "9000000001"
PASSWORD = "Correct-Horse-Battery-9"
HEADERS = {"Origin": "http://testserver"}
IP = "203.0.113.5"


class TierTests(unittest.TestCase):
    def test_progressive_tiers(self):
        now = server.utc_now()
        attempt = server.LoginAttempt(key="k", failures=0, tier=0, permanent=False)
        for _ in range(9):
            server.register_login_failure(attempt, now)
        self.assertIsNone(attempt.locked_until)
        server.register_login_failure(attempt, now)
        self.assertEqual(attempt.locked_until, now + timedelta(minutes=15))
        self.assertEqual((attempt.tier, attempt.failures), (1, 0))
        for _ in range(5):
            server.register_login_failure(attempt, now)
        self.assertEqual(attempt.locked_until, now + timedelta(minutes=30))
        for _ in range(3):
            server.register_login_failure(attempt, now)
        self.assertEqual(attempt.locked_until, now + timedelta(hours=1))
        self.assertFalse(attempt.permanent)
        server.register_login_failure(attempt, now)
        self.assertTrue(attempt.permanent)
        self.assertIsNone(attempt.locked_until)

    def test_captcha_is_single_use_and_checked(self):
        nonce, expires = "n1", int(server.utc_now().timestamp()) + 60
        token = f"{nonce}.{expires}.{server.captcha_signature(nonce, expires, 'ABC12')}"
        self.assertFalse(server.verify_captcha(token, "WRONG"))
        self.assertFalse(server.verify_captcha(token, "ABC12"))
        nonce = "n2"
        token = f"{nonce}.{expires}.{server.captcha_signature(nonce, expires, 'ABC12')}"
        self.assertTrue(server.verify_captcha(token, " abc12 "))
        self.assertFalse(server.verify_captcha(token, "ABC12"))

    def test_captcha_endpoint_hides_answer(self):
        with TestClient(server.app, client=(IP, 50000)) as client:
            data = client.get("/api/auth/captcha").json()
        self.assertTrue(data["image"].startswith("data:image/png;base64,"))
        self.assertEqual(data["token"].count("."), 2)


class LoginFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client_cm = TestClient(server.app, client=(IP, 50000))
        cls.client = cls.client_cm.__enter__()
        with server.SessionLocal() as db:
            db.add(server.User(
                mobile=MOBILE, name="Test Partner", role="retailer",
                password_hash=server.hash_secret(PASSWORD), is_active=True,
            ))
            db.commit()

    @classmethod
    def tearDownClass(cls):
        cls.client_cm.__exit__(None, None, None)

    def setUp(self):
        with server.SessionLocal() as db:
            db.query(server.LoginAttempt).delete()
            db.commit()
        server._captcha_used.clear()
        self.client.cookies.clear()

    def login(self, password, captcha_answer=None):
        body = {"identifier": MOBILE, "password": password}
        if captcha_answer is not None:
            nonce, expires = f"t{len(server._captcha_used)}x", int(server.utc_now().timestamp()) + 60
            body["captchaToken"] = f"{nonce}.{expires}.{server.captcha_signature(nonce, expires, 'GOOD1')}"
            body["captchaAnswer"] = captcha_answer
        return self.client.post("/api/auth/login", json=body, headers=HEADERS)

    def attempt(self):
        key = sha256(f"{IP}|{MOBILE}".encode()).hexdigest()
        with server.SessionLocal() as db:
            row = db.get(server.LoginAttempt, key)
            if row:
                db.expunge(row)
            return row

    def test_captcha_after_initial_failures(self):
        for _ in range(2):
            self.assertNotIn("captchaRequired", self.login("wrong-password").json())
        third = self.login("wrong-password")
        self.assertEqual(third.status_code, 401)
        self.assertTrue(third.json()["captchaRequired"])
        blocked = self.login(PASSWORD)
        self.assertEqual(blocked.status_code, 401)
        self.assertTrue(blocked.json()["captchaRequired"])
        self.assertEqual(self.attempt().failures, 3)
        ok = self.login(PASSWORD, "good1")
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertIsNone(self.attempt())

    def test_permanent_block_and_owner_unlock(self):
        with server.SessionLocal() as db:
            db.add(server.LoginAttempt(
                key=sha256(f"{IP}|{MOBILE}".encode()).hexdigest(), failures=0, tier=3, remote=IP,
                id_hint=MOBILE[-4:],
            ))
            db.commit()
        failed = self.login("wrong-password", "good1")
        self.assertEqual(failed.status_code, 423)
        self.assertTrue(self.attempt().permanent)
        self.assertEqual(self.login(PASSWORD, "good1").status_code, 423)

        with server.SessionLocal() as db:
            owner = server.User(mobile="9000000002", name="Owner", role="master", is_active=True)
            db.add(owner)
            db.commit()
            db.refresh(owner)
            db.expunge(owner)
        server.app.dependency_overrides[server.owner_only] = lambda: owner
        try:
            unlock = self.client.post(
                "/api/supreme/security/unlock", json={"identifier": MOBILE, "ip": IP}, headers=HEADERS)
        finally:
            server.app.dependency_overrides.clear()
        self.assertEqual(unlock.status_code, 200, unlock.text)
        self.assertIsNone(self.attempt())
        self.assertEqual(self.login(PASSWORD).status_code, 200)


if __name__ == "__main__":
    unittest.main()

import os
import secrets
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
MASTER_MOBILE = "9000000002"
STEPUP_MOBILE = "9000000004"
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
            db.add(server.User(
                mobile=MASTER_MOBILE, name="Test Owner", role="master",
                password_hash=server.hash_secret(PASSWORD), is_active=True,
            ))
            cls.stepup_secret = server.pyotp.random_base32()
            db.add(server.User(
                mobile=STEPUP_MOBILE, name="Step-Up Owner", role="master",
                password_hash=server.hash_secret(PASSWORD), is_active=True,
                totp_secret=server.document_fernet().encrypt(cls.stepup_secret.encode()).decode(),
                totp_enrolled=True,
            ))
            db.commit()

    @classmethod
    def tearDownClass(cls):
        cls.client_cm.__exit__(None, None, None)

    def setUp(self):
        with server.SessionLocal() as db:
            db.query(server.LoginAttempt).delete()
            db.query(server.AdminStepUpGrant).delete()
            db.query(server.PortalSession).delete()
            db.query(server.AuditLog).filter(
                server.AuditLog.action.in_(("admin_stepup_failed", "admin_stepup_success")),
            ).delete(synchronize_session=False)
            db.commit()
        server.LOGIN_RATE_LIMITER._hits.clear()
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

    def test_login_is_limited_to_five_attempts_per_minute(self):
        for _ in range(5):
            self.assertNotEqual(self.login("wrong-password").status_code, 429)
        limited = self.login("wrong-password")
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(limited.headers["Retry-After"], "60")

    def test_authenticated_post_requires_csrf_token_and_keeps_security_headers(self):
        signed_in = self.login(PASSWORD)
        self.assertEqual(signed_in.status_code, 200, signed_in.text)
        token = self.client.cookies.get(server.CSRF_COOKIE_NAME)
        self.assertTrue(token)

        rejected = self.client.post("/api/auth/logout", headers=HEADERS)
        self.assertEqual(rejected.status_code, 403)
        self.assertEqual(rejected.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(rejected.headers["X-Frame-Options"], "DENY")
        self.assertIn("Content-Security-Policy", rejected.headers)

        accepted = self.client.post(
            "/api/auth/logout", headers={**HEADERS, "X-CSRF-Token": token},
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)

    def test_api_rate_limit_and_https_headers(self):
        original_limiter = server.API_RATE_LIMITER
        server.API_RATE_LIMITER = server.RateLimiter(limit=1, window_seconds=60)
        original_secure = server.COOKIE_SECURE
        server.COOKIE_SECURE = True
        try:
            response = self.client.get("/api/public/config")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["Strict-Transport-Security"], "max-age=31536000; includeSubDomains")
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(response.headers["X-Frame-Options"], "DENY")
            self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
            limited = self.client.get("/api/public/config")
            self.assertEqual(limited.status_code, 429)
            self.assertEqual(limited.headers["X-Content-Type-Options"], "nosniff")
        finally:
            server.API_RATE_LIMITER = original_limiter
            server.COOKIE_SECURE = original_secure

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
            owner = server.User(mobile="9000000003", name="Owner", role="master", is_active=True)
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

    def test_owner_backup_codes_are_single_use_and_audited(self):
        login = self.client.post(
            "/api/auth/login", json={"identifier": MASTER_MOBILE, "password": PASSWORD}, headers=HEADERS,
        )
        self.assertEqual(login.status_code, 200, login.text)
        preauth = login.json()["preAuth"]
        setup = self.client.post(
            "/api/auth/2fa/enroll-start", json={"preAuth": preauth}, headers=HEADERS,
        )
        self.assertEqual(setup.status_code, 200, setup.text)
        totp_code = server.pyotp.TOTP(setup.json()["manualKey"]).now()
        enrolled = self.client.post(
            "/api/auth/2fa/enroll-verify",
            json={"preAuth": preauth, "code": totp_code}, headers=HEADERS,
        )
        self.assertEqual(enrolled.status_code, 200, enrolled.text)
        codes = enrolled.json()["backupCodes"]
        self.assertEqual(len(codes), 5)
        self.assertEqual(len(set(codes)), 5)

        with server.SessionLocal() as db:
            stored = db.query(server.BackupRecoveryCode).filter_by(
                user_id=enrolled.json()["user"]["id"],
            ).all()
            self.assertEqual(len(stored), 5)
            self.assertTrue(all(row.code_hash not in codes for row in stored))

        self.client.cookies.clear()
        challenge = self.client.post(
            "/api/auth/login", json={"identifier": MASTER_MOBILE, "password": PASSWORD}, headers=HEADERS,
        )
        verified = self.client.post(
            "/api/auth/2fa/verify",
            json={"preAuth": challenge.json()["preAuth"], "code": codes[0]}, headers=HEADERS,
        )
        self.assertEqual(verified.status_code, 200, verified.text)
        with server.SessionLocal() as db:
            self.assertEqual(db.query(server.BackupRecoveryCode).filter_by(
                user_id=verified.json()["user"]["id"],
            ).count(), 4)
            self.assertEqual(db.query(server.AuditLog).filter_by(action="mfa_backup_success").count(), 1)

        self.client.cookies.clear()
        challenge = self.client.post(
            "/api/auth/login", json={"identifier": MASTER_MOBILE, "password": PASSWORD}, headers=HEADERS,
        )
        replay = self.client.post(
            "/api/auth/2fa/verify",
            json={"preAuth": challenge.json()["preAuth"], "code": codes[0]}, headers=HEADERS,
        )
        self.assertEqual(replay.status_code, 401)
        with server.SessionLocal() as db:
            self.assertEqual(db.query(server.BackupRecoveryCode).filter_by(
                user_id=verified.json()["user"]["id"],
            ).count(), 4)
            self.assertEqual(db.query(server.AuditLog).filter_by(action="mfa_backup_failed").count(), 1)

    def test_owner_step_up_is_session_bound_single_use_and_expires(self):
        raw_session = secrets.token_urlsafe(48)
        with server.SessionLocal() as db:
            owner = db.query(server.User).filter_by(mobile=STEPUP_MOBILE).one()
            db.add(server.PortalSession(
                token_hash=sha256(raw_session.encode()).hexdigest(),
                user_id=owner.id,
                expires_at=server.utc_now() + server.SESSION_LIFETIME,
            ))
            db.commit()
            owner_id = owner.id
        self.client.cookies.set(server.COOKIE_NAME, raw_session)
        csrf = server.csrf_token_for(raw_session)
        self.client.cookies.set(server.CSRF_COOKIE_NAME, csrf)
        headers = {**HEADERS, "X-CSRF-Token": csrf}
        code = server.pyotp.TOTP(self.stepup_secret).now()

        rejected = self.client.post(
            "/api/auth/admin-step-up",
            json={"password": "incorrect-password", "code": code},
            headers=headers,
        )
        self.assertEqual(rejected.status_code, 401)

        issued = self.client.post(
            "/api/auth/admin-step-up",
            json={"password": PASSWORD, "code": code},
            headers=headers,
        )
        self.assertEqual(issued.status_code, 200, issued.text)
        token = issued.json()["stepUpToken"]
        with server.SessionLocal() as db:
            stored = db.query(server.AdminStepUpGrant).one()
            self.assertEqual(stored.user_id, owner_id)
            self.assertEqual(stored.token_hash, sha256(token.encode()).hexdigest())
            self.assertNotEqual(stored.token_hash, token)

        other_session = secrets.token_urlsafe(48)
        with server.SessionLocal() as db:
            db.add(server.PortalSession(
                token_hash=sha256(other_session.encode()).hexdigest(),
                user_id=owner_id,
                expires_at=server.utc_now() + server.SESSION_LIFETIME,
            ))
            db.commit()
        other_client = TestClient(server.app, client=(IP, 50001))
        other_client.cookies.set(server.COOKIE_NAME, other_session)
        other_csrf = server.csrf_token_for(other_session)
        other_client.cookies.set(server.CSRF_COOKIE_NAME, other_csrf)
        wrong_session = other_client.post(
            "/api/supreme/alerts/read",
            headers={**HEADERS, "X-CSRF-Token": other_csrf, "X-Admin-Step-Up": token},
        )
        self.assertEqual(wrong_session.status_code, 428)
        self.assertTrue(wrong_session.json()["stepUpRequired"])

        accepted = self.client.post(
            "/api/supreme/alerts/read",
            headers={**headers, "X-Admin-Step-Up": token},
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        replay = self.client.post(
            "/api/supreme/alerts/read",
            headers={**headers, "X-Admin-Step-Up": token},
        )
        self.assertEqual(replay.status_code, 428)

        expired_token = secrets.token_urlsafe(32)
        with server.SessionLocal() as db:
            db.add(server.AdminStepUpGrant(
                token_hash=sha256(expired_token.encode()).hexdigest(),
                user_id=owner_id,
                session_hash=sha256(raw_session.encode()).hexdigest(),
                expires_at=server.utc_now() - timedelta(seconds=1),
            ))
            db.commit()
        expired = self.client.post(
            "/api/supreme/alerts/read",
            headers={**headers, "X-Admin-Step-Up": expired_token},
        )
        self.assertEqual(expired.status_code, 428)
        with server.SessionLocal() as db:
            actions = db.query(server.AuditLog).filter(
                server.AuditLog.action.in_(("admin_stepup_failed", "admin_stepup_success")),
            ).count()
        self.assertEqual(actions, 2)

    def test_owner_step_up_covers_mutations_outside_admin_namespaces(self):
        for path in (
            "/api/transactions",
            "/api/transactions/TXN-1/status",
            "/api/support/tickets",
            "/api/support/tickets/TKT-1/close",
        ):
            with self.subTest(path=path):
                self.assertTrue(server.is_owner_sensitive_mutation(path, "POST"))
        self.assertFalse(server.is_owner_sensitive_mutation("/api/transactions/TXN-1/status", "GET"))
        self.assertFalse(server.is_owner_sensitive_mutation("/api/auth/logout", "POST"))


if __name__ == "__main__":
    unittest.main()

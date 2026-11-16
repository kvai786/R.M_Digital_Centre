import os
import tempfile
import unittest
from unittest.mock import patch

from cryptography.fernet import Fernet
from sqlalchemy.pool import StaticPool

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

HEADERS = {"Origin": "http://testserver"}
PASSWORD = "Correct-Horse-Battery-9"


def route_dependency(path: str, method: str):
    """The role dependency of a route, so tests can substitute a user without a full login."""
    for route in server.app.routes:
        if getattr(route, "path", "") == path and method in getattr(route, "methods", set()):
            return next(dep.call for dep in route.dependant.dependencies if dep.call is not server.get_db)
    raise LookupError(path)


class FollowUpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cm = TestClient(server.app, client=("203.0.113.20", 50000))
        cls.client = cls.cm.__enter__()
        with server.SessionLocal() as db:
            cls.owner = server.User(mobile="9000000100", name="Owner", role="master", is_active=True,
                                    password_hash=server.hash_secret(PASSWORD))
            cls.retailer = server.User(mobile="9000000101", name="Shop One", role="retailer", is_active=True,
                                       password_hash=server.hash_secret(PASSWORD))
            cls.victim = server.User(mobile="9000000102", name="Victim", role="retailer", is_active=True,
                                     password_hash=server.hash_secret(PASSWORD))
            db.add_all([cls.owner, cls.retailer, cls.victim])
            db.commit()
            for user in (cls.owner, cls.retailer, cls.victim):
                db.refresh(user)
                db.expunge(user)

    @classmethod
    def tearDownClass(cls):
        server.app.dependency_overrides.clear()
        cls.cm.__exit__(None, None, None)

    def setUp(self):
        self.client.cookies.clear()
        server.app.dependency_overrides.clear()
        server.LOGIN_RATE_LIMITER._hits.clear()
        with server.SessionLocal() as db:
            db.query(server.LoginAttempt).delete()
            db.commit()

    def as_user(self, path, method, user):
        server.app.dependency_overrides[route_dependency(path, method)] = lambda: user

    def test_owner_login_requires_two_factor(self):
        response = self.client.post(
            "/api/auth/login", json={"identifier": self.owner.mobile, "password": PASSWORD}, headers=HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["twoFactor"], "enroll")
        self.assertNotIn("user", response.json())

    def test_provisioned_master_uses_secure_bootstrap_and_is_preserved(self):
        engine = server.create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        self.addCleanup(engine.dispose)
        server.Base.metadata.create_all(engine)
        sessions = server.sessionmaker(bind=engine, expire_on_commit=False)
        mobile = "9000000198"
        token = "test-bootstrap-token-" + "x" * 32

        def test_db():
            with sessions() as db:
                yield db

        server.app.dependency_overrides[server.get_db] = test_db
        with patch.dict(os.environ, {"APP_ENV": "production", "RM_MASTER_BOOTSTRAP_TOKEN": token}), \
                patch.object(server, "MASTER_ADMIN_MOBILE", mobile):
            with sessions() as db:
                server.provision_master(db)
                user = db.scalar(server.select(server.User).where(server.User.mobile == mobile))
                self.assertEqual(user.role, "master")
                self.assertIsNone(user.password_hash)
                self.assertFalse(user.totp_enrolled)

            lookup = self.client.post("/api/auth/lookup", headers=HEADERS, json={"identifier": mobile})
            self.assertEqual(lookup.json()["step"], "bootstrap")
            rejected = self.client.post("/api/auth/bootstrap", headers=HEADERS, json={
                "identifier": mobile, "password": PASSWORD, "bootstrapToken": "incorrect",
            })
            self.assertEqual(rejected.status_code, 403)
            accepted = self.client.post("/api/auth/bootstrap", headers=HEADERS, json={
                "identifier": mobile, "password": PASSWORD, "bootstrapToken": token,
            })
            self.assertEqual(accepted.status_code, 200, accepted.text)
            self.assertEqual(accepted.json()["twoFactor"], "enroll")

            with sessions() as db:
                user = db.scalar(server.select(server.User).where(server.User.mobile == mobile))
                user.totp_secret = "existing-secret"
                user.totp_enrolled = True
                password_hash = user.password_hash
                db.commit()
                server.provision_master(db)
                db.refresh(user)
                self.assertEqual(user.password_hash, password_hash)
                self.assertEqual(user.totp_secret, "existing-secret")
                self.assertTrue(user.totp_enrolled)
                self.assertEqual(len(db.scalars(server.select(server.User)).all()), 1)

    def test_master_provisioning_requires_token_and_rejects_mobile_collision(self):
        engine = server.create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        server.Base.metadata.create_all(engine)
        sessions = server.sessionmaker(bind=engine)
        mobile = "9000000199"
        with patch.dict(os.environ, {"APP_ENV": "production", "RM_MASTER_BOOTSTRAP_TOKEN": ""}), \
                patch.object(server, "MASTER_ADMIN_MOBILE", mobile), sessions() as db:
            server.provision_master(db)
            self.assertIsNone(db.scalar(server.select(server.User.id)))
            db.add(server.User(mobile=mobile, name="Existing Retailer", role="retailer"))
            db.commit()
            with patch.dict(os.environ, {"RM_MASTER_BOOTSTRAP_TOKEN": "x" * 32}):
                with self.assertRaisesRegex(RuntimeError, "belongs to another user"):
                    server.provision_master(db)

    def test_owner_can_delete_only_revoked_inactive_masteradmin(self):
        mobile = "9000000901"
        with server.SessionLocal() as db:
            user = server.User(
                mobile=mobile, name="Revoked Admin", role="masteradmin", is_active=False,
                password_hash=None, totp_enrolled=False,
            )
            staff = server.StaffAuthorization(
                role="masteradmin", name=user.name, mobile=mobile, scope="Bankura",
                status="revoked", created_by=self.owner.id,
            )
            db.add_all([user, staff])
            db.flush()
            staff_id, user_id = staff.id, user.id
            db.add(server.PortalSession(
                token_hash="d" * 64, user_id=user_id, expires_at=server.utc_now(),
            ))
            db.add(server.BackupRecoveryCode(user_id=user_id, code_hash="e" * 64))
            db.commit()

        self.as_user("/api/owner/staff/{staff_id}", "DELETE", self.owner)
        response = self.client.delete(f"/api/owner/staff/{staff_id}", headers=HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        with server.SessionLocal() as db:
            self.assertIsNone(db.get(server.User, user_id))
            self.assertIsNone(db.get(server.StaffAuthorization, staff_id))
            self.assertIsNone(db.scalar(server.select(server.PortalSession.token_hash).where(
                server.PortalSession.user_id == user_id,
            )))
            self.assertIsNotNone(db.scalar(server.select(server.AuditLog.id).where(
                server.AuditLog.action == "masteradmin_permanent_delete",
            )))
        self.assertTrue(server.is_owner_sensitive_mutation("/api/owner/staff/record-id", "DELETE"))

    def test_owner_delete_rejects_an_active_masteradmin(self):
        mobile = "9000000904"
        with server.SessionLocal() as db:
            user = server.User(mobile=mobile, name="Active Admin", role="masteradmin", is_active=True)
            staff = server.StaffAuthorization(
                role="masteradmin", name=user.name, mobile=mobile, scope="Bankura",
                status="revoked", created_by=self.owner.id,
            )
            db.add_all([user, staff])
            db.commit()
            staff_id, user_id = staff.id, user.id

        self.as_user("/api/owner/staff/{staff_id}", "DELETE", self.owner)
        response = self.client.delete(f"/api/owner/staff/{staff_id}", headers=HEADERS)
        self.assertEqual(response.status_code, 409, response.text)
        with server.SessionLocal() as db:
            self.assertIsNotNone(db.get(server.User, user_id))
            db.delete(db.get(server.User, user_id))
            db.delete(db.get(server.StaffAuthorization, staff_id))
            db.commit()

    def test_owner_can_delete_a_permanently_blocked_masteradmin_account(self):
        mobile = "9000000905"
        account_lock_key = server.sha256(
            ("acct|" + server.normalized_identifier(mobile).casefold()).encode(),
        ).hexdigest()
        with server.SessionLocal() as db:
            user = server.User(mobile=mobile, name="Blocked Admin", role="masteradmin", is_active=True)
            staff = server.StaffAuthorization(
                role="masteradmin", name=user.name, mobile=mobile, scope="Kotulpur",
                status="ready_for_2fa", created_by=self.owner.id,
            )
            db.add_all([user, staff])
            db.add(server.LoginAttempt(key=account_lock_key, permanent=True, failures=20))
            db.commit()
            staff_id, user_id = staff.id, user.id

        self.as_user("/api/owner/staff/{staff_id}", "DELETE", self.owner)
        response = self.client.delete(f"/api/owner/staff/{staff_id}", headers=HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        with server.SessionLocal() as db:
            self.assertIsNone(db.get(server.User, user_id))
            self.assertIsNone(db.get(server.LoginAttempt, account_lock_key))

    def test_growth_campaign_is_date_gated_and_counts_active_target_region_partners(self):
        today = server.utc_now().date()
        start = (today - server.timedelta(days=1)).isoformat()
        end = (today + server.timedelta(days=60)).isoformat()
        mobile = "9000000902"
        application_id = "APP-CAMPAIGN-TEST"
        with server.SessionLocal() as db:
            old = db.get(server.PortalRecord, server.GROWTH_CAMPAIGN_KEY)
            if old:
                db.delete(old)
            db.add(server.User(mobile=mobile, name="Campaign Partner", role="retailer", is_active=True))
            db.add(server.Application(
                id=application_id, mobile=mobile, role="retailer", status="approved",
                distributor_application_id="", submitted_at=server.utc_now(),
                payload={"city": "Kotulpur", "jurisdiction": "Bankura"},
            ))
            db.commit()

        self.as_user("/api/supreme/growth-campaign", "PUT", self.owner)
        payload = {
            "enabled": True,
            "title": "Partner onboarding",
            "message": "Ask about current onboarding terms and eligibility.",
            "region": "Bankura, Kotulpur",
            "startsAt": start,
            "endsAt": end,
        }
        saved = self.client.put("/api/supreme/growth-campaign", headers=HEADERS, json=payload)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["target"], 600)
        self.assertEqual(saved.json()["progress"], 1)

        public = self.client.get("/api/public/growth-campaign", headers=HEADERS)
        self.assertEqual(public.status_code, 200, public.text)
        self.assertTrue(public.json()["active"])
        self.assertEqual(public.json()["region"], "Bankura, Kotulpur")

        payload["endsAt"] = (today + server.timedelta(days=63)).isoformat()
        invalid = self.client.put("/api/supreme/growth-campaign", headers=HEADERS, json=payload)
        self.assertEqual(invalid.status_code, 422)

        with server.SessionLocal() as db:
            campaign = db.get(server.PortalRecord, server.GROWTH_CAMPAIGN_KEY)
            db.delete(campaign)
            db.delete(db.get(server.Application, application_id))
            db.query(server.User).filter_by(mobile=mobile).delete()
            db.commit()

    def test_customer_documents_are_deleted_and_marked_when_purged(self):
        application_id = "APP-PURGE-TEST"
        storage_key = "f" * 32
        storage_dir = server.document_storage_dir()
        path = server.document_storage.local_path(storage_dir, storage_key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"encrypted-document")
        with server.SessionLocal() as db:
            db.add(server.Application(
                id=application_id, mobile="9000000903", role="retailer", status="pending",
                distributor_application_id="", submitted_at=server.utc_now(),
                payload={"documents": [{"id": "a" * 32, "fileName": "id.png"}]},
            ))
            document = server.CustomerDocument(
                id="a" * 32, application_id=application_id, revision=1, label="Identity proof",
                original_filename="id.png", content_type="image/png", size_bytes=20,
                sha256_hex="b" * 64, storage_key=storage_key,
            )
            db.add(document)
            db.flush()
            count = server.purge_application_documents(db, application_id)
            db.commit()
            self.assertEqual(count, 1)
            self.assertIsNotNone(document.purged_at)
            self.assertEqual(document.original_filename, "[purged]")
            self.assertEqual(db.get(server.Application, application_id).payload["documents"][0]["fileName"], "[purged]")
        self.assertFalse(path.exists())

    def test_application_rejection_purges_customer_document_immediately(self):
        application_id = "APP-REVIEW-PURGE"
        mobile = "9000000906"
        storage_key = "9" * 32
        storage_dir = server.document_storage_dir()
        path = server.document_storage.local_path(storage_dir, storage_key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"encrypted-document")
        payload = {
            "id": application_id,
            "name": "Review Applicant",
            "mobile": mobile,
            "role": "retailer",
            "status": "pending",
            "documents": [{"id": "8" * 32, "fileName": "identity.png"}],
            "revisionHistory": [],
        }
        with server.SessionLocal() as db:
            db.add(server.Application(
                id=application_id, mobile=mobile, role="retailer", status="pending",
                distributor_application_id="", submitted_at=server.utc_now(), payload=payload,
            ))
            db.add(server.CustomerDocument(
                id="8" * 32, application_id=application_id, revision=1, label="Identity proof",
                original_filename="identity.png", content_type="image/png", size_bytes=20,
                sha256_hex="7" * 64, storage_key=storage_key,
            ))
            db.flush()
            rejected = {**payload, "status": "rejected", "rejectionReason": "Incomplete documents"}
            server.save_applications(db, [rejected], self.owner)
            db.commit()
            document = db.get(server.CustomerDocument, "8" * 32)
            self.assertEqual(db.get(server.Application, application_id).status, "rejected")
            self.assertIsNotNone(document.purged_at)
        self.assertFalse(path.exists())

    def test_startup_migrates_existing_local_document_bytes_to_cloudinary(self):
        engine = server.create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        self.addCleanup(engine.dispose)
        server.Base.metadata.create_all(engine)
        sessions = server.sessionmaker(bind=engine)
        storage_key = "6" * 32 + ".enc"
        encrypted = b"existing-fernet-ciphertext"
        with tempfile.TemporaryDirectory() as directory:
            root = server.Path(directory)
            path = server.document_storage.local_path(root, storage_key)
            path.write_bytes(encrypted)
            with sessions() as db:
                db.add(server.Application(
                    id="APP-MIGRATE-TEST", mobile="9000000907", role="retailer", status="pending",
                    distributor_application_id="", submitted_at=server.utc_now(), payload={},
                ))
                db.add(server.CustomerDocument(
                    id="5" * 32, application_id="APP-MIGRATE-TEST", revision=1,
                    label="Identity proof", original_filename="identity.png",
                    content_type="image/png", size_bytes=20, sha256_hex="4" * 64,
                    storage_key=storage_key,
                ))
                db.commit()
                with patch.dict(os.environ, {"DOCUMENT_STORAGE_BACKEND": "cloudinary"}), \
                        patch.object(server.document_storage, "store_encrypted") as store:
                    count = server.migrate_local_documents_to_cloudinary(db, root)
            self.assertEqual(count, 1)
            store.assert_called_once_with(root, storage_key, encrypted, overwrite=True)
            self.assertFalse(path.exists())

    def test_owner_assistant_speech_uses_configured_elevenlabs_backend(self):
        server.OWNER_SPEECH_LIMITER._hits.clear()
        server.SPEECH_GLOBAL_LIMITER._hits.clear()
        self.as_user("/api/assistant/owner-speech", "POST", self.owner)
        with patch.object(server, "synthesize_elevenlabs",
                          return_value=server.Response(b"audio", media_type="audio/mpeg")) as synthesize:
            response = self.client.post(
                "/api/assistant/owner-speech", headers=HEADERS, json={"text": "Namaskar"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        synthesize.assert_called_once_with("Namaskar", "en")

    def test_production_startup_provisions_master_in_configured_database(self):
        engine = server.create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        self.addCleanup(engine.dispose)
        sessions = server.sessionmaker(bind=engine, expire_on_commit=False)
        mobile = "9000000197"
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"APP_ENV": "production", "RM_MASTER_BOOTSTRAP_TOKEN": "x" * 32}), \
                patch.object(server, "MASTER_ADMIN_MOBILE", mobile), \
                patch.object(server, "engine", engine), \
                patch.object(server, "SessionLocal", sessions), \
                patch.object(server, "document_fernet"), \
                patch.object(server, "document_storage_dir", return_value=server.Path(directory)), \
                TestClient(server.app):
            with sessions() as db:
                user = db.scalar(server.select(server.User).where(server.User.mobile == mobile))
                self.assertIsNotNone(user)
                self.assertEqual(user.role, "master")
                self.assertIsNone(user.password_hash)

    def test_startup_reset_is_disabled_without_opt_in(self):
        engine = server.create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        server.Base.metadata.create_all(engine)
        sessions = server.sessionmaker(bind=engine)
        mobile = "9000000196"
        with patch.dict(os.environ, {"MASTER_2FA_RESET_ON_STARTUP": "false"}), \
                patch.object(server, "MASTER_ADMIN_MOBILE", mobile), sessions() as db:
            owner = server.User(
                mobile=mobile, name="Owner", role="master", totp_enrolled=True, totp_secret="existing-secret",
            )
            db.add(owner)
            db.commit()
            server.reset_master_two_factor_on_startup(db)
            self.assertTrue(owner.totp_enrolled)
            self.assertEqual(owner.totp_secret, "existing-secret")

    def test_enabled_startup_reset_requires_new_owner_enrollment(self):
        engine = server.create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        self.addCleanup(engine.dispose)
        server.Base.metadata.create_all(engine)
        sessions = server.sessionmaker(bind=engine, expire_on_commit=False)
        mobile = "9000000195"
        with sessions() as db:
            owner = server.User(
                mobile=mobile, name="Owner", role="master", password_hash=server.hash_secret(PASSWORD),
                totp_enrolled=True, totp_secret="old-secret", totp_last_step=123,
            )
            other = server.User(mobile="9000000194", name="Other", role="retailer", totp_enrolled=True)
            db.add_all([owner, other])
            db.flush()
            db.add(server.BackupRecoveryCode(user_id=owner.id, code_hash="a" * 64))
            db.add(server.AdminStepUpGrant(
                user_id=owner.id, token_hash="b" * 64, session_hash="c" * 64,
                expires_at=server.utc_now(),
            ))
            db.commit()

        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"APP_ENV": "production", "MASTER_2FA_RESET_ON_STARTUP": "true"}), \
                patch.object(server, "MASTER_ADMIN_MOBILE", mobile), \
                patch.object(server, "engine", engine), \
                patch.object(server, "SessionLocal", sessions), \
                patch.object(server, "document_storage_dir", return_value=server.Path(directory)), \
                TestClient(server.app) as client:
            with sessions() as db:
                owner = db.scalar(server.select(server.User).where(server.User.mobile == mobile))
                other = db.scalar(server.select(server.User).where(server.User.mobile == "9000000194"))
                self.assertFalse(owner.totp_enrolled)
                self.assertIsNone(owner.totp_secret)
                self.assertEqual(owner.totp_last_step, 0)
                self.assertTrue(other.totp_enrolled)
                self.assertIsNone(db.scalar(server.select(server.BackupRecoveryCode.id)))
                self.assertIsNone(db.scalar(server.select(server.AdminStepUpGrant.token_hash)))
                self.assertIsNotNone(db.scalar(server.select(server.AuditLog.id).where(
                    server.AuditLog.action == "mfa_startup_reset",
                )))
            response = client.post(
                "/api/auth/login", json={"identifier": mobile, "password": PASSWORD}, headers=HEADERS,
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["twoFactor"], "enroll")
            qr = client.post(
                "/api/auth/2fa/enroll-start", headers=HEADERS,
                json={"preAuth": response.json()["preAuth"]},
            )
            self.assertEqual(qr.status_code, 200, qr.text)
            self.assertTrue(qr.json()["qr"].startswith("data:image/"))

    def test_account_lockout_alerts_owner_and_unlocks(self):
        server.ACCOUNT_LOCKOUT_ENABLED, server.ACCOUNT_LOCKOUT_THRESHOLD = True, 3
        try:
            for _ in range(3):
                self.client.post("/api/auth/login", json={"identifier": self.victim.mobile, "password": "bad"}, headers=HEADERS)
            locked = self.client.post(
                "/api/auth/login", json={"identifier": self.victim.mobile, "password": PASSWORD}, headers=HEADERS)
            self.assertEqual(locked.status_code, 429)
            with server.SessionLocal() as db:
                alerts = server.record_value(db, server.OWNER_ALERTS_KEY)
            self.assertTrue(any(a["kind"] == "account_lockout" for a in alerts))
            self.as_user("/api/supreme/security/unlock", "POST", self.owner)
            unlock = self.client.post(
                "/api/supreme/security/unlock", json={"identifier": self.victim.mobile}, headers=HEADERS)
            self.assertEqual(unlock.status_code, 200, unlock.text)
            server.app.dependency_overrides.clear()
            with server.SessionLocal() as db:
                db.query(server.LoginAttempt).delete()
                db.commit()
            ok = self.client.post(
                "/api/auth/login", json={"identifier": self.victim.mobile, "password": PASSWORD}, headers=HEADERS)
            self.assertEqual(ok.status_code, 200, ok.text)
        finally:
            server.ACCOUNT_LOCKOUT_ENABLED, server.ACCOUNT_LOCKOUT_THRESHOLD = False, 20

    def test_account_lockout_off_by_default(self):
        self.assertFalse(server.ACCOUNT_LOCKOUT_ENABLED)

    def test_ticket_alert_and_reply_flag(self):
        self.as_user("/api/support/tickets", "POST", self.retailer)
        created = self.client.post("/api/support/tickets", headers=HEADERS, json={
            "category": "payout", "subject": "Payout delayed", "message": "Not received", "reference": "TXN-1"})
        self.assertEqual(created.status_code, 200, created.text)
        ticket_id = created.json()["id"]
        with server.SessionLocal() as db:
            self.assertTrue(any(a["ref"] == ticket_id for a in server.record_value(db, server.OWNER_ALERTS_KEY)))
        self.as_user("/api/supreme/tickets/{ticket_id}/update", "POST", self.owner)
        self.client.post(f"/api/supreme/tickets/{ticket_id}/update", headers=HEADERS,
                         json={"status": "in_progress", "reply": "Checking now"})
        server.app.dependency_overrides.clear()
        self.as_user("/api/support/tickets", "GET", self.retailer)
        mine = [t for t in self.client.get("/api/support/tickets").json() if t["id"] == ticket_id][0]
        self.assertTrue(mine["replyUnread"])
        server.app.dependency_overrides.clear()
        self.as_user("/api/support/tickets/{ticket_id}/read", "POST", self.retailer)
        self.assertEqual(self.client.post(f"/api/support/tickets/{ticket_id}/read", headers=HEADERS).status_code, 200)
        server.app.dependency_overrides.clear()
        self.as_user("/api/support/tickets", "GET", self.retailer)
        mine = [t for t in self.client.get("/api/support/tickets").json() if t["id"] == ticket_id][0]
        self.assertFalse(mine["replyUnread"])

    def test_transaction_status_transitions(self):
        with server.SessionLocal() as db:
            db.add(server.TransactionRecord(
                user_id=self.retailer.id, reference="TXN-FLOW-1", service="aeps", amount_paise=50000))
            db.commit()
        self.as_user("/api/transactions/{reference}/status", "POST", self.owner)
        url = "/api/transactions/TXN-FLOW-1/status"
        self.assertEqual(self.client.post(url, json={"status": "refunded"}, headers=HEADERS).status_code, 409)
        self.assertEqual(self.client.post(url, json={"status": "bogus"}, headers=HEADERS).status_code, 422)
        step = self.client.post(url, json={"status": "processing", "note": "sent to bank"}, headers=HEADERS)
        self.assertEqual(step.status_code, 200, step.text)
        self.assertEqual(self.client.post(url, json={"status": "success"}, headers=HEADERS).json()["status"], "success")
        self.assertEqual(self.client.post(url, json={"status": "processing"}, headers=HEADERS).status_code, 409)
        history = self.client.post(url, json={"status": "refunded"}, headers=HEADERS).json()["details"]["history"]
        self.assertEqual([h["to"] for h in history], ["processing", "success", "refunded"])

    def test_commission_slabs_hide_distributor_rate_from_retailers(self):
        self.as_user("/api/commission-slabs", "GET", self.retailer)
        slabs = self.client.get("/api/commission-slabs").json()
        self.assertTrue({s["service"] for s in slabs["slabs"]} >= {"aeps", "micro_atm", "bill_payment"})
        self.assertTrue(all("distributorRate" not in s for s in slabs["slabs"]))
        self.assertFalse(slabs["published"])

    def test_owner_publishes_slabs(self):
        self.as_user("/api/supreme/commission-slabs", "PUT", self.owner)
        row = {"service": "aeps", "label": "AEPS", "minAmount": 100, "maxAmount": 500, "unit": "flat",
               "retailerRate": 2, "distributorRate": 0.5}
        self.assertEqual(self.client.put("/api/supreme/commission-slabs", json={"slabs": [{**row, "service": "x"}]},
                                         headers=HEADERS).status_code, 422)
        self.assertEqual(self.client.put("/api/supreme/commission-slabs", json={"slabs": [{**row, "minAmount": 900}]},
                                         headers=HEADERS).status_code, 422)
        self.assertEqual(self.client.put("/api/supreme/commission-slabs", json={"slabs": [row]},
                                         headers=HEADERS).status_code, 200)
        server.app.dependency_overrides.clear()
        self.as_user("/api/commission-slabs", "GET", self.owner)
        data = self.client.get("/api/commission-slabs").json()
        self.assertTrue(data["published"])
        self.assertEqual(len(data["slabs"]), 1)
        with server.SessionLocal() as db:
            db.query(server.PortalRecord).filter_by(key=server.COMMISSION_KEY).delete()
            db.commit()

    def test_service_enquiries_validate_and_alert_the_owner(self):
        server.SERVICE_ENQUIRY_LIMITER._hits.clear()
        with server.SessionLocal() as db:
            db.query(server.PortalRecord).filter(
                server.PortalRecord.key.in_(("rm-demo-service-requests", server.OWNER_ALERTS_KEY)),
            ).delete(synchronize_session=False)
            db.commit()

        invalid = self.client.post(
            "/api/service-enquiries",
            headers=HEADERS,
            json={"name": "Shop One", "mobile": "123", "service": "AEPS", "message": "Please call"},
        )
        self.assertEqual(invalid.status_code, 422)
        with server.SessionLocal() as db:
            self.assertEqual(server.record_value(db, server.OWNER_ALERTS_KEY), [])

        accepted = self.client.post(
            "/api/service-enquiries",
            headers=HEADERS,
            json={"name": "Shop One", "mobile": "9000000123", "service": "AEPS", "message": "Need onboarding"},
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        with server.SessionLocal() as db:
            request = server.record_value(db, "rm-demo-service-requests")[0]
            alerts = server.record_value(db, server.OWNER_ALERTS_KEY)
        self.assertEqual(request["mobile"], "9000000123")
        self.assertEqual(request["status"], "pending")
        self.assertTrue(any(
            alert["kind"] == "service_enquiry" and alert["ref"] == request["id"]
            for alert in alerts
        ))

    def test_public_speech_requires_a_fresh_ip_bound_token(self):
        server.PUBLIC_SPEECH_LIMITER._hits.clear()
        server.SPEECH_GLOBAL_LIMITER._hits.clear()
        settings = self.client.get("/api/public/assistant/config").json()
        self.assertEqual(
            settings["speechToken"],
            server.public_speech_signature(
                settings["greeting"], "203.0.113.20", settings["speechExpiresAt"]),
        )
        text_value = "Namaskar."
        expires_at = int(server.utc_now().timestamp()) + 30
        token = server.public_speech_signature(text_value, "203.0.113.20", expires_at)
        with patch.object(server, "load_ai_settings", return_value=({"public": {"enabled": True}}, {})), \
                patch.object(server, "synthesize_elevenlabs",
                             return_value=server.Response(b"audio", media_type="audio/mpeg")) as synthesize:
            response = self.client.post(
                "/api/public/assistant/speech",
                headers=HEADERS,
                json={"text": text_value, "token": token, "expiresAt": expires_at},
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.content, b"audio")
            synthesize.assert_called_once_with(text_value, "en")

            other_ip_token = server.public_speech_signature(text_value, "198.51.100.40", expires_at)
            other_ip = self.client.post(
                "/api/public/assistant/speech",
                headers=HEADERS,
                json={"text": text_value, "token": other_ip_token, "expiresAt": expires_at},
            )
            self.assertEqual(other_ip.status_code, 403)

            expired_at = int(server.utc_now().timestamp()) - 1
            expired_token = server.public_speech_signature(text_value, "203.0.113.20", expired_at)
            expired = self.client.post(
                "/api/public/assistant/speech",
                headers=HEADERS,
                json={"text": text_value, "token": expired_token, "expiresAt": expired_at},
            )
            self.assertEqual(expired.status_code, 403)
            synthesize.assert_called_once()

    def test_public_chat_issues_a_token_for_its_reply(self):
        server.PUBLIC_ASSISTANT_LIMITER._hits.clear()
        with patch.object(server, "load_ai_settings", return_value=({"logConversations": False}, {})), \
                patch.object(server, "run_chat",
                             return_value=({"reply": "Namaskar."}, 200, "ok", "Hello")), \
                patch.object(server, "log_ai_event"):
            response = self.client.post(
                "/api/public/assistant/chat",
                headers=HEADERS,
                json={"message": "Hello"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(
            data["speechToken"],
            server.public_speech_signature(data["reply"], "203.0.113.20", data["speechExpiresAt"]),
        )

    def test_owner_greeting_requires_master_and_uses_fixed_text(self):
        server.OWNER_SPEECH_LIMITER._hits.clear()
        server.SPEECH_GLOBAL_LIMITER._hits.clear()
        server.app.dependency_overrides[server.current_user] = lambda: self.retailer
        denied = self.client.post("/api/assistant/owner-greeting", headers=HEADERS)
        self.assertEqual(denied.status_code, 403)

        server.app.dependency_overrides[server.current_user] = lambda: self.owner
        with patch.object(server, "synthesize_elevenlabs",
                          return_value=server.Response(b"audio", media_type="audio/mpeg")) as synthesize:
            allowed = self.client.post("/api/assistant/owner-greeting", headers=HEADERS)
        self.assertEqual(allowed.status_code, 200, allowed.text)
        synthesize.assert_called_once_with(server.OWNER_GREETING_TEXT, "en")


class ApostropheTests(unittest.TestCase):
    def test_names_allow_apostrophes(self):
        for value in ("O'Connor", "St. Mary's Store", "D\u2019Souza & Sons", "Mary's and Sons"):
            server.reject_unsafe_text(value, "name", True)
            server.reject_unsafe_text(value, "address", True)

    def test_injection_still_blocked_in_names(self):
        for value in ("x' OR '1'='1", "a' or 1=1", "Robert'); DROP TABLE users;--", "x' UNION SELECT 1",
                      "x'--", "<b>O'Connor</b>", "a' = 'a"):
            with self.assertRaises(ValueError, msg=value):
                server.reject_unsafe_text(value, "name", True)

    def test_other_fields_still_reject_apostrophes(self):
        with self.assertRaises(ValueError):
            server.reject_unsafe_text("it's", "subject", True)


if __name__ == "__main__":
    unittest.main()

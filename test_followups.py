import os
import tempfile
import unittest

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

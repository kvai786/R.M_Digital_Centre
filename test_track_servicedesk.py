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
MOBILE = "9000000077"
APP_ID = "APP-TRACK-1"
TICKET_ID = "TKT-TRACK00001"


class TrackAndDeskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cm = TestClient(server.app, client=("203.0.113.9", 50000))
        cls.client = cls.cm.__enter__()
        with server.SessionLocal() as db:
            db.add(server.Application(
                id=APP_ID, mobile=MOBILE, role="retailer", status="correction_required",
                submitted_at=server.utc_now(), payload={"name": "Test"}))
            server.save_record(db, server.SUPPORT_TICKETS_KEY, [{
                "id": TICKET_ID, "userId": "u1", "name": "Test", "mobile": MOBILE, "role": "retailer",
                "category": "aeps", "subject": "AEPS failed", "message": "Money debited", "reference": "",
                "status": "open", "createdAt": server.utc_now().isoformat(), "reply": "",
            }])
            owner = server.User(
                id="owner-1", mobile="9000000000", name="Owner", role="master", is_active=True,
                password_hash="x", created_at=server.utc_now())
            db.add(owner)
            db.commit()
        cls.owner = owner

    @classmethod
    def tearDownClass(cls):
        server.app.dependency_overrides.clear()
        cls.cm.__exit__(None, None, None)

    def setUp(self):
        self.client.cookies.clear()
        server.TRACK_LIMITER.hits.clear() if hasattr(server.TRACK_LIMITER, "hits") else None

    def track(self, reference, mobile):
        return self.client.post("/api/public/track", json={"reference": reference, "mobile": mobile}, headers=HEADERS)

    def test_application_stage(self):
        response = self.track(APP_ID, MOBILE)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["stage"], "Processing")

    def test_ticket_stage_and_wrong_mobile(self):
        self.assertEqual(self.track(TICKET_ID.lower(), MOBILE).json()["kind"], "Support ticket")
        wrong = self.track(TICKET_ID, "9111111111")
        unknown = self.track("NOPE-1234", MOBILE)
        self.assertEqual((wrong.status_code, unknown.status_code), (404, 404))
        self.assertEqual(wrong.json(), unknown.json())

    def test_track_validation(self):
        self.assertEqual(self.track("x'; --", MOBILE).status_code, 422)
        self.assertEqual(self.track(APP_ID, "123").status_code, 422)

    def test_owner_updates_ticket(self):
        server.app.dependency_overrides[server.owner_only] = lambda: self.owner
        try:
            listing = self.client.get("/api/supreme/tickets?status=open").json()
            self.assertTrue(any(t["id"] == TICKET_ID for t in listing["tickets"]))
            bad = self.client.post(f"/api/supreme/tickets/{TICKET_ID}/update", json={"status": "weird"}, headers=HEADERS)
            self.assertEqual(bad.status_code, 422)
            done = self.client.post(
                f"/api/supreme/tickets/{TICKET_ID}/update",
                json={"status": "in_progress", "reply": "We are checking"}, headers=HEADERS)
            self.assertEqual(done.status_code, 200, done.text)
        finally:
            server.app.dependency_overrides.clear()
        found = self.track(TICKET_ID, MOBILE).json()
        self.assertEqual((found["stage"], found["reply"]), ("Processing", "We are checking"))

    def test_non_owner_blocked(self):
        self.assertIn(self.client.get("/api/supreme/tickets").status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()

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


class ContactMaskingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client_context = TestClient(server.app)
        cls.client = cls.client_context.__enter__()
        with server.SessionLocal() as db:
            db.add_all([
                server.Application(
                    id="dist", mobile="9000000001", role="distributor", status="approved",
                    payload={"id": "dist", "name": "Ramesh Shah", "mobile": "9000000001"},
                ),
                server.Application(
                    id="retail", mobile="9000000002", role="retailer", status="approved",
                    distributor_application_id="dist",
                    payload={"id": "retail", "name": "Rahman Sheikh", "mobile": "9000000002"},
                ),
            ])
            db.commit()

    @classmethod
    def tearDownClass(cls):
        server.app.dependency_overrides.clear()
        cls.client_context.__exit__(None, None, None)

    def tearDown(self):
        server.app.dependency_overrides.clear()

    def as_role(self, role, mobile="9000000009"):
        user = server.User(id=role, role=role, name="Test", mobile=mobile, is_active=True)
        server.app.dependency_overrides[server.current_user] = lambda: user

    def test_mask_helpers(self):
        self.assertEqual(server.mask_name("Rahman Shah"), "Raxxxx Shxx")
        self.assertEqual(server.mask_name("A Li"), "x Lx")
        self.assertEqual(server.mask_mobile("9000000002"), "**02")
        self.assertEqual(server.mask_mobile(""), "")

    def test_network_masks_only_subadmin(self):
        for role in ("master", "masteradmin", "subadmin"):
            self.as_role(role)
            response = self.client.get("/api/admin/network")
            self.assertEqual(response.status_code, 200, response.text)
            retailer = response.json()["retailers"][0]
            self.assertEqual(retailer["name"], "Raxxxx Shxxxx" if role == "subadmin" else "Rahman Sheikh")
            self.assertEqual(retailer["mobile"], "**02" if role == "subadmin" else "9000000002")

    def test_distributor_sees_own_contact_but_masked_retailer(self):
        self.as_role("distributor", "9000000001")
        response = self.client.get("/api/distributor/retailers")
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["distributor"]["name"], "Ramesh Shah")
        self.assertEqual(data["retailers"][0]["name"], "Raxxxx Shxxxx")
        self.assertEqual(data["retailers"][0]["mobile"], "**02")

    def test_retailer_sees_masked_distributor_contact(self):
        self.as_role("retailer", "9000000002")
        response = self.client.get("/api/retailer/profile")
        self.assertEqual(response.status_code, 200, response.text)
        distributor = response.json()["distributor"]
        self.assertEqual(distributor["name"], "Raxxxx Shxx")
        self.assertEqual(distributor["mobile"], "**01")


if __name__ == "__main__":
    unittest.main()

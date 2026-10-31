import json
import os
import tempfile
import unittest
from pathlib import Path

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

ROOT = Path(__file__).parent
PAGES = ("compliance.html", "terms.html", "privacy.html", "refund.html", "index.html", "login.html",
         "register.html", "track.html", "commission.html")


class LegalPagesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cm = TestClient(server.app)
        cls.client = cls.cm.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.cm.__exit__(None, None, None)

    def test_new_assets_are_served(self):
        for name in ("compliance.html", "compliance.js", "credentials.json", "terms.html", "privacy.html",
                     "refund.html", "rm-theme.css", "rm-particles.js"):
            self.assertEqual(self.client.get("/" + name).status_code, 200, name)

    def test_every_page_links_the_legal_policies(self):
        for name in PAGES:
            html = (ROOT / name).read_text(encoding="utf-8")
            for target in ("terms.html", "privacy.html", "refund.html", "compliance.html"):
                self.assertIn(target, html, f"{name} is missing a link to {target}")

    def test_no_inline_scripts_for_csp(self):
        for name in PAGES:
            html = (ROOT / name).read_text(encoding="utf-8")
            self.assertNotRegex(html, r"<script(?![^>]*\bsrc=)[^>]*>", name)

    def test_no_credential_claimed_without_a_real_id(self):
        data = json.loads((ROOT / "credentials.json").read_text(encoding="utf-8"))
        self.assertEqual({c["key"] for c in data["credentials"]}, {"csc", "ezeepay", "spice", "udyam"})
        for item in data["credentials"]:
            if item["verified"]:
                self.assertTrue(item["id"].strip(), f"{item['key']} is marked verified but has no ID")
            if item["verifyUrl"]:
                self.assertTrue(item["verifyUrl"].startswith("https://"))


if __name__ == "__main__":
    unittest.main()

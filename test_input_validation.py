import os
import tempfile
import unittest

from cryptography.fernet import Fernet
from pydantic import ValidationError

_TMP = tempfile.TemporaryDirectory()
os.environ.update({
    "DATABASE_URL": f"sqlite:///{_TMP.name}/input.db",
    "DOCUMENT_ENCRYPTION_KEY": Fernet.generate_key().decode(),
    "UPLOAD_STORAGE_DIR": f"{_TMP.name}/docs",
    "CSRF_SECRET": "test-csrf-secret-" + "x" * 32,
})
os.environ.pop("RAILWAY_ENVIRONMENT", None)
os.environ.pop("APP_ENV", None)

import ocr_server as server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

APPLICATION = {
    "name": "Rahim Mondal", "mobile": "9000000011", "business": "Rahim Digital Point",
    "email": "rahim@example.com", "address": "12 Main Road, Near Bus Stand", "city": "Kolkata",
    "role": "retailer",
}
ATTACKS = ["<script>alert(1)</script>", "x' OR '1'='1", "a; DROP TABLE users", "a -- b", "<img src=x onerror=alert(1)>",
           "javascript:alert(1)", "\uff1cscript\uff1e", "bad\x00byte", "/* c */"]


class InputValidationTests(unittest.TestCase):
    def test_clean_application_passes(self):
        self.assertEqual(server.ApplicationInput(**APPLICATION).name, "Rahim Mondal")

    def test_every_text_field_rejects_attacks(self):
        for field in ("name", "business", "address", "city", "email", "jurisdiction", "referralCode"):
            for attack in ATTACKS:
                with self.subTest(field=field, attack=attack), self.assertRaises(ValidationError):
                    server.ApplicationInput(**{**APPLICATION, field: attack})

    def test_other_models_reject_attacks(self):
        for attack in ATTACKS:
            with self.subTest(attack=attack):
                with self.assertRaises(ValidationError):
                    server.StaffAuthorizationInput(role="subadmin", name=attack, mobile="9000000012", scope="North")
                with self.assertRaises(ValidationError):
                    server.StaffAuthorizationInput(role="subadmin", name="Asha", mobile="9000000012", scope=attack)
                with self.assertRaises(ValidationError):
                    server.AuthInput(identifier=attack[:20] or "x")
                with self.assertRaises(ValidationError):
                    server.TransactionInput(reference="REF-1234", service="aeps", amountPaise=1, details={"note": attack})

    def test_other_models_accept_clean_values(self):
        server.StaffAuthorizationInput(role="subadmin", name="Asha Devi", mobile="9000000012", scope="North Zone")
        server.TransactionInput(reference="REF-1234", service="aeps", amountPaise=1, details={"note": "ok"})

    def test_mobile_must_be_ten_digits(self):
        for mobile in ("123456789", "12345678901", "98765abcde", "9876543210\n", "9876543210'"):
            with self.subTest(mobile=mobile), self.assertRaises(ValidationError):
                server.ApplicationInput(**{**APPLICATION, "mobile": mobile})

    def test_passwords_may_contain_symbols(self):
        body = server.AuthInput(identifier="9000000013", password="p'a;ss--<w>ord", recovery="it's; a -- phrase")
        self.assertIn("'", body.password)

    def test_chat_defers_markup_validation_for_a_polite_reply(self):
        self.assertEqual(server.PublicAssistantRequest(message="What's the AEPS charge -- today?").message[:6], "What's")
        self.assertEqual(
            server.PublicAssistantRequest(message="<script>alert(1)</script>").message,
            "<script>alert(1)</script>",
        )

    def test_api_returns_readable_security_warning_without_echoing_input(self):
        with TestClient(server.app) as client:
            response = client.post(
                "/api/public/assistant/chat", json={"message": "<script>alert(1)</script>"},
                headers={"Origin": "http://testserver"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("security", response.json()["reply"].lower())
        self.assertNotIn("script", response.json()["reply"])

    def test_visitor_assistant_compatibility_route_returns_replies(self):
        with TestClient(server.app) as client:
            for message, marker in (
                ("hi", "Hi!"),
                ("kimo acho", "নমস্কার!"),
                ("আমি ID নিতে চাই", "Retailer"),
            ):
                with self.subTest(message=message):
                    response = client.post(
                        "/api/visitor-assistant", json={"message": message},
                        headers={"Origin": "http://testserver"},
                    )
                    self.assertEqual(response.status_code, 200)
                    self.assertIn(marker, response.json()["reply"])

    def test_unified_chat_route_returns_visitor_reply(self):
        with TestClient(server.app) as client:
            response = client.post(
                "/api/chat", json={"message": "kimo acho"},
                headers={"Origin": "http://testserver"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("নমস্কার!", response.json()["reply"])
        self.assertNotIn("Sorry, I could not respond right now.", response.json()["reply"])


if __name__ == "__main__":
    unittest.main()

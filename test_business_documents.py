import unittest
from io import BytesIO

from test_followups import HEADERS, PASSWORD, server
from fastapi.testclient import TestClient


class BusinessDocumentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cm = TestClient(server.app, client=("203.0.113.30", 50000))
        cls.client = cls.cm.__enter__()
        with server.SessionLocal() as db:
            cls.owner = server.User(mobile="9000000200", name="Doc Owner", role="master", is_active=True,
                                    password_hash=server.hash_secret(PASSWORD))
            cls.retailer = server.User(mobile="9000000201", name="Doc Shop", role="retailer", is_active=True,
                                       password_hash=server.hash_secret(PASSWORD))
            db.add_all([cls.owner, cls.retailer])
            db.commit()
            for user in (cls.owner, cls.retailer):
                db.refresh(user)
                db.expunge(user)

    @classmethod
    def tearDownClass(cls):
        server.app.dependency_overrides.clear()
        cls.cm.__exit__(None, None, None)

    def setUp(self):
        server.app.dependency_overrides.clear()

    def login_as(self, user):
        server.app.dependency_overrides[server.current_user] = lambda: user

    def png(self):
        from PIL import Image
        buffer = BytesIO()
        Image.new("RGB", (20, 20), "white").save(buffer, "PNG")
        return buffer.getvalue()

    def upload(self, doc_type, name, data):
        return self.client.post("/api/supreme/upload-document", headers=HEADERS,
                                data={"doc_type": doc_type}, files={"file": (name, data)})

    def test_owner_upload_and_watermarked_view(self):
        self.login_as(self.owner)
        response = self.upload("udyam", "cert.png", self.png())
        self.assertEqual(response.status_code, 200, response.text)
        viewed = self.client.get(response.json()["document"]["viewUrl"])
        self.assertEqual(viewed.status_code, 200)
        self.assertIn("R.M. Digital Centre", viewed.text)
        self.assertTrue(viewed.headers["content-type"].startswith("text/html"))
        deleted = self.client.delete("/api/supreme/documents/" + response.json()["document"]["id"], headers=HEADERS)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.client.get(response.json()["document"]["viewUrl"]).status_code, 404)

    def test_rejects_bad_type_content_and_non_owner(self):
        self.login_as(self.owner)
        self.assertEqual(self.upload("../etc", "a.png", self.png()).status_code, 400)
        self.assertEqual(self.upload("csc", "a.png", b"not an image").status_code, 400)
        self.assertEqual(self.upload("csc", "a.exe", b"MZ").status_code, 415)
        self.login_as(self.retailer)
        self.assertEqual(self.upload("csc", "a.png", self.png()).status_code, 403)
        self.assertEqual(self.client.get("/api/supreme/documents").status_code, 403)


if __name__ == "__main__":
    unittest.main()

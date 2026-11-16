import os
from contextlib import nullcontext
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import document_storage


class DocumentStorageTests(unittest.TestCase):
    def test_local_store_read_delete_round_trip(self):
        key = "a" * 32
        encrypted = b"fernet-ciphertext"
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"DOCUMENT_STORAGE_BACKEND": "local"}):
            root = Path(directory)
            document_storage.store_encrypted(root, key, encrypted)
            self.assertEqual(document_storage.read_encrypted(root, key), encrypted)
            document_storage.delete_document(root, key)
            with self.assertRaises(document_storage.DocumentStorageNotFound):
                document_storage.read_encrypted(root, key)

    def test_cloudinary_upload_sends_only_encrypted_private_raw_asset(self):
        uploader = SimpleNamespace(upload=Mock(return_value={"public_id": "b" * 32}))
        cloudinary_errors = SimpleNamespace(Error=type("CloudinaryError", (Exception,), {}))
        encrypted = b"opaque-fernet-ciphertext"
        with patch.dict(os.environ, {"DOCUMENT_STORAGE_BACKEND": "cloudinary"}), \
                patch.object(document_storage, "_cloudinary", return_value=(uploader, Mock(), cloudinary_errors)):
            document_storage.store_encrypted(Path("."), "b" * 32, encrypted)

        args, kwargs = uploader.upload.call_args
        self.assertEqual(args[0].getvalue(), encrypted)
        self.assertEqual(kwargs["resource_type"], "raw")
        self.assertEqual(kwargs["type"], "private")
        self.assertEqual(kwargs["format"], "enc")
        self.assertFalse(kwargs["backup"])
        self.assertFalse(kwargs["overwrite"])

    def test_cloudinary_read_uses_signed_private_download(self):
        utils = SimpleNamespace(private_download_url=Mock(return_value="https://cloudinary.invalid/signed"))
        cloudinary_errors = SimpleNamespace(Error=type("CloudinaryError", (Exception,), {}))
        encrypted = b"opaque-fernet-ciphertext"
        with patch.dict(os.environ, {"DOCUMENT_STORAGE_BACKEND": "cloudinary"}), \
                patch.object(document_storage, "_cloudinary", return_value=(Mock(), utils, cloudinary_errors)), \
                patch.object(document_storage, "urlopen", return_value=nullcontext(BytesIO(encrypted))):
            result = document_storage.read_encrypted(Path("."), "c" * 32)

        self.assertEqual(result, encrypted)
        args, kwargs = utils.private_download_url.call_args
        self.assertEqual(args, ("c" * 32, "enc"))
        self.assertEqual(kwargs["resource_type"], "raw")
        self.assertEqual(kwargs["type"], "private")

    def test_cloudinary_delete_requires_confirmed_result(self):
        uploader = SimpleNamespace(destroy=Mock(return_value={"result": "deleted"}))
        cloudinary_errors = SimpleNamespace(Error=type("CloudinaryError", (Exception,), {}))
        with patch.dict(os.environ, {"DOCUMENT_STORAGE_BACKEND": "cloudinary"}), \
                patch.object(document_storage, "_cloudinary", return_value=(uploader, Mock(), cloudinary_errors)):
            document_storage.delete_document(Path("."), "d" * 32)

        uploader.destroy.assert_called_once_with(
            "d" * 32, resource_type="raw", type="private", invalidate=True,
        )


if __name__ == "__main__":
    unittest.main()

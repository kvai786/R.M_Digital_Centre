"""Encrypted document storage adapters for local development and private Cloudinary assets."""

from __future__ import annotations

from io import BytesIO
import os
from pathlib import Path
import re
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


_STORAGE_KEY = re.compile(r"^[0-9a-f]{32}(?:\.enc)?$")
_MAX_ENCRYPTED_BYTES = 12 * 1024 * 1024


class DocumentStorageError(RuntimeError):
    pass


class DocumentStorageNotFound(DocumentStorageError):
    pass


class DocumentStorageUnavailable(DocumentStorageError):
    pass


def backend() -> str:
    value = os.getenv("DOCUMENT_STORAGE_BACKEND", "local").strip().lower()
    if value not in {"local", "cloudinary"}:
        raise RuntimeError("DOCUMENT_STORAGE_BACKEND must be 'local' or 'cloudinary'.")
    return value


def local_path(storage_dir: Path, storage_key: str) -> Path:
    if not _STORAGE_KEY.fullmatch(storage_key):
        raise ValueError("Invalid document storage key.")
    filename = storage_key if storage_key.endswith(".enc") else storage_key + ".enc"
    return storage_dir / filename


def _cloudinary() -> tuple[Any, Any, Any]:
    try:
        import cloudinary
        from cloudinary import exceptions, uploader, utils
    except ImportError as error:
        raise RuntimeError("Install the Cloudinary SDK to use cloud document storage.") from error

    configuration = cloudinary.config(secure=True)
    if not configuration.cloud_name or not configuration.api_key or not configuration.api_secret:
        raise RuntimeError("CLOUDINARY_URL must contain configured Cloudinary credentials.")
    return uploader, utils, exceptions


def ensure_configured() -> None:
    if backend() == "cloudinary":
        _cloudinary()


def _public_id(storage_key: str) -> str:
    if not _STORAGE_KEY.fullmatch(storage_key):
        raise ValueError("Invalid document storage key.")
    return storage_key[:-4] if storage_key.endswith(".enc") else storage_key


def store_encrypted(storage_dir: Path, storage_key: str, encrypted: bytes, *, overwrite: bool = False) -> None:
    if backend() == "local":
        storage_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        destination = local_path(storage_dir, storage_key)
        with destination.open("wb" if overwrite else "xb") as stored_file:
            stored_file.write(encrypted)
        if os.name != "nt":
            destination.chmod(0o600)
        return

    uploader, _, exceptions = _cloudinary()
    try:
        uploader.upload(
            BytesIO(encrypted),
            public_id=_public_id(storage_key),
            resource_type="raw",
            type="private",
            format="enc",
            backup=False,
            overwrite=overwrite,
            unique_filename=False,
        )
    except exceptions.Error as error:
        raise DocumentStorageUnavailable("Cloud document upload failed.") from error


def read_encrypted(storage_dir: Path, storage_key: str) -> bytes:
    if backend() == "local":
        path = local_path(storage_dir, storage_key).resolve()
        if path.parent != storage_dir.resolve() or not path.is_file():
            raise DocumentStorageNotFound("The stored document is missing.")
        return path.read_bytes()

    _, utils, _ = _cloudinary()
    signed_url = utils.private_download_url(
        _public_id(storage_key),
        "enc",
        resource_type="raw",
        type="private",
        expires_at=int(time.time()) + 60,
    )
    try:
        with urlopen(Request(signed_url), timeout=20) as response:
            encrypted = response.read(_MAX_ENCRYPTED_BYTES + 1)
    except HTTPError as error:
        if error.code == 404:
            raise DocumentStorageNotFound("The stored document is missing.") from error
        raise DocumentStorageUnavailable("Cloud document download failed.") from error
    except (URLError, TimeoutError, OSError) as error:
        raise DocumentStorageUnavailable("Cloud document download failed.") from error
    if not encrypted or len(encrypted) > _MAX_ENCRYPTED_BYTES:
        raise DocumentStorageUnavailable("Cloud document download returned an invalid size.")
    return encrypted


def delete_document(storage_dir: Path, storage_key: str) -> None:
    if backend() == "local":
        local_path(storage_dir, storage_key).unlink(missing_ok=True)
        return

    uploader, _, exceptions = _cloudinary()
    try:
        result = uploader.destroy(
            _public_id(storage_key), resource_type="raw", type="private", invalidate=True,
        )
    except exceptions.Error as error:
        raise DocumentStorageUnavailable("Cloud document deletion failed.") from error
    if result.get("result") not in {"deleted", "not found"}:
        raise DocumentStorageUnavailable("Cloud document deletion was not confirmed.")

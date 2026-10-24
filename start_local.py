"""Start the local portal with persistent secrets and data outside OneDrive."""

from __future__ import annotations

import os
from pathlib import Path
import secrets
import subprocess
import sys

from cryptography.fernet import Fernet


def restrict_to_current_user(path: Path, *, directory: bool) -> None:
    identity = subprocess.run(
        ["whoami"], check=True, capture_output=True, text=True,
    ).stdout.strip()
    arguments = ["icacls", str(path), "/inheritance:r", "/grant:r"]
    arguments.append(f"{identity}:(OI)(CI)F" if directory else f"{identity}:F")
    if directory:
        arguments.extend(["/T", "/C"])
    subprocess.run(arguments, check=True, capture_output=True, text=True)


def load_local_configuration() -> Path:
    local_app_data = os.getenv("LOCALAPPDATA")
    if not local_app_data:
        raise RuntimeError("LOCALAPPDATA is not set; local startup requires Windows.")
    data_dir = Path(local_app_data) / "RMDigitalCentre"
    document_dir = data_dir / "private-documents"
    config_path = data_dir / "portal.env"
    document_dir.mkdir(parents=True, exist_ok=True)

    if not config_path.exists():
        database_path = (data_dir / "portal.sqlite3").as_posix()
        settings = {
            "DATABASE_URL": "sqlite:///" + database_path,
            "APP_ENV": "development",
            "MASTER_ADMIN_MOBILE": "8509010483",
            "RM_MASTER_BOOTSTRAP_TOKEN": secrets.token_urlsafe(32),
            "UPLOAD_STORAGE_DIR": str(document_dir),
            "DOCUMENT_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
            "DB_POOL_SIZE": "5",
            "DB_MAX_OVERFLOW": "5",
            "DB_POOL_TIMEOUT_SECONDS": "30",
            "DB_POOL_RECYCLE_SECONDS": "1800",
        }
        config_path.write_text(
            "".join(f"{key}={value}\n" for key, value in settings.items()),
            encoding="ascii",
        )

    restrict_to_current_user(data_dir, directory=True)
    restrict_to_current_user(config_path, directory=False)
    settings: dict[str, str] = {}
    for line in config_path.read_text(encoding="ascii").splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not key:
            raise RuntimeError("The local portal configuration contains an invalid line.")
        settings[key] = value
    required = {
        "DATABASE_URL", "APP_ENV", "MASTER_ADMIN_MOBILE",
        "RM_MASTER_BOOTSTRAP_TOKEN", "UPLOAD_STORAGE_DIR",
        "DOCUMENT_ENCRYPTION_KEY",
    }
    missing = {key for key in required if not settings.get(key)}
    if missing:
        raise RuntimeError("Local portal configuration is missing required settings.")
    os.environ.update(settings)
    return config_path


def main() -> None:
    config_path = load_local_configuration()
    os.environ["PORT"] = "8766"
    os.chdir(Path(__file__).resolve().parent)
    sys.path.insert(0, os.getcwd())
    print("Starting R.M Digital Centre at http://127.0.0.1:8766")
    print(f"Local setup token and encryption key are protected in: {config_path}")
    import uvicorn

    uvicorn.run("ocr_server:app", host="127.0.0.1", port=8766, log_level="info")


if __name__ == "__main__":
    main()

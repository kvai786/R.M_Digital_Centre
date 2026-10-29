"""R.M Digital Centre portal API and document OCR service."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from hashlib import scrypt, sha256
from hmac import compare_digest, new as hmac_new
import base64
from io import BytesIO
import json
import logging
import os
from pathlib import Path
from platform import system
import re
import secrets
import threading
from typing import Any, AsyncGenerator
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, ValidationInfo, field_validator
from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, create_engine, func, inspect, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
import pyotp
import qrcode
from cryptography.fernet import Fernet, InvalidToken
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile as StarletteUploadFile
from starlette.responses import StreamingResponse

from assistant_control import (
    CONFIG_KEY as AI_CONFIG_KEY, default_config as default_ai_config, normalize_config as normalize_ai_config,
    redact_for_log, run_chat, safe_config as safe_ai_config,
)
from assistant_triage import RateLimiter

ASSISTANT_LIMITER = RateLimiter(limit=15, window_seconds=60)
PUBLIC_ASSISTANT_LIMITER = RateLimiter(limit=10, window_seconds=60)
BASE_DIR = Path(__file__).resolve().parent
OWNER_CONSOLE_DIR = BASE_DIR / "owner_console"
OWNER_CONSOLE_ASSETS = {"owner.js", "owner.css"}
AI_LOG_ACTIONS = {"public": "ai_public_chat", "portal": "ai_portal_chat"}
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
MAX_TOTAL_DOCUMENT_BYTES = 40 * 1024 * 1024
MAX_IMAGE_DIMENSION = 8000
MAX_IMAGE_PIXELS = 20_000_000
SESSION_LIFETIME = timedelta(hours=8)
LOGIN_FAILURE_LIMIT = 10
LOGIN_LOCK_TIME = timedelta(minutes=15)
MASTER_ADMIN_MOBILE = os.getenv("MASTER_ADMIN_MOBILE", "8509010483")
COOKIE_NAME = "rm_portal_session"
LOGGER = logging.getLogger(__name__)
UTC = timezone.utc
STATE_KEYS = {
    "rm-demo-applications", "rm-demo-blocked-partner-mobiles",
    "rm-demo-distributor-pin-mappings", "rm-demo-distributor-notifications",
    "rm-demo-approvals",
    "rm-demo-retail-profiles", "rm-demo-master-contact",
    "rm-demo-upline-requests", "rm-demo-service-requests",
}
DOCUMENT_FIELDS = {
    "retailerIdentity": "Identity proof",
    "retailerAddressProof": "Address proof",
    "retailerBusinessProof": "Shop / business proof",
    "businessRegistration": "Business registration / GST proof",
    "bankProof": "Bank proof / cancelled cheque",
    "officeProof": "Office premises proof",
    "retailerKycMasked": "Masked Aadhaar / PAN copy",
    "distributorKyc": "Distributor KYC (masked Aadhaar / PAN)",
}
RETAILER_DOCUMENTS = (
    "retailerIdentity", "retailerAddressProof", "retailerBusinessProof", "retailerKycMasked",
)
DISTRIBUTOR_DOCUMENTS = (
    "retailerIdentity", "retailerAddressProof", "retailerBusinessProof",
    "businessRegistration", "bankProof", "officeProof", "distributorKyc",
)
STAFF_ROLES = {"master", "masteradmin", "subadmin"}
TWO_FACTOR_ROLES = {"masteradmin", "subadmin"}
# Every staff identity that must pass TOTP before a session is issued; the owner has no staff authorization row.
MFA_LOGIN_ROLES = {"master"} | TWO_FACTOR_ROLES
PREAUTH_LIFETIME_SECONDS = 300
TOTP_ISSUER = "R.M Digital Centre"
HELPLINE_KEY = "helpline"
SUPPORT_TICKETS_KEY = "rm-support-tickets"
KYC_RETENTION_DAYS = 7
PENDING_KYC_RETENTION_DAYS = 30
REVIEW_IN_PROGRESS_STATUSES = ("pending", "correction_required")
KYC_PURGE_STATUSES = {"approved", "rejected", "blocked"}
CSRF_COOKIE_NAME = "rm_csrf"
CSRF_EXEMPT_PATHS = {
    "/api/auth/login", "/api/auth/lookup", "/api/auth/setup", "/api/auth/bootstrap",
    "/api/auth/recover", "/api/retailer/activate", "/api/auth/staff-setup",
    "/api/auth/2fa/enroll-start", "/api/auth/2fa/enroll-verify", "/api/auth/2fa/verify",
    "/api/applications", "/api/service-enquiries", "/api/scan-document", "/api/public/assistant/chat",
}
APPLICATION_RATE_LIMIT = 10
APPLICATION_RATE_WINDOW = timedelta(hours=1)
_application_hits: dict[str, list[datetime]] = {}
STATIC_FILES = {
    "index.html", "login.html", "register.html", "admin.html", "retailer.html",
    "dashboard.html", "dashboard.css", "dashboard.js",
    "styles.css", "app.js", "home-services.js", "manifest.json", "sw.js", "icon.svg",
    "icon-192.png", "icon-512.png", "assistant.css", "public-assistant.js", "portal-assistant.js",
}
APPLICATIONS_KEY = "rm-demo-applications"
MASTER_ONLY_KEYS = STATE_KEYS - {
    "rm-demo-applications", "rm-demo-blocked-partner-mobiles",
    "rm-demo-distributor-notifications", "rm-demo-approvals",
}
COOKIE_SECURE = os.getenv("APP_ENV") == "production" or bool(os.getenv("RAILWAY_ENVIRONMENT"))
OCR_LOCK = threading.Lock()
_ocr_reader: Any = None


def positive_integer_setting(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer.") from error
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}.")
    return value


def utc_now() -> datetime:
    return datetime.now(UTC)


def get_database_url() -> str:
    value = os.getenv("DATABASE_URL", "sqlite:///./rm_digital_centre.db")
    if value.startswith("postgres://"):
        value = "postgresql+psycopg://" + value[len("postgres://"):]
    elif value.startswith("postgresql://"):
        value = "postgresql+psycopg://" + value[len("postgresql://"):]
    if os.getenv("RAILWAY_ENVIRONMENT") and not value.startswith("postgresql+psycopg://"):
        raise RuntimeError("Railway deployment requires a PostgreSQL DATABASE_URL.")
    return value


DB_URL = get_database_url()
if DB_URL.startswith("sqlite"):
    engine = create_engine(
        DB_URL, connect_args={"check_same_thread": False}, pool_pre_ping=True,
    )
else:
    engine = create_engine(
        DB_URL,
        pool_size=positive_integer_setting("DB_POOL_SIZE", 5, 1, 50),
        max_overflow=positive_integer_setting("DB_MAX_OVERFLOW", 5, 0, 100),
        pool_timeout=positive_integer_setting("DB_POOL_TIMEOUT_SECONDS", 30, 1, 300),
        pool_recycle=positive_integer_setting("DB_POOL_RECYCLE_SECONDS", 1800, 60, 86400),
        pool_pre_ping=True,
    )
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def document_storage_dir() -> Path:
    configured_path = os.getenv("UPLOAD_STORAGE_DIR")
    if os.getenv("RAILWAY_ENVIRONMENT"):
        if not configured_path:
            raise RuntimeError("Railway deployment requires UPLOAD_STORAGE_DIR on a persistent volume.")
        mount_path = Path(os.getenv("RAILWAY_VOLUME_MOUNT_PATH", "/data")).resolve()
        if not mount_path.is_mount():
            raise RuntimeError("The configured Railway upload mount is not mounted as a persistent volume.")
        storage_path = Path(configured_path).resolve()
        if storage_path != mount_path and mount_path not in storage_path.parents:
            raise RuntimeError("UPLOAD_STORAGE_DIR must be inside the Railway persistent volume mount.")
        return storage_path
    return resolve_writable_storage(Path(configured_path or BASE_DIR / "private_documents").resolve())


_STORAGE_FALLBACKS: dict[Path, Path] = {}


def resolve_writable_storage(preferred: Path) -> Path:
    """Use the configured folder, or a local fallback when the host denies access (e.g. /var/data on Render)."""
    if preferred in _STORAGE_FALLBACKS:
        return _STORAGE_FALLBACKS[preferred]
    try:
        preferred.mkdir(mode=0o700, parents=True, exist_ok=True)
        chosen = preferred
    except OSError:
        chosen = (BASE_DIR / "private_documents").resolve()
        LOGGER.warning(
            "Cannot create %s; using %s instead. Files there are lost on redeploy unless a persistent disk is attached.",
            preferred, chosen,
        )
    _STORAGE_FALLBACKS[preferred] = chosen
    return chosen


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    mobile: Mapped[str] = mapped_column(String(15), unique=True, index=True)
    retail_id: Mapped[str | None] = mapped_column(String(20), unique=True, nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(80))
    email: Mapped[str] = mapped_column(String(254), default="")
    role: Mapped[str] = mapped_column(String(20), index=True)
    password_hash: Mapped[str | None] = mapped_column(String(256), nullable=True)
    recovery_hash: Mapped[str | None] = mapped_column(String(256), nullable=True)
    setup_token_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    setup_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True)
    totp_secret: Mapped[str | None] = mapped_column(String(300), nullable=True)
    totp_enrolled: Mapped[bool] = mapped_column(default=False)
    totp_last_step: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class StaffAuthorization(Base):
    __tablename__ = "staff_authorizations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    role: Mapped[str] = mapped_column(String(20), index=True)
    name: Mapped[str] = mapped_column(String(80))
    mobile: Mapped[str] = mapped_column(String(15), unique=True, index=True)
    scope: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(40), index=True)
    created_by: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    setup_submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class SiteSetting(Base):
    __tablename__ = "site_settings"
    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str] = mapped_column(String(200), default="")
    updated_by: Mapped[str] = mapped_column(String(36), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class PortalRecord(Base):
    __tablename__ = "portal_records"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class Application(Base):
    __tablename__ = "applications"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    mobile: Mapped[str] = mapped_column(String(15), index=True)
    role: Mapped[str] = mapped_column(String(20), index=True)
    status: Mapped[str] = mapped_column(String(30), index=True)
    distributor_application_id: Mapped[str] = mapped_column(String(80), default="", index=True)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)


class CustomerDocument(Base):
    __tablename__ = "customer_documents"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    application_id: Mapped[str] = mapped_column(
        String(80), ForeignKey("applications.id", ondelete="CASCADE"), index=True,
    )
    revision: Mapped[int] = mapped_column(Integer, default=1)
    label: Mapped[str] = mapped_column(String(80))
    original_filename: Mapped[str] = mapped_column(String(180))
    content_type: Mapped[str] = mapped_column(String(40))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256_hex: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str] = mapped_column(String(80), unique=True)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_id: Mapped[str] = mapped_column(String(36), index=True)
    actor_role: Mapped[str] = mapped_column(String(20))
    action: Mapped[str] = mapped_column(String(40), index=True)
    target: Mapped[str] = mapped_column(String(80), index=True)
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class TransactionDocument(Base):
    __tablename__ = "transaction_documents"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    transaction_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("transactions.id", ondelete="CASCADE"), index=True,
    )
    label: Mapped[str] = mapped_column(String(80), default="Transaction attachment")
    original_filename: Mapped[str] = mapped_column(String(180))
    content_type: Mapped[str] = mapped_column(String(40))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256_hex: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str] = mapped_column(String(80), unique=True)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class PortalSession(Base):
    __tablename__ = "portal_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    failures: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TransactionRecord(Base):
    __tablename__ = "transactions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    reference: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    service: Mapped[str] = mapped_column(String(80))
    amount_paise: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="recorded", index=True)
    details: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AuthInput(InputModel):
    identifier: str = Field(min_length=4, max_length=20)
    password: str = Field(default="", min_length=0, max_length=128)
    recovery: str = Field(default="", min_length=0, max_length=256)
    activationToken: str = Field(default="", max_length=256)
    name: str = Field(default="", max_length=80)
    bootstrapToken: str = Field(default="", max_length=256)


class RecoveryInput(InputModel):
    identifier: str = Field(min_length=4, max_length=20)
    password: str = Field(min_length=12, max_length=128)
    recovery: str = Field(min_length=12, max_length=256)


class StaffSetupInput(InputModel):
    name: str = Field(min_length=2, max_length=80)
    mobile: str = Field(pattern=r"^\d{10}$")
    password: str = Field(min_length=12, max_length=128)
    recovery: str = Field(min_length=12, max_length=256)


class TwoFactorInput(InputModel):
    preAuth: str = Field(min_length=20, max_length=300)
    code: str = Field(default="", max_length=8)


class StaffAuthorizationInput(InputModel):
    role: str = Field(pattern=r"^(masteradmin|subadmin)$")
    name: str = Field(min_length=2, max_length=80)
    mobile: str = Field(pattern=r"^\d{10}$")
    scope: str = Field(min_length=2, max_length=120)


class StaffActionInput(InputModel):
    action: str = Field(pattern=r"^(approve|reject|revoke|reset)$")


class HelplineInput(InputModel):
    phone: str = Field(pattern=r"^\+?[0-9][0-9 \-]{6,18}[0-9]$")


class SupportTicketInput(InputModel):
    category: str = Field(pattern=r"^(complaint|support|service|other)$")
    subject: str = Field(min_length=3, max_length=100)
    message: str = Field(min_length=5, max_length=1000)

class StateInput(InputModel):
    value: list[dict[str, Any]]


class ApplicationInput(InputModel):
    name: str = Field(min_length=2, max_length=80)
    mobile: str = Field(pattern=r"^\d{10}$")
    business: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    address: str = Field(min_length=5, max_length=200)
    city: str = Field(min_length=2, max_length=80)
    role: str = Field(pattern=r"^(retailer|distributor)$")
    operationalPin: str = Field(default="", pattern=r"^$|^\d{6}$")
    servicePincodes: list[str] = Field(default_factory=list, max_length=100)
    correctionReference: str = Field(default="", max_length=80)
    idType: str = Field(default="", pattern=r"^(aadhaar|pan)?$")
    idLast4: str = Field(default="", pattern=r"^[A-Za-z0-9]{0,4}$")
    jurisdiction: str = Field(default="", max_length=120)
    referralCode: str = Field(default="", max_length=40)
    mobileConfirmed: bool = False
    privacyAccepted: bool = False
    website: str = Field(default="", max_length=200)
    @classmethod
    def normalize_required_text(cls, value: str, info: ValidationInfo) -> str:
        normalized = value.strip()
        minimum_lengths = {"name": 2, "business": 2, "address": 5, "city": 2}
        field_name = info.field_name
        if field_name is None:
            raise ValueError("Required text field is invalid.")
        if len(normalized) < minimum_lengths[field_name]:
            raise ValueError(
                f"{field_name.title()} must contain at least "
                f"{minimum_lengths[field_name]} characters."
            )
        return normalized

    @field_validator("servicePincodes")
    @classmethod
    def check_pincodes(cls, pins: list[str]) -> list[str]:
        if any(not p.isdigit() or len(p) != 6 for p in pins) or len(set(pins)) != len(pins):
            raise ValueError("Service PIN codes must be unique six-digit values.")
        return pins

    @field_validator("email")
    @classmethod
    def valid_email(cls, email: str) -> str:
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email.strip()):
            raise ValueError("Enter a valid email address.")
        return email.strip().lower()


class TransactionInput(InputModel):
    reference: str = Field(min_length=4, max_length=80)
    service: str = Field(min_length=2, max_length=80)
    amountPaise: int = Field(ge=0, le=100_000_000)
    details: dict[str, Any] = Field(default_factory=dict)


class UplineRequestInput(InputModel):
    reason: str = Field(default="", max_length=1000)


class PartnerActionInput(InputModel):
    action: str = Field(pattern=r"^(approve|reject|suspend|reactivate)$")
    reason: str = Field(default="", max_length=500)


class ReassignInput(InputModel):
    distributorApplicationId: str = Field(default="", max_length=80)


def get_db():
    with SessionLocal() as db:
        yield db


def document_public_data(document: CustomerDocument | TransactionDocument) -> dict[str, Any]:
    result = {
        "id": document.id,
        "label": document.label,
        "fileName": document.original_filename,
        "size": document.size_bytes,
        "type": document.content_type,
        "uploadedAt": document.uploaded_at.isoformat(),
    }
    if isinstance(document, CustomerDocument):
        result["revision"] = document.revision
        result["purgedAt"] = document.purged_at.isoformat() if document.purged_at else None
    return result


def sanitize_filename(filename: str) -> str:
    basename = Path(filename.replace("\\", "/")).name.strip()
    cleaned = re.sub(r"[^A-Za-z0-9._() -]", "_", basename).strip(" .")
    return cleaned[:180] or "customer-document"


async def read_validated_document(upload: UploadFile) -> tuple[bytes, str, str]:
    filename = sanitize_filename(upload.filename or "")
    suffix = Path(filename).suffix.lower()
    contents = await upload.read(MAX_DOCUMENT_BYTES + 1)
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded documents cannot be empty.")
    if len(contents) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="Each document must be 10 MB or smaller.")
    if suffix == ".pdf" and contents.startswith(b"%PDF-") and b"%%EOF" in contents[-1024:]:
        return contents, "application/pdf", filename
    if suffix in {".jpg", ".jpeg", ".png"}:
        try:
            from PIL import Image, UnidentifiedImageError
            with Image.open(BytesIO(contents)) as image:
                expected_format = "PNG" if suffix == ".png" else "JPEG"
                if image.format != expected_format:
                    raise HTTPException(status_code=415, detail="A document's contents do not match its image file type.")
                width, height = image.size
                if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
                    raise HTTPException(status_code=413, detail="Document image dimensions exceed the allowed limit.")
                image.verify()
        except HTTPException:
            raise
        except (UnidentifiedImageError, OSError) as error:
            raise HTTPException(status_code=400, detail="An uploaded image is invalid or unreadable.") from error
        content_type = "image/png" if suffix == ".png" else "image/jpeg"
        return contents, content_type, filename
    raise HTTPException(status_code=415, detail="Upload documents only as PDF, JPG, JPEG or PNG.")


def document_fernet() -> Fernet:
    secret = os.getenv("DOCUMENT_ENCRYPTION_KEY", "")
    if not secret:
        raise RuntimeError("DOCUMENT_ENCRYPTION_KEY must be configured before storing customer documents.")
    try:
        return Fernet(secret.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as error:
        raise RuntimeError("DOCUMENT_ENCRYPTION_KEY must be a valid Fernet key.") from error


def persist_document(storage_dir: Path, contents: bytes, fernet: Fernet) -> tuple[str, Path]:
    storage_key = uuid4().hex + ".enc"
    destination = storage_dir / storage_key
    encrypted = fernet.encrypt(contents)
    with destination.open("xb") as stored_file:
        stored_file.write(encrypted)
    if system() != "Windows":
        destination.chmod(0o600)
    return storage_key, destination


def record_value(db: Session, key: str) -> list[dict[str, Any]]:
    row = db.get(PortalRecord, key)
    if row:
        return row.value
    if key == "rm-demo-master-contact":
        return []
    return []


def save_record(db: Session, key: str, value: list[dict[str, Any]]) -> None:
    row = db.get(PortalRecord, key)
    if row is None:
        db.add(PortalRecord(key=key, value=value, updated_at=utc_now()))
    else:
        row.value = value
        row.updated_at = utc_now()


PASSWORD_HASHER = PasswordHasher()


def hash_secret(secret: str) -> str:
    return PASSWORD_HASHER.hash(secret)


DUMMY_PASSWORD_HASH = hash_secret("Not-a-real-password-123!")


def verify_secret(secret: str, encoded: str | None) -> bool:
    if not encoded:
        return False
    if encoded.startswith("$argon2"):
        try:
            return PASSWORD_HASHER.verify(encoded, secret)
        except (VerificationError, InvalidHashError):
            return False
    try:
        # Legacy scrypt hashes remain verifiable so they can be upgraded on next sign-in.
        algorithm, n, r, p, salt, expected = encoded.split("$")
        if algorithm != "scrypt":
            return False
        actual = scrypt(
            secret.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p),
            dklen=len(bytes.fromhex(expected)), maxmem=64 * 1024 * 1024,
        )
        return compare_digest(actual.hex(), expected)
    except (ValueError, TypeError):
        return False


def upgrade_hash_if_needed(user: User, secret: str) -> None:
    if user.password_hash and (
        not user.password_hash.startswith("$argon2") or PASSWORD_HASHER.check_needs_rehash(user.password_hash)
    ):
        user.password_hash = hash_secret(secret)


def issue_setup_token(user: User) -> str | None:
    expires = user.setup_token_expires_at
    if expires and expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    if user.password_hash or (user.setup_token_hash and expires and expires > utc_now()):
        return None
    raw_token = secrets.token_urlsafe(32)
    user.setup_token_hash = sha256(raw_token.encode()).hexdigest()
    user.setup_token_expires_at = utc_now() + timedelta(days=7)
    return raw_token


def consume_setup_token(user: User, token: str) -> None:
    expires = user.setup_token_expires_at
    if expires and expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    supplied = sha256(token.encode()).hexdigest() if token else ""
    if (
        not token or not user.setup_token_hash
        or not compare_digest(supplied, user.setup_token_hash)
        or not expires or expires <= utc_now()
    ):
        raise HTTPException(status_code=403, detail="A valid one-time setup code is required.")
    user.setup_token_hash = None
    user.setup_token_expires_at = None


def password_policy(password: str) -> None:
    if not 12 <= len(password) <= 128:
        raise HTTPException(status_code=422, detail="Password must be between 12 and 128 characters.")
    if not (
        any(c.islower() for c in password) and any(c.isupper() for c in password)
        and any(c.isdigit() for c in password) and any(not c.isalnum() for c in password)
    ):
        raise HTTPException(status_code=422, detail="Use upper/lowercase letters, a number, and a symbol.")


PENDING_APPLICATION_MESSAGE = (
    "Aapka application abhi review ya pending mein hai. Approval ke baad hi aap login kar payenge."
)


def normalized_identifier(identifier: str) -> str:
    value = identifier.strip()
    return value.upper() if any(character.isalpha() for character in value) else value


def session_user_data(user: User) -> dict[str, str]:
    return {
        "id": user.id, "name": user.name, "mobile": user.mobile, "email": user.email,
        "role": user.role, "userId": user.retail_id or "",
    }


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    raw = request.cookies.get(COOKIE_NAME)
    if not raw:
        raise HTTPException(status_code=401, detail="Sign in is required.")
    token_hash = sha256(raw.encode()).hexdigest()
    portal_session = db.get(PortalSession, token_hash)
    expires_at = portal_session.expires_at if portal_session else None
    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if not portal_session or expires_at <= utc_now():
        if portal_session:
            db.delete(portal_session)
            db.commit()
        raise HTTPException(status_code=401, detail="Your session has expired. Sign in again.")
    user = db.get(User, portal_session.user_id)
    if not user or not user.is_active:
        db.delete(portal_session)
        db.commit()
        raise HTTPException(status_code=401, detail="This account is not active.")
    return user


def role_required(*roles: str):
    def dependency(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="You do not have permission for this operation.")
        return user
    return dependency


def csrf_secret() -> bytes:
    return (os.getenv("CSRF_SECRET") or os.getenv("DOCUMENT_ENCRYPTION_KEY", "")).encode()


def csrf_token_for(raw_session: str) -> str:
    return hmac_new(csrf_secret(), b"csrf|" + raw_session.encode(), sha256).hexdigest()


def create_session(db: Session, response: Response, user: User) -> None:
    raw = secrets.token_urlsafe(48)
    # Single-session enforcement: signing in revokes every earlier session.
    db.query(PortalSession).filter(PortalSession.user_id == user.id).delete()
    db.add(PortalSession(
        token_hash=sha256(raw.encode()).hexdigest(),
        user_id=user.id,
        expires_at=utc_now() + SESSION_LIFETIME,
    ))
    db.commit()
    max_age = int(SESSION_LIFETIME.total_seconds())
    response.set_cookie(
        COOKIE_NAME, raw, httponly=True, secure=COOKIE_SECURE, samesite="strict",
        max_age=max_age, path="/",
    )
    response.set_cookie(
        CSRF_COOKIE_NAME, csrf_token_for(raw), httponly=False, secure=COOKIE_SECURE,
        samesite="strict", max_age=max_age, path="/",
    )


def record_audit(db: Session, actor: User, action: str, target: str, detail: dict[str, Any] | None = None) -> None:
    db.add(AuditLog(
        actor_id=actor.id, actor_role=actor.role, action=action, target=target[:80],
        detail=detail or {}, created_at=utc_now(),
    ))


def ensure_schema_columns() -> None:
    columns = {column["name"] for column in inspect(engine).get_columns("customer_documents")}
    if "purged_at" not in columns:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE customer_documents ADD COLUMN purged_at TIMESTAMP"))
    user_columns = {column["name"] for column in inspect(engine).get_columns("users")}
    additions = {
        "totp_secret": "VARCHAR(300)",
        "totp_enrolled": "BOOLEAN NOT NULL DEFAULT FALSE",
        "totp_last_step": "INTEGER NOT NULL DEFAULT 0",
    }
    with engine.begin() as connection:
        for name, definition in additions.items():
            if name not in user_columns:
                connection.execute(text(f"ALTER TABLE users ADD COLUMN {name} {definition}"))


def make_preauth_token(user: User) -> str:
    expires = int(utc_now().timestamp()) + PREAUTH_LIFETIME_SECONDS
    fingerprint = sha256((user.password_hash or "").encode()).hexdigest()[:16]
    payload = f"{user.id}.{expires}"
    signature = hmac_new(csrf_secret(), f"preauth|{payload}|{fingerprint}".encode(), sha256).hexdigest()
    return f"{payload}.{signature}"


def user_from_preauth(db: Session, token: str) -> User:
    invalid = HTTPException(status_code=401, detail="Sign in again to continue.")
    try:
        user_id, expires, signature = token.split(".")
        if int(expires) < utc_now().timestamp():
            raise invalid
    except ValueError as error:
        raise invalid from error
    user = db.get(User, user_id)
    if not user or not user.is_active or user.role not in MFA_LOGIN_ROLES:
        raise invalid
    fingerprint = sha256((user.password_hash or "").encode()).hexdigest()[:16]
    expected = hmac_new(csrf_secret(), f"preauth|{user_id}.{expires}|{fingerprint}".encode(), sha256).hexdigest()
    if not compare_digest(signature, expected):
        raise invalid
    return user


def staff_authorization_for(db: Session, user: User) -> StaffAuthorization | None:
    return db.scalar(select(StaffAuthorization).where(StaffAuthorization.mobile == user.mobile))


def totp_for(user: User) -> pyotp.TOTP:
    secret = document_fernet().decrypt((user.totp_secret or "").encode()).decode()
    return pyotp.TOTP(secret)


def check_totp(user: User, code: str) -> bool:
    """Accept a code once per 30-second step (replay protection)."""
    if not re.fullmatch(r"\d{6}", code or "") or not user.totp_secret:
        return False
    try:
        totp = totp_for(user)
    except InvalidToken:
        return False
    now = utc_now().timestamp()
    for offset in (-1, 0, 1):
        step = int(now // 30) + offset
        if compare_digest(totp.at(step * 30), code):
            if step <= user.totp_last_step:
                return False
            user.totp_last_step = step
            return True
    return False


def qr_data_uri(content: str) -> str:
    image = qrcode.make(content)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def get_helpline(db: Session) -> str:
    row = db.get(SiteSetting, HELPLINE_KEY)
    return row.value if row else ""


def purge_customer_documents(db: Session, documents: list[CustomerDocument]) -> int:
    """Delete stored KYC files, keeping only audit metadata (hash, size, timestamps)."""
    storage_dir = document_storage_dir()
    now = utc_now()
    purged: dict[str, set[str]] = {}
    for document in documents:
        if document.purged_at:
            continue
        (storage_dir / document.storage_key).unlink(missing_ok=True)
        document.purged_at = now
        document.original_filename = "[purged]"
        purged.setdefault(document.application_id, set()).add(document.id)
    for application_id, document_ids in purged.items():
        row = db.get(Application, application_id)
        if not row:
            continue
        payload = json.loads(json.dumps(row.payload))
        entries = list(payload.get("documents", []))
        for revision in payload.get("revisionHistory", []):
            entries.extend(revision.get("documents", []))
        for entry in entries:
            if entry.get("id") in document_ids:
                entry["fileName"] = "[purged]"
                entry["purgedAt"] = now.isoformat()
        row.payload = payload
    return sum(len(ids) for ids in purged.values())


def purge_application_documents(db: Session, application_id: str) -> int:
    documents = list(db.scalars(select(CustomerDocument).where(
        CustomerDocument.application_id == application_id, CustomerDocument.purged_at.is_(None),
    )))
    return purge_customer_documents(db, documents)


def run_document_purge() -> int:
    retention = positive_integer_setting("KYC_RETENTION_DAYS", KYC_RETENTION_DAYS, 1, KYC_RETENTION_DAYS)
    pending_retention = positive_integer_setting(
        "KYC_PENDING_RETENTION_DAYS", PENDING_KYC_RETENTION_DAYS, retention, 90)
    now = utc_now()
    with SessionLocal() as db:
        # Documents under active review are kept longer so they are not deleted before a decision is made.
        expired = list(db.scalars(
            select(CustomerDocument).join(Application, Application.id == CustomerDocument.application_id).where(
                CustomerDocument.purged_at.is_(None),
                (
                    (CustomerDocument.uploaded_at < now - timedelta(days=retention))
                    & Application.status.not_in(REVIEW_IN_PROGRESS_STATUSES)
                ) | (CustomerDocument.uploaded_at < now - timedelta(days=pending_retention)),
            )))
        count = purge_customer_documents(db, expired)
        db.commit()
    if count:
        LOGGER.info("Purged %d expired KYC document(s)", count)
    return count


async def document_purge_loop() -> None:
    interval = positive_integer_setting("KYC_PURGE_INTERVAL_SECONDS", 3600, 60, 86400)
    while True:
        try:
            await run_in_threadpool(run_document_purge)
        except Exception:
            LOGGER.exception("Scheduled KYC document purge failed")
        await asyncio.sleep(interval)


def check_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        raise HTTPException(status_code=403, detail="A same-origin request is required.")
    parsed = urlparse(origin)
    forwarded_scheme = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    if parsed.hostname != request.url.hostname or parsed.port != request.url.port:
        raise HTTPException(status_code=403, detail="Cross-origin requests are not allowed.")
    if parsed.scheme not in {"http", "https"} or (forwarded_scheme == "https" and parsed.scheme != "https"):
        raise HTTPException(status_code=403, detail="Cross-origin requests are not allowed.")


def throttle_key(request: Request, scope: str, identifier: str) -> str:
    remote = request.client.host if request.client else "unknown"
    return sha256(f"{scope}|{remote}|{identifier.casefold()}".encode()).hexdigest()


def throttle_check(db: Session, key: str) -> None:
    attempt = db.get(LoginAttempt, key)
    locked_until = attempt.locked_until if attempt else None
    if locked_until and locked_until.tzinfo is None:
        locked_until = locked_until.replace(tzinfo=UTC)
    if locked_until and locked_until > utc_now():
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")


def throttle_fail(db: Session, key: str) -> None:
    attempt = db.get(LoginAttempt, key)
    if attempt is None:
        attempt = LoginAttempt(key=key, failures=0)
        db.add(attempt)
    attempt.failures += 1
    if attempt.failures >= LOGIN_FAILURE_LIMIT:
        attempt.failures = 0
        attempt.locked_until = utc_now() + LOGIN_LOCK_TIME
    db.commit()


def throttle_clear(db: Session, key: str) -> None:
    attempt = db.get(LoginAttempt, key)
    if attempt:
        db.delete(attempt)
        db.commit()


def application_values(db: Session) -> list[dict[str, Any]]:
    rows = db.scalars(select(Application).order_by(Application.submitted_at.desc()))
    return [dict(row.payload) for row in rows]


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncGenerator[None, None]:
    document_fernet()
    storage_dir = document_storage_dir()
    storage_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if system() != "Windows":
        try:
            storage_dir.chmod(0o700)
        except OSError:
            LOGGER.warning("Could not restrict permissions on %s", storage_dir)
    Base.metadata.create_all(engine)
    ensure_schema_columns()
    with SessionLocal() as db:
        db.execute(select(1))
    purge_task = asyncio.create_task(document_purge_loop())
    yield
    purge_task.cancel()
    with suppress(asyncio.CancelledError):
        await purge_task
    engine.dispose()


app = FastAPI(title="R.M Digital Centre Portal API", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        try:
            check_origin(request)
        except HTTPException as error:
            return JSONResponse(status_code=error.status_code, content={"detail": error.detail})
        session_cookie = request.cookies.get(COOKIE_NAME)
        if session_cookie and request.url.path not in CSRF_EXEMPT_PATHS:
            supplied = request.headers.get("x-csrf-token", "")
            if not compare_digest(supplied, csrf_token_for(session_cookie)):
                return JSONResponse(status_code=403, content={"detail": "A valid CSRF token is required."})
    if request.url.path in {"/api/applications", "/api/transactions"}:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > MAX_TOTAL_DOCUMENT_BYTES + 1024 * 1024:
                    return JSONResponse(status_code=413, content={"detail": "Uploads exceed the 41 MB request limit."})
            except ValueError:
                return JSONResponse(status_code=400, content={"detail": "The request Content-Length is invalid."})
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers.setdefault("Content-Security-Policy", (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
        "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    ))
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    if COOKIE_SECURE:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response


@app.get("/api/health")
def health(db: Session = Depends(get_db)) -> dict[str, str]:
    db.execute(select(1))
    return {"status": "ok", "database": "connected"}


@app.get("/api/public/config")
def public_config() -> dict[str, str]:
    return {"portalName": "R.M Digital Centre - Partner Portal"}


@app.get("/api/auth/me")
def auth_me(user: User = Depends(current_user)) -> dict[str, Any]:
    return {"authenticated": True, "user": session_user_data(user)}


@app.post("/api/auth/lookup")
def auth_lookup(body: AuthInput, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Stealth lookup: every unknown or non-actionable identifier gets the same generic password step."""
    identifier = normalized_identifier(body.identifier)
    key = throttle_key(request, "lookup", identifier)
    throttle_check(db, key)
    throttle_fail(db, key)
    generic = {"step": "password", "identifier": identifier}
    user = db.scalar(select(User).where((User.mobile == identifier) | (User.retail_id == identifier)))
    if user is None and identifier == MASTER_ADMIN_MOBILE and not db.scalar(select(User).where(User.role == "master")):
        return {"step": "bootstrap", "identifier": identifier}
    if user is None:
        pending = db.scalar(select(StaffAuthorization).where(
            StaffAuthorization.mobile == identifier,
            StaffAuthorization.status == "whitelisted_pending_setup",
        ))
        if pending and body.name.strip() and body.name.strip().casefold() == pending.name.strip().casefold():
            return {"step": "staff_setup", "identifier": identifier}
        waiting = db.scalar(select(Application).where(
            (Application.mobile == identifier) | (Application.id == identifier),
            Application.status == "pending",
        ))
        if waiting:
            return {"step": "pending", "identifier": identifier, "message": PENDING_APPLICATION_MESSAGE}
        return generic
    if user.role == "retailer" and user.is_active and user.password_hash is None:
        return {"step": "activate", "identifier": identifier}
    if user.role == "distributor" and user.is_active and user.password_hash is None:
        return {"step": "setup", "identifier": identifier}
    if user.role in TWO_FACTOR_ROLES and user.password_hash is None:
        authorization = staff_authorization_for(db, user)
        if (
            authorization and authorization.status == "whitelisted_pending_setup"
            and body.name.strip().casefold() == authorization.name.strip().casefold()
        ):
            return {"step": "staff_setup", "identifier": identifier}
    return generic


@app.post("/api/auth/bootstrap")
def bootstrap_master(
    body: AuthInput, response: Response, db: Session = Depends(get_db),
) -> dict[str, Any]:
    bootstrap_token = os.getenv("RM_MASTER_BOOTSTRAP_TOKEN", "")
    if not bootstrap_token:
        raise HTTPException(status_code=503, detail="Master setup is disabled. Configure RM_MASTER_BOOTSTRAP_TOKEN.")
    if len(bootstrap_token) < 32:
        raise HTTPException(status_code=503, detail="RM_MASTER_BOOTSTRAP_TOKEN must be at least 32 characters.")
    if not compare_digest(body.bootstrapToken, bootstrap_token):
        raise HTTPException(status_code=403, detail="The one-time setup token is incorrect.")
    if normalized_identifier(body.identifier) != MASTER_ADMIN_MOBILE:
        raise HTTPException(status_code=403, detail="Master Admin identity does not match server configuration.")
    password_policy(body.password)
    user = db.scalar(select(User).where(User.role == "master"))
    if user and user.password_hash:
        raise HTTPException(status_code=409, detail="Master Admin setup has already been completed.")
    if user is None:
        user = User(mobile=MASTER_ADMIN_MOBILE, name="Master Admin", role="master")
        db.add(user)
    user.password_hash = hash_secret(body.password)
    user.recovery_hash = hash_secret(body.recovery) if len(body.recovery) >= 12 else None
    user.updated_at = utc_now()
    db.commit()
    db.refresh(user)
    # No session yet: the owner must enroll the authenticator first.
    return {"twoFactor": "enroll", "preAuth": make_preauth_token(user)}


@app.post("/api/auth/setup")
def setup_account(
    body: AuthInput, request: Request, response: Response, db: Session = Depends(get_db),
) -> dict[str, Any]:
    identifier = normalized_identifier(body.identifier)
    setup_key = throttle_key(request, "setup", identifier)
    throttle_check(db, setup_key)
    user = db.scalar(select(User).where((User.mobile == identifier) | (User.retail_id == identifier)))
    if not user or not user.is_active or user.password_hash:
        raise HTTPException(status_code=409, detail="This account is not eligible for first-time password setup.")
    if user.role in {"master"} | TWO_FACTOR_ROLES:
        raise HTTPException(status_code=403, detail="Use the owner-controlled staff setup flow.")
    password_policy(body.password)
    try:
        consume_setup_token(user, body.activationToken)
    except HTTPException:
        throttle_fail(db, setup_key)
        raise
    throttle_clear(db, setup_key)
    user.password_hash = hash_secret(body.password)
    user.recovery_hash = hash_secret(body.recovery) if len(body.recovery) >= 12 else None
    user.updated_at = utc_now()
    db.commit()
    create_session(db, response, user)
    return {"user": session_user_data(user)}


@app.post("/api/auth/login")
def login(
    body: AuthInput, request: Request, response: Response, db: Session = Depends(get_db),
) -> dict[str, Any]:
    identifier = normalized_identifier(body.identifier)
    remote = request.client.host if request.client else "unknown"
    attempt_key = sha256((remote + "|" + identifier.casefold()).encode()).hexdigest()
    attempt = db.get(LoginAttempt, attempt_key)
    now = utc_now()
    locked_until = attempt.locked_until if attempt else None
    if locked_until and locked_until.tzinfo is None:
        locked_until = locked_until.replace(tzinfo=UTC)
    if locked_until and locked_until > now:
        raise HTTPException(status_code=429, detail="Too many sign-in attempts. Try again later.")
    user = db.scalar(select(User).where((User.mobile == identifier) | (User.retail_id == identifier)))
    if user and user.role in TWO_FACTOR_ROLES:
        authorization = staff_authorization_for(db, user)
        if not authorization or authorization.status not in {"ready_for_2fa", "active"}:
            user = None
    valid = verify_secret(body.password, user.password_hash if user else DUMMY_PASSWORD_HASH)
    if not user or not user.is_active or not user.password_hash or not valid:
        if attempt is None:
            attempt = LoginAttempt(key=attempt_key, failures=0)
            db.add(attempt)
        attempt.failures += 1
        if attempt.failures >= LOGIN_FAILURE_LIMIT:
            attempt.failures = 0
            attempt.locked_until = now + LOGIN_LOCK_TIME
        db.commit()
        # Pending status is revealed only to someone who knows both the application reference and its mobile.
        if not user and body.name.strip():
            application = db.get(Application, identifier[:80])
            if (
                application and application.status == "pending"
                and compare_digest(application.mobile.encode(), body.name.strip().encode())
            ):
                raise HTTPException(status_code=403, detail="Aapki application abhi admin review mein hai.")
        raise HTTPException(status_code=401, detail="Invalid credentials or mobile number.")
    if attempt:
        db.delete(attempt)
    upgrade_hash_if_needed(user, body.password)
    db.commit()
    if user.role in MFA_LOGIN_ROLES:
        return {
            "twoFactor": "verify" if user.totp_enrolled else "enroll",
            "preAuth": make_preauth_token(user),
        }
    create_session(db, response, user)
    return {"user": session_user_data(user)}


def finish_two_factor(db: Session, response: Response, user: User) -> dict[str, Any]:
    authorization = staff_authorization_for(db, user)
    if authorization and authorization.status != "active":
        authorization.status = "active"
        authorization.updated_at = utc_now()
    user.updated_at = utc_now()
    db.commit()
    create_session(db, response, user)
    return {"user": session_user_data(user)}


def two_factor_throttle(request: Request, db: Session, user: User) -> str:
    key = throttle_key(request, "2fa", user.id)
    throttle_check(db, key)
    return key


def two_factor_stage_allowed(db: Session, user: User, stage: str) -> bool:
    """Staff need an owner authorization state; the owner only needs to be enrolled (or not yet)."""
    if user.role == "master":
        return user.totp_enrolled if stage == "verify" else not user.totp_enrolled
    authorization = staff_authorization_for(db, user)
    required = "active" if stage == "verify" else "ready_for_2fa"
    if stage == "verify":
        return bool(user.totp_enrolled and authorization and authorization.status == required)
    return bool(not user.totp_enrolled and authorization and authorization.status == required)


@app.post("/api/auth/2fa/enroll-start")
def two_factor_enroll_start(
    body: TwoFactorInput, request: Request, db: Session = Depends(get_db),
) -> dict[str, str]:
    user = user_from_preauth(db, body.preAuth)
    two_factor_throttle(request, db, user)
    if not two_factor_stage_allowed(db, user, "enroll"):
        raise HTTPException(status_code=409, detail="Authenticator setup is locked for this account.")
    secret = pyotp.random_base32()
    user.totp_secret = document_fernet().encrypt(secret.encode()).decode()
    user.totp_last_step = 0
    db.commit()
    uri = pyotp.TOTP(secret).provisioning_uri(name=user.mobile, issuer_name=TOTP_ISSUER)
    return {"qr": qr_data_uri(uri), "manualKey": secret}


@app.post("/api/auth/2fa/enroll-verify")
def two_factor_enroll_verify(
    body: TwoFactorInput, request: Request, response: Response, db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = user_from_preauth(db, body.preAuth)
    key = two_factor_throttle(request, db, user)
    if not two_factor_stage_allowed(db, user, "enroll") or not user.totp_secret:
        raise HTTPException(status_code=409, detail="Authenticator setup is locked for this account.")
    if not check_totp(user, body.code):
        db.rollback()
        throttle_fail(db, key)
        raise HTTPException(status_code=401, detail="The verification code is incorrect or expired.")
    user.totp_enrolled = True
    throttle_clear(db, key)
    return finish_two_factor(db, response, user)


@app.post("/api/auth/2fa/verify")
def two_factor_verify(
    body: TwoFactorInput, request: Request, response: Response, db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = user_from_preauth(db, body.preAuth)
    key = two_factor_throttle(request, db, user)
    if not two_factor_stage_allowed(db, user, "verify"):
        raise HTTPException(status_code=409, detail="Authenticator verification is not available.")
    if not check_totp(user, body.code):
        db.rollback()
        throttle_fail(db, key)
        raise HTTPException(status_code=401, detail="The verification code is incorrect or expired.")
    throttle_clear(db, key)
    return finish_two_factor(db, response, user)


@app.post("/api/auth/recover")
def recover_password(body: RecoveryInput, request: Request, db: Session = Depends(get_db)) -> dict[str, str]:
    identifier = normalized_identifier(body.identifier)
    key = throttle_key(request, "recover", identifier)
    throttle_check(db, key)
    user = db.scalar(select(User).where((User.mobile == identifier) | (User.retail_id == identifier)))
    valid = verify_secret(body.recovery, user.recovery_hash if user and user.recovery_hash else DUMMY_PASSWORD_HASH)
    if not user or not user.recovery_hash or not user.is_active or not valid:
        throttle_fail(db, key)
        raise HTTPException(status_code=401, detail="Account details or recovery phrase are incorrect.")
    throttle_clear(db, key)
    password_policy(body.password)
    user.password_hash = hash_secret(body.password)
    user.updated_at = utc_now()
    db.query(PortalSession).filter(PortalSession.user_id == user.id).delete()
    db.commit()
    return {"status": "password_updated"}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, str]:
    raw = request.cookies.get(COOKIE_NAME)
    if raw:
        token_hash = sha256(raw.encode()).hexdigest()
        session = db.get(PortalSession, token_hash)
        if session:
            db.delete(session)
            db.commit()
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, secure=COOKIE_SECURE, samesite="strict")
    response.delete_cookie(CSRF_COOKIE_NAME, path="/", secure=COOKIE_SECURE, samesite="strict")
    return {"status": "signed_out"}


@app.post("/api/auth/verify-password")
def verify_current_password(
    body: AuthInput, user: User = Depends(current_user),
) -> dict[str, bool]:
    if not verify_secret(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Password verification failed.")
    return {"valid": True}


@app.post("/api/admin/accounts/{identifier}/setup-code")
def issue_account_setup_code(
    identifier: str,
    _: User = Depends(role_required("master")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    normalized = normalized_identifier(identifier)
    user = db.scalar(select(User).where((User.mobile == normalized) | (User.retail_id == normalized)))
    if not user or not user.is_active or user.password_hash:
        raise HTTPException(status_code=409, detail="This account is not awaiting first-time setup.")
    user.setup_token_hash = None
    user.setup_token_expires_at = None
    code = issue_setup_token(user)
    db.commit()
    if not code:
        raise HTTPException(status_code=500, detail="A new setup code could not be generated.")
    return {
        "identifier": user.retail_id or user.mobile,
        "mobile": user.mobile,
        "code": code,
        "expiresInHours": 168,
    }


@app.post("/api/admin/accounts/{identifier}/reset")
def reset_account_password(
    identifier: str,
    _: User = Depends(role_required("master")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    normalized = normalized_identifier(identifier)
    user = db.scalar(select(User).where((User.mobile == normalized) | (User.retail_id == normalized)))
    if not user or user.role not in {"distributor", "retailer"} or not user.is_active:
        raise HTTPException(status_code=404, detail="An active partner account was not found.")
    user.password_hash = None
    user.recovery_hash = None
    user.setup_token_hash = None
    user.setup_token_expires_at = None
    db.query(PortalSession).filter(PortalSession.user_id == user.id).delete()
    code = issue_setup_token(user)
    db.commit()
    if not code:
        raise HTTPException(status_code=500, detail="The password reset code could not be generated.")
    return {"identifier": user.mobile, "code": code, "expiresInHours": 168}


@app.post("/api/auth/staff-setup")
def staff_setup(body: StaffSetupInput, request: Request, db: Session = Depends(get_db)) -> dict[str, str]:
    key = throttle_key(request, "staff-setup", body.mobile)
    throttle_check(db, key)
    authorization = db.scalar(select(StaffAuthorization).where(
        StaffAuthorization.mobile == body.mobile,
        StaffAuthorization.status == "whitelisted_pending_setup",
    ))
    if not authorization or authorization.name.strip().casefold() != body.name.strip().casefold():
        throttle_fail(db, key)
        raise HTTPException(status_code=403, detail="These details could not be verified.")
    password_policy(body.password)
    user = db.scalar(select(User).where(User.mobile == body.mobile))
    if user and user.role != authorization.role:
        raise HTTPException(status_code=409, detail="These details could not be verified.")
    if user is None:
        user = User(mobile=body.mobile, name=authorization.name, role=authorization.role)
        db.add(user)
    user.password_hash = hash_secret(body.password)
    user.recovery_hash = hash_secret(body.recovery)
    user.is_active = False
    user.totp_secret, user.totp_enrolled, user.totp_last_step = None, False, 0
    user.updated_at = utc_now()
    authorization.status = "pending_owner_final_approval"
    authorization.setup_submitted_at = utc_now()
    authorization.updated_at = utc_now()
    db.commit()
    throttle_clear(db, key)
    return {"status": "pending_owner_final_approval"}


def staff_data(item: StaffAuthorization) -> dict[str, Any]:
    return {
        "id": item.id, "role": item.role, "name": item.name, "mobile": item.mobile,
        "scope": item.scope, "status": item.status,
        "createdAt": item.created_at.isoformat(),
        "setupSubmittedAt": item.setup_submitted_at.isoformat() if item.setup_submitted_at else "",
        "approvedAt": item.approved_at.isoformat() if item.approved_at else "",
    }


@app.get("/api/owner/staff")
def owner_list_staff(
    _: User = Depends(role_required("master")), db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = db.scalars(select(StaffAuthorization).order_by(StaffAuthorization.created_at.desc()))
    return [staff_data(item) for item in rows]


@app.post("/api/owner/staff")
def owner_preauthorize_staff(
    body: StaffAuthorizationInput,
    owner: User = Depends(role_required("master")), db: Session = Depends(get_db),
) -> dict[str, Any]:
    if body.mobile == MASTER_ADMIN_MOBILE or db.scalar(select(User).where(User.mobile == body.mobile)):
        raise HTTPException(status_code=409, detail="This mobile number is already assigned to an account.")
    if db.scalar(select(StaffAuthorization).where(StaffAuthorization.mobile == body.mobile)):
        raise HTTPException(status_code=409, detail="This mobile number is already pre-authorized.")
    item = StaffAuthorization(
        role=body.role, name=" ".join(body.name.split()), mobile=body.mobile,
        scope=" ".join(body.scope.split()), status="whitelisted_pending_setup", created_by=owner.id,
    )
    db.add(item)
    record_audit(db, owner, "staff_preauthorize", body.mobile[-4:], {"role": body.role})
    db.commit()
    return staff_data(item)


@app.post("/api/owner/staff/{staff_id}/action")
def owner_staff_action(
    staff_id: str, body: StaffActionInput,
    owner: User = Depends(role_required("master")), db: Session = Depends(get_db),
) -> dict[str, Any]:
    item = db.get(StaffAuthorization, staff_id)
    if not item:
        raise HTTPException(status_code=404, detail="Staff record not found.")
    user = db.scalar(select(User).where(User.mobile == item.mobile))
    now = utc_now()
    if body.action == "approve":
        if item.status != "pending_owner_final_approval" or not user:
            raise HTTPException(status_code=409, detail="Only submitted setup requests can be approved.")
        item.status, item.approved_at = "ready_for_2fa", now
        user.is_active = True
    else:
        if body.action == "reject" and item.status != "pending_owner_final_approval":
            raise HTTPException(status_code=409, detail="Only submitted setup requests can be rejected.")
        item.status = "revoked" if body.action == "revoke" else "whitelisted_pending_setup"
        if user:
            user.is_active = False
            user.password_hash = user.recovery_hash = None
            user.totp_secret, user.totp_enrolled, user.totp_last_step = None, False, 0
            db.query(PortalSession).filter(PortalSession.user_id == user.id).delete()
        item.approved_at = None
        item.setup_submitted_at = None
    item.updated_at = now
    record_audit(db, owner, "staff_" + body.action, item.mobile[-4:], {"role": item.role})
    db.commit()
    return staff_data(item)


@app.get("/api/admin/helpline")
def admin_get_helpline(
    _: User = Depends(role_required("master", "masteradmin")), db: Session = Depends(get_db),
) -> dict[str, str]:
    return {"phone": get_helpline(db)}


@app.put("/api/admin/helpline")
def admin_set_helpline(
    body: HelplineInput,
    user: User = Depends(role_required("master", "masteradmin")), db: Session = Depends(get_db),
) -> dict[str, str]:
    phone = " ".join(body.phone.split())
    row = db.get(SiteSetting, HELPLINE_KEY)
    if row is None:
        row = SiteSetting(key=HELPLINE_KEY)
        db.add(row)
    row.value, row.updated_by, row.updated_at = phone, user.id, utc_now()
    record_audit(db, user, "helpline_update", HELPLINE_KEY)
    db.commit()
    return {"phone": phone}


@app.get("/api/helpline")
def partner_helpline(
    _: User = Depends(role_required("retailer", "distributor")), db: Session = Depends(get_db),
) -> dict[str, str]:
    return {"phone": get_helpline(db)}


@app.post("/api/support/tickets")
def create_support_ticket(
    body: SupportTicketInput,
    user: User = Depends(role_required("retailer", "distributor")), db: Session = Depends(get_db),
) -> dict[str, str]:
    tickets = record_value(db, SUPPORT_TICKETS_KEY)
    if sum(1 for item in tickets if item.get("userId") == user.id and item.get("status") == "open") >= 10:
        raise HTTPException(status_code=429, detail="Please wait for your open tickets to be answered.")
    ticket = {
        "id": "TKT-" + uuid4().hex[:10].upper(), "userId": user.id, "name": user.name,
        "mobile": user.mobile, "role": user.role, "category": body.category,
        "subject": body.subject.strip(), "message": body.message.strip(),
        "status": "open", "createdAt": utc_now().isoformat(),
    }
    save_record(db, SUPPORT_TICKETS_KEY, [ticket, *tickets][:1000])
    db.commit()
    return {"id": ticket["id"], "status": "open"}


@app.get("/api/support/tickets")
def list_support_tickets(
    user: User = Depends(current_user), db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    tickets = record_value(db, SUPPORT_TICKETS_KEY)
    if user.role in STAFF_ROLES:
        return tickets
    if user.role in {"retailer", "distributor"}:
        return [item for item in tickets if item.get("userId") == user.id]
    raise HTTPException(status_code=403, detail="You do not have permission for this operation.")


@app.post("/api/support/tickets/{ticket_id}/close")
def close_support_ticket(
    ticket_id: str,
    user: User = Depends(role_required("master", "masteradmin", "subadmin")),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    tickets = record_value(db, SUPPORT_TICKETS_KEY)
    ticket = next((item for item in tickets if item.get("id") == ticket_id), None)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found.")
    ticket["status"], ticket["closedAt"] = "closed", utc_now().isoformat()
    save_record(db, SUPPORT_TICKETS_KEY, tickets)
    db.commit()
    return {"status": "closed"}


def sync_retail_profiles(db: Session, profiles: list[dict[str, Any]]) -> list[dict[str, str]]:
    sanitized = []
    setup_codes = []
    for profile in profiles:
        user_id = str(profile.get("userId", "")).strip().upper()
        mobile = str(profile.get("mobile", "")).strip()
        name = str(profile.get("name", "")).strip()
        email = str(profile.get("email", "")).strip().lower()
        if (
            not re.fullmatch(r"[A-Za-z]{2,5}[0-9]{4,}", user_id)
            or not mobile.isdigit() or len(mobile) != 10
            or not 2 <= len(name) <= 80
            or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email)
        ):
            raise HTTPException(status_code=422, detail="Retailer profile contains invalid identity fields.")
        user = db.scalar(select(User).where(User.mobile == mobile))
        if user and user.role != "retailer":
            raise HTTPException(status_code=409, detail="That mobile is assigned to a different account type.")
        existing_id = db.scalar(select(User).where(User.retail_id == user_id))
        if existing_id and existing_id.mobile != mobile:
            raise HTTPException(status_code=409, detail="That Retail ID is already assigned.")
        if user is None:
            user = User(mobile=mobile, retail_id=user_id, name=name, email=email, role="retailer")
            db.add(user)
        user.retail_id, user.name, user.email = user_id, name, email
        user.is_active, user.updated_at = True, utc_now()
        setup_code = issue_setup_token(user)
        if setup_code:
            setup_codes.append({"identifier": user_id, "mobile": mobile, "code": setup_code})
        sanitized.append({k: v for k, v in profile.items() if k not in {"passwordHash", "password"}})
    save_record(db, "rm-demo-retail-profiles", sanitized)
    return setup_codes


def save_applications(db: Session, proposed: list[dict[str, Any]], actor: User) -> list[dict[str, str]]:
    setup_codes = []
    current = {item["id"]: item for item in application_values(db)}
    values = {str(item.get("id", "")): item for item in proposed}
    if len(values) != len(proposed) or not set(values).issubset(current):
        raise HTTPException(status_code=409, detail="Applications cannot be added through this update.")
    removed = set(current) - set(values)
    if removed and actor.role != "master":
        raise HTTPException(status_code=403, detail="Only the Master Admin can delete application records.")
    for application_id in removed:
        db.delete(db.get(Application, application_id))
        maps = record_value(db, "rm-demo-distributor-pin-mappings")
        save_record(db, "rm-demo-distributor-pin-mappings", [
            item for item in maps if item.get("distributorApplicationId") != application_id
        ])
    fixed = {
        "id", "name", "mobile", "business", "email", "address", "city", "role",
        "operationalPin", "servicePincodes", "documents", "submittedAt",
        "assignedDistributorApplicationId", "assignedDistributorId",
        "assignedDistributorMobile", "assignedMasterAdmin", "routedAt", "accountUserId",
        "revision", "revisionHistory", "idType", "idLast4", "jurisdiction",
        "referralVerified", "privacyAcceptedAt", "mobileVerification",
    }
    mutable = {
        "status", "generatedId", "rejectionReason", "rejectedAt", "rejectedBy",
        "approvedBy", "approvedAt", "distributorQueueStatus",
        "distributorReviewedAt", "blockedAt", "blockedBy",
    }
    own_distributor = next(
        (item for item in current.values()
         if item.get("role") == "distributor" and item.get("mobile") == actor.mobile
         and item.get("status") == "approved"),
        None,
    )
    for app_id, new in values.items():
        old = current[app_id]
        if actor.role == "distributor" and (
            not own_distributor
            or old.get("role") != "retailer"
            or old.get("assignedDistributorApplicationId") != own_distributor.get("id")
        ):
            raise HTTPException(status_code=403, detail="This application is not assigned to your Distributor account.")
        if actor.role in TWO_FACTOR_ROLES and old.get("assignedDistributorApplicationId"):
            raise HTTPException(status_code=403, detail="This application is not in your review queue.")
        protected_fields = fixed - {"documents", "revisionHistory"}
        if actor.role == "master":
            protected_fields.discard("servicePincodes")
        if any(
            (field in new and new.get(field) != old.get(field))
            if field == "accountUserId"
            else new.get(field) != old.get(field)
            for field in protected_fields
        ):
            raise HTTPException(status_code=403, detail="Application identity and routing are server controlled.")
        if "documents" in new and [d.get("id") for d in new["documents"]] != [d.get("id") for d in old.get("documents", [])]:
            raise HTTPException(status_code=403, detail="Application documents are managed by the secure upload service.")
        if "revisionHistory" in new and len(new["revisionHistory"]) != len(old.get("revisionHistory", [])):
            raise HTTPException(status_code=403, detail="Application revision history is managed by the server.")
        if actor.role == "master" and "servicePincodes" in new:
            pins = new["servicePincodes"]
            if not isinstance(pins, list) or any(not isinstance(pin, str) or not pin.isdigit() or len(pin) != 6 for pin in pins):
                raise HTTPException(status_code=422, detail="Distributor service PINs must be six-digit values.")
            if len(pins) != len(set(pins)):
                raise HTTPException(status_code=422, detail="Distributor service PINs must be unique.")
        if any(field not in fixed | mutable for field in new):
            raise HTTPException(status_code=422, detail="Unsupported application fields.")
        if new.get("status") not in {"pending", "approved", "rejected", "correction_required", "blocked", "suspended"}:
            raise HTTPException(status_code=422, detail="Invalid application status.")
        if new.get("status") == "suspended" and old.get("status") != "suspended":
            raise HTTPException(status_code=403, detail="Use the partner suspension action to suspend an account.")
        if old.get("status") == "suspended" and new.get("status") != "suspended":
            raise HTTPException(status_code=403, detail="Use the partner reactivation action for suspended accounts.")
        if old.get("status") == "approved" and new.get("status") != "approved" and actor.role != "master":
            raise HTTPException(status_code=403, detail="Only the Master Admin can change an approved application.")
        if actor.role != "master":
            for field in ("approvedBy", "rejectedBy", "blockedBy"):
                if field in new and new.get(field) != actor.name:
                    raise HTTPException(status_code=403, detail="Reviewer identity is assigned by the authenticated server session.")
            if old.get("status") != "pending" and new.get("status") != old.get("status"):
                raise HTTPException(status_code=403, detail="Only pending applications can be reviewed.")
        if new.get("status") == "approved" and old.get("status") != "approved":
            generated_id = str(new.get("generatedId", "")).strip().upper()
            if not generated_id:
                raise HTTPException(status_code=422, detail="An official partner ID is required for approval.")
            if old.get("role") == "distributor":
                ensure_unique_distributor_pins(db, old)
        previous_status = old.get("status")
        old.update({field: new[field] for field in mutable if field in new})
        row = db.get(Application, app_id)
        row.payload = old
        row.status = str(old.get("status", "pending"))
        if row.status in KYC_PURGE_STATUSES and row.status != previous_status:
            purge_application_documents(db, app_id)
            old = dict(row.payload)
        if row.status in {"blocked", "rejected", "suspended"} and row.status != previous_status:
            deactivate_partner_account(db, row.mobile)
        if row.status == "approved":
            setup_codes.extend(sync_approved_account(db, old))
    validate_all_distributor_pins(db)
    return setup_codes


def deactivate_partner_account(db: Session, mobile: str) -> None:
    account = db.scalar(select(User).where(User.mobile == mobile, User.role.in_(("retailer", "distributor"))))
    if account:
        account.is_active = False
        db.query(PortalSession).filter(PortalSession.user_id == account.id).delete()


def ensure_unique_distributor_pins(db: Session, applicant: dict[str, Any]) -> None:
    pins = set(applicant.get("servicePincodes", []))
    if not pins:
        return
    for other in application_values(db):
        if other.get("id") == applicant.get("id") or other.get("role") != "distributor" or other.get("status") != "approved":
            continue
        mapped = set(other.get("servicePincodes", []))
        mapped.update(
            pin
            for mapping in record_value(db, "rm-demo-distributor-pin-mappings")
            if mapping.get("distributorApplicationId") == other.get("id")
            for pin in mapping.get("pins", [])
        )
        if pins.intersection(mapped):
            raise HTTPException(status_code=409, detail="One or more Distributor PIN codes already belong to another approved Distributor.")


def validate_pin_mappings(db: Session, mappings: list[dict[str, Any]]) -> None:
    applications = {item["id"]: item for item in application_values(db)}
    seen: set[str] = set()
    for mapping in mappings:
        app_id = str(mapping.get("distributorApplicationId", ""))
        distributor = applications.get(app_id)
        if (
            not distributor or distributor.get("role") != "distributor"
            or distributor.get("status") != "approved"
            or mapping.get("distributorId") != distributor.get("generatedId")
        ):
            raise HTTPException(status_code=422, detail="PIN mapping must reference an approved Distributor.")
        if app_id in seen:
            raise HTTPException(status_code=409, detail="A Distributor may have only one active PIN mapping.")
        seen.add(app_id)
        pins = mapping.get("pins", [])
        if not isinstance(pins, list) or any(not isinstance(pin, str) or not pin.isdigit() or len(pin) != 6 for pin in pins):
            raise HTTPException(status_code=422, detail="Distributor mappings must contain six-digit PIN codes.")
        if len(pins) != len(set(pins)):
            raise HTTPException(status_code=422, detail="Distributor mapping PIN codes must be unique.")


def validate_all_distributor_pins(db: Session) -> None:
    distributors = {
        item["id"]: item for item in application_values(db)
        if item.get("role") == "distributor" and item.get("status") == "approved"
    }
    owners: dict[str, str] = {}
    for distributor_id, item in distributors.items():
        mapping = next(
            (entry for entry in record_value(db, "rm-demo-distributor-pin-mappings")
             if entry.get("distributorApplicationId") == distributor_id
             and entry.get("distributorId") == item.get("generatedId")),
            {},
        )
        pins = list(item.get("servicePincodes", [])) + list(mapping.get("pins", []))
        if any(not isinstance(pin, str) or not pin.isdigit() or len(pin) != 6 for pin in pins):
            raise HTTPException(status_code=422, detail="Distributor mappings must contain six-digit PIN codes.")
        for pin in set(pins):
            existing_owner = owners.setdefault(pin, distributor_id)
            if existing_owner != distributor_id:
                raise HTTPException(status_code=409, detail="A PIN code can be assigned to only one approved Distributor.")


def sync_approved_account(db: Session, data: dict[str, Any]) -> list[dict[str, str]]:
    role = str(data.get("role", ""))
    mobile = str(data.get("mobile", ""))
    if role not in {"retailer", "distributor"} or not mobile:
        return []
    user = db.scalar(select(User).where(User.mobile == mobile))
    if user and user.role != role:
        raise HTTPException(status_code=409, detail="Mobile number conflicts with an existing staff account.")
    if user is None:
        user = User(mobile=mobile, name=str(data.get("name", "")), role=role)
        db.add(user)
    user.name = str(data.get("name", ""))
    user.email = str(data.get("email", ""))
    user.role = role
    generated_id = str(data.get("generatedId", "")).upper()
    duplicate_id = db.scalar(select(User).where(User.retail_id == generated_id, User.mobile != mobile)) if generated_id else None
    if duplicate_id:
        raise HTTPException(status_code=409, detail="That official partner ID is already assigned.")
    user.retail_id = generated_id or None
    user.is_active, user.updated_at = True, utc_now()
    data["accountUserId"] = user.id
    db.get(Application, str(data["id"])).payload = data
    setup_code = issue_setup_token(user)
    return [{"identifier": user.retail_id or user.mobile, "mobile": mobile, "code": setup_code}] if setup_code else []


@app.get("/api/portal/state")
def portal_state(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    if user.role not in STAFF_ROLES | {"distributor"}:
        raise HTTPException(status_code=403, detail="The operations workspace is for staff accounts.")
    state = {}
    for key in STATE_KEYS:
        if key in MASTER_ONLY_KEYS and user.role != "master":
            continue
        records = record_value(db, key)
        if key == "rm-demo-retail-profiles" and user.role == "master":
            for profile in records:
                account = db.scalar(select(User).where(User.retail_id == profile.get("userId")))
                profile["isPasswordSet"] = bool(account and account.password_hash)
        if key == "rm-demo-distributor-notifications" and user.role == "distributor":
            records = [x for x in records if x.get("distributorMobile") == user.mobile]
        state[key] = records
    apps = application_values(db)
    if user.role in TWO_FACTOR_ROLES:
        apps = [x for x in apps if not x.get("assignedDistributorApplicationId")]
    elif user.role == "distributor":
        profile = next((x for x in apps if x.get("mobile") == user.mobile and x.get("role") == "distributor"), None)
        distributor_app_id = profile.get("id") if profile else ""
        apps = [x for x in apps if x.get("assignedDistributorApplicationId") == distributor_app_id]
        state["rm-demo-distributor-profile"] = [profile] if profile else []
    if user.role != "master":
        for application in apps:
            application.pop("documents", None)
            application.pop("revisionHistory", None)
    state[APPLICATIONS_KEY] = apps
    return {"user": session_user_data(user), "state": state}


@app.get("/api/admin/applications")
def admin_applications(
    _: User = Depends(role_required("master")), db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    applications = list(db.scalars(select(Application).order_by(Application.submitted_at.desc())))
    documents = list(db.scalars(select(CustomerDocument).order_by(CustomerDocument.uploaded_at.desc())))
    documents_by_application: dict[str, list[dict[str, Any]]] = {}
    for document in documents:
        documents_by_application.setdefault(document.application_id, []).append({
            **document_public_data(document),
            "downloadUrl": (
                "/api/admin/applications/" + document.application_id +
                "/documents/" + document.id
            ),
        })
    return [{
        "id": item.id,
        "name": item.payload.get("name", ""),
        "mobile": item.mobile,
        "business": item.payload.get("business", ""),
        "email": item.payload.get("email", ""),
        "role": item.role,
        "status": item.status,
        "submittedAt": item.submitted_at.isoformat(),
        "documents": documents_by_application.get(item.id, []),
    } for item in applications]


@app.get("/api/admin/documents")
def admin_document_submissions(
    _: User = Depends(role_required("master")), db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    applications = list(db.scalars(select(Application).order_by(Application.submitted_at.desc())))
    application_documents = list(db.scalars(
        select(CustomerDocument).order_by(CustomerDocument.uploaded_at.desc()),
    ))
    documents_by_application: dict[str, list[dict[str, Any]]] = {}
    for document in application_documents:
        documents_by_application.setdefault(document.application_id, []).append({
            **document_public_data(document),
            "downloadUrl": (
                "/api/admin/applications/" + document.application_id +
                "/documents/" + document.id
            ),
        })

    submissions = [{
        "id": item.id,
        "recordType": "application",
        "formType": item.role.title() + " application",
        "name": item.payload.get("name", ""),
        "mobile": item.mobile,
        "business": item.payload.get("business", ""),
        "email": item.payload.get("email", ""),
        "role": item.role,
        "status": item.status,
        "submittedAt": item.submitted_at.isoformat(),
        "documents": documents_by_application.get(item.id, []),
    } for item in applications]

    transaction_documents = list(db.scalars(
        select(TransactionDocument).order_by(TransactionDocument.uploaded_at.desc()),
    ))
    documents_by_transaction: dict[str, list[dict[str, Any]]] = {}
    for document in transaction_documents:
        documents_by_transaction.setdefault(document.transaction_id, []).append({
            **document_public_data(document),
            "downloadUrl": (
                "/api/admin/transactions/" + document.transaction_id +
                "/documents/" + document.id
            ),
        })
    for transaction in db.scalars(select(TransactionRecord).order_by(TransactionRecord.created_at.desc())):
        documents = documents_by_transaction.get(transaction.id)
        if not documents:
            continue
        user = db.get(User, transaction.user_id)
        submissions.append({
            "id": transaction.id,
            "recordType": "transaction",
            "formType": transaction.service + " transaction",
            "name": user.name if user else "Unknown account",
            "mobile": user.mobile if user else "",
            "business": transaction.reference,
            "email": user.email if user else "",
            "role": user.role if user else "",
            "status": transaction.status,
            "submittedAt": transaction.created_at.isoformat(),
            "documents": documents,
        })

    return sorted(submissions, key=lambda item: item["submittedAt"], reverse=True)


def preview_response(contents: bytes, content_type: str, filename: str) -> StreamingResponse:
    """Show the document inline in the browser tab instead of downloading it to the viewer's computer."""
    safe_filename = sanitize_filename(filename)
    policy = "default-src 'none'; img-src 'self'" if content_type == "application/pdf" else "sandbox"
    return StreamingResponse(
        BytesIO(contents),
        media_type=content_type,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": policy,
            "Content-Disposition": "inline; filename=\"" + safe_filename + "\"",
        },
    )


@app.get("/api/admin/applications/{application_id}/documents/{document_id}")
def download_customer_document(
    application_id: str,
    document_id: str,
    _: User = Depends(role_required("master")),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    document = db.get(CustomerDocument, document_id)
    if not document or document.application_id != application_id:
        raise HTTPException(status_code=404, detail="The requested customer document was not found.")
    if document.purged_at:
        raise HTTPException(status_code=410, detail="This document was deleted under the 7-day KYC retention policy.")
    storage_dir = document_storage_dir()
    path = (storage_dir / document.storage_key).resolve()
    if path.parent != storage_dir or not path.is_file():
        LOGGER.error("Customer document storage is missing or invalid for document %s", document.id)
        raise HTTPException(status_code=404, detail="The requested customer document is unavailable.")
    try:
        contents = document_fernet().decrypt(path.read_bytes())
    except InvalidToken as error:
        LOGGER.exception("Customer document integrity check failed for document %s", document.id)
        raise HTTPException(status_code=500, detail="The requested customer document could not be verified.") from error
    return preview_response(contents, document.content_type, document.original_filename)


@app.get("/api/admin/transactions/{transaction_id}/documents/{document_id}")
def download_transaction_document(
    transaction_id: str,
    document_id: str,
    _: User = Depends(role_required("master")),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    document = db.get(TransactionDocument, document_id)
    if not document or document.transaction_id != transaction_id:
        raise HTTPException(status_code=404, detail="The requested transaction document was not found.")
    storage_dir = document_storage_dir()
    path = (storage_dir / document.storage_key).resolve()
    if path.parent != storage_dir or not path.is_file():
        LOGGER.error("Transaction document storage is missing or invalid for document %s", document.id)
        raise HTTPException(status_code=404, detail="The requested transaction document is unavailable.")
    try:
        contents = document_fernet().decrypt(path.read_bytes())
    except InvalidToken as error:
        LOGGER.exception("Transaction document integrity check failed for document %s", document.id)
        raise HTTPException(status_code=500, detail="The requested transaction document could not be verified.") from error
    return preview_response(contents, document.content_type, document.original_filename)


@app.put("/api/portal/state/{key}")
def update_state(
    key: str, body: StateInput,
    user: User = Depends(current_user), db: Session = Depends(get_db),
) -> dict[str, Any]:
    if key not in STATE_KEYS:
        raise HTTPException(status_code=404, detail="Unknown portal collection.")
    if key in MASTER_ONLY_KEYS and user.role != "master":
        raise HTTPException(status_code=403, detail="Only the Master Admin can update this collection.")
    staff_roles = STAFF_ROLES | {"distributor"}
    if key in {
        "rm-demo-applications", "rm-demo-blocked-partner-mobiles",
    } and user.role not in staff_roles:
        raise HTTPException(status_code=403, detail="Staff access is required to update this collection.")
    if key == "rm-demo-distributor-notifications" and user.role not in {"master", "distributor"}:
        raise HTTPException(status_code=403, detail="Only the Master Admin or assigned Distributor can update notifications.")
    if key == "rm-demo-approvals" and user.role not in TWO_FACTOR_ROLES | {"master"}:
        raise HTTPException(status_code=403, detail="Only Sub-Admins may request Master Admin approval.")
    setup_codes: list[dict[str, str]] = []
    if key == "rm-demo-applications":
        setup_codes = save_applications(db, body.value, user)
    elif key == "rm-demo-retail-profiles":
        if user.role != "master":
            raise HTTPException(status_code=403, detail="Only the Master Admin can manage Retail IDs.")
        setup_codes = sync_retail_profiles(db, body.value)
    elif key == "rm-demo-approvals" and user.role != "master":
        existing = record_value(db, key)
        old_ids = {item.get("id") for item in existing}
        new_items = [item for item in body.value if item.get("id") not in old_ids]
        if (
            len(body.value) < len(existing)
            or any(item not in body.value for item in existing)
            or any(item.get("status") != "pending" or item.get("operator") != user.name for item in new_items)
        ):
            raise HTTPException(status_code=403, detail="Sub-Admins may only submit their own approval requests.")
        save_record(db, key, body.value)
    elif key == "rm-demo-distributor-notifications" and user.role == "distributor":
        existing = record_value(db, key)
        own_existing = {
            item.get("id"): item for item in existing
            if item.get("distributorMobile") == user.mobile
        }
        if any(not isinstance(item.get("id"), str) for item in body.value):
            raise HTTPException(status_code=403, detail="Distributors may update only notification status in their own queue.")
        proposed = {item["id"]: item for item in body.value}
        if len(proposed) != len(body.value) or set(proposed) != set(own_existing):
            raise HTTPException(status_code=403, detail="Distributors may update only notification status in their own queue.")
        for notification_id, item in proposed.items():
            old = own_existing[notification_id]
            if (
                item.get("distributorMobile") != user.mobile
                or item.get("status") not in {"queued", "approved", "rejected"}
                or any(
                    field not in {"status", "updatedAt"}
                    and item.get(field) != old.get(field)
                    for field in set(item) | set(old)
                )
            ):
                raise HTTPException(
                    status_code=403,
                    detail="Distributors may update only notification status in their own queue.",
                )
        save_record(
            db, key,
            [item for item in existing if item.get("distributorMobile") != user.mobile]
            + body.value,
        )
    else:
        save_record(db, key, body.value)
        if key == "rm-demo-distributor-pin-mappings":
            validate_pin_mappings(db, body.value)
            validate_all_distributor_pins(db)
    db.commit()
    return {"status": "saved", "setupCodes": setup_codes if user.role == "master" else []}


def matched_distributor(db: Session, pin: str) -> dict[str, Any] | None:
    distributors = [
        item for item in application_values(db)
        if item.get("role") == "distributor" and item.get("status") == "approved"
    ]
    mappings = record_value(db, "rm-demo-distributor-pin-mappings")
    matches = []
    for item in distributors:
        profile_pins = item.get("servicePincodes", [])
        mapped_pins = next(
            (entry.get("pins", []) for entry in mappings
             if entry.get("distributorApplicationId") == item.get("id")
             and entry.get("distributorId") == item.get("generatedId")),
            [],
        )
        if pin in profile_pins or pin in mapped_pins:
            matches.append(item)
    return matches[0] if len(matches) == 1 else None


@app.get("/api/public/pin-route")
def pin_route(pin: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    if not pin.isdigit() or len(pin) != 6:
        raise HTTPException(status_code=422, detail="Enter a valid six-digit PIN code.")
    distributor = matched_distributor(db, pin)
    if not distributor:
        return {"matched": False}
    return {
        "matched": True, "name": distributor.get("name", ""),
        "distributorId": distributor.get("generatedId", ""),
    }


@app.post("/api/applications")
async def submit_application(
    request: Request,
    application: str = Form(...),
    document_fields: str = Form(...),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    try:
        body = ApplicationInput.model_validate_json(application)
        submitted_fields = json.loads(document_fields)
    except (ValidationError, ValueError, TypeError) as error:
        raise HTTPException(status_code=422, detail="Application details or document fields are invalid.") from error
    if body.website:
        raise HTTPException(status_code=400, detail="The application could not be accepted.")
    now = utc_now()
    client = request.client.host if request.client else "unknown"
    recent = [hit for hit in _application_hits.get(client, []) if now - hit < APPLICATION_RATE_WINDOW]
    if len(_application_hits) > 5000:
        for stale in [k for k, v in _application_hits.items() if not v or now - v[-1] >= APPLICATION_RATE_WINDOW]:
            del _application_hits[stale]
    if len(recent) >= APPLICATION_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many applications from this connection. Try again later.")
    _application_hits[client] = recent + [now]
    if not body.privacyAccepted:
        raise HTTPException(status_code=422, detail="Accept the data-privacy notice to apply.")
    if body.role == "retailer":
        if not body.idType or len(body.idLast4) != 4:
            raise HTTPException(status_code=422, detail="Select Aadhaar or PAN and enter only its last 4 characters.")
        if not body.mobileConfirmed:
            raise HTTPException(status_code=422, detail="Confirm that you own and can receive calls on this mobile number.")
    else:
        if len(body.jurisdiction.strip()) < 3 or not body.servicePincodes:
            raise HTTPException(status_code=422, detail="Distributor applications require a jurisdiction and at least one service PIN code.")
        if not body.idType or len(body.idLast4) != 4:
            raise HTTPException(status_code=422, detail="Select Aadhaar or PAN and enter only its last 4 characters.")
        if not body.mobileConfirmed:
            raise HTTPException(status_code=422, detail="Confirm that you own and can receive calls on this mobile number.")
        referral_codes = [
            code.strip() for code in os.getenv("DISTRIBUTOR_REFERRAL_CODES", "").split(",") if code.strip()
        ]
        if not referral_codes:
            raise HTTPException(status_code=503, detail="Distributor onboarding is closed: no Master Distributor referral codes are configured.")
        supplied_code = body.referralCode.strip().casefold()
        if not supplied_code or not any(compare_digest(supplied_code, code.casefold()) for code in referral_codes):
            raise HTTPException(status_code=403, detail="The Master Distributor referral / approval code is not valid.")
    expected_fields = list(RETAILER_DOCUMENTS if body.role == "retailer" else DISTRIBUTOR_DOCUMENTS)
    if (
        not isinstance(submitted_fields, list)
        or any(not isinstance(field_name, str) for field_name in submitted_fields)
        or len(submitted_fields) != len(expected_fields)
        or set(submitted_fields) != set(expected_fields)
        or len(files) != len(expected_fields)
    ):
        raise HTTPException(status_code=422, detail="Upload every required application document exactly once.")

    data = body.model_dump(exclude={
        "correctionReference", "website", "referralCode", "mobileConfirmed", "privacyAccepted",
    })
    data.update({
        "name": body.name.strip(), "mobile": body.mobile,
        "business": body.business.strip(), "email": body.email.strip().lower(),
        "address": body.address.strip(), "city": body.city.strip(),
        "jurisdiction": body.jurisdiction.strip(),
        "idLast4": body.idLast4.upper(),
        "referralVerified": body.role == "distributor",
        "mobileVerification": "pending_callback",
        "privacyAcceptedAt": now.isoformat(),
        "submittedAt": now.isoformat(),
    })
    if body.role == "retailer" and not body.operationalPin:
        raise HTTPException(status_code=422, detail="Retailer application requires a six-digit PIN.")
    if body.role == "distributor" and body.operationalPin:
        raise HTTPException(status_code=422, detail="Distributor applications do not use an operational retailer PIN.")
    if any(x.get("mobile") == body.mobile for x in record_value(db, "rm-demo-blocked-partner-mobiles")):
        raise HTTPException(status_code=403, detail="This mobile number is blocked from applying.")
    correction_id = body.correctionReference.strip()
    if correction_id:
        row = db.get(Application, correction_id)
        if not row or row.mobile != body.mobile or row.status not in {"rejected", "correction_required"}:
            raise HTTPException(status_code=409, detail="This application is no longer eligible for correction.")
        previous = dict(row.payload)
        if row.role != body.role or previous.get("role") != body.role:
            raise HTTPException(status_code=409, detail="The partner type cannot be changed while correcting an application.")
        data.update({
            "id": correction_id, "status": "pending",
            "revision": int(previous.get("revision", 1)) + 1,
            "revisionHistory": previous.get("revisionHistory", []) + [{
                "submittedAt": previous.get("submittedAt", ""),
                "rejectionReason": previous.get("rejectionReason", ""),
                "documents": previous.get("documents", []),
            }],
        })
        for field in ("rejectionReason", "rejectedAt", "rejectedBy"):
            previous.pop(field, None)
    else:
        existing = db.scalar(select(Application).where(
            Application.mobile == body.mobile,
            Application.status.not_in(["rejected", "correction_required", "blocked"]),
        ))
        if existing:
            raise HTTPException(status_code=409, detail=f"An application for this mobile is already on file (reference {existing.id}).")
        data.update({"id": "APP-" + uuid4().hex[:12].upper(), "status": "pending", "revision": 1})
    distributor = matched_distributor(db, body.operationalPin) if body.role == "retailer" else None
    if body.role == "retailer":
        if distributor:
            data.update({
                "assignedDistributorApplicationId": distributor["id"],
                "assignedDistributorId": distributor.get("generatedId", ""),
                "assignedDistributorMobile": distributor.get("mobile", ""),
                "assignedMasterAdmin": False,
            })
        else:
            data["assignedMasterAdmin"] = True
        data["routedAt"] = utc_now().isoformat()
    revision = int(data.get("revision", 1))
    storage_dir = document_storage_dir()
    saved_paths: list[Path] = []
    total_size = 0
    attached_documents = []
    fernet = document_fernet()
    try:
        if not correction_id:
            db.add(Application(
                id=data["id"], mobile=body.mobile, role=body.role, status="pending",
                distributor_application_id=str(data.get("assignedDistributorApplicationId", "")),
                submitted_at=utc_now(), payload={**data, "documents": []},
            ))
            db.flush()
        for field_name, upload in zip(submitted_fields, files):
            contents, content_type, filename = await read_validated_document(upload)
            total_size += len(contents)
            if total_size > MAX_TOTAL_DOCUMENT_BYTES:
                raise HTTPException(status_code=413, detail="All application documents together must be 40 MB or smaller.")
            storage_key, saved_path = await run_in_threadpool(
                persist_document, storage_dir, contents, fernet,
            )
            saved_paths.append(saved_path)
            document = CustomerDocument(
                application_id=data["id"],
                revision=revision,
                label=DOCUMENT_FIELDS[field_name],
                original_filename=filename,
                content_type=content_type,
                size_bytes=len(contents),
                sha256_hex=sha256(contents).hexdigest(),
                storage_key=storage_key,
                uploaded_at=utc_now(),
            )
            db.add(document)
            db.flush()
            attached_documents.append(document_public_data(document))
        data["documents"] = attached_documents

        if correction_id:
            row.payload = data
            row.status = "pending"
            row.distributor_application_id = str(data.get("assignedDistributorApplicationId", ""))
            row.submitted_at = utc_now()
        else:
            row = db.get(Application, data["id"])
            row.payload = data
        if distributor:
            notifications = record_value(db, "rm-demo-distributor-notifications")
            notifications.insert(0, {
                "id": "NTF-" + uuid4().hex[:12].upper(),
                "distributorApplicationId": distributor["id"],
                "distributorId": distributor.get("generatedId", ""),
                "distributorMobile": distributor.get("mobile", ""),
                "applicationId": data["id"], "operationalPin": body.operationalPin,
                "message": "New Retailer application waiting for review.",
                "createdAt": utc_now().isoformat(), "status": "queued",
            })
            save_record(db, "rm-demo-distributor-notifications", notifications)
        db.commit()
    except Exception as error:
        db.rollback()
        for saved_path in saved_paths:
            saved_path.unlink(missing_ok=True)
        if not isinstance(error, HTTPException):
            LOGGER.exception("Application submission or document storage failed")
        raise
    finally:
        for upload in files:
            await upload.close()
    return {"application": data, "assignedDistributor": (
        {"name": distributor.get("name", ""), "generatedId": distributor.get("generatedId", "")}
        if distributor else None
    )}


@app.get("/api/applications/lookup")
def lookup_application(
    reference: str, mobile: str, request: Request, db: Session = Depends(get_db),
) -> dict[str, Any]:
    key = throttle_key(request, "lookup", "global")
    throttle_check(db, key)
    row = db.get(Application, reference.strip()[:80])
    if not row or not compare_digest(row.mobile, mobile.strip()):
        throttle_fail(db, key)
        raise HTTPException(status_code=404, detail="No application matched that reference and mobile number.")
    payload = dict(row.payload)
    payload.pop("documents", None)
    payload.pop("revisionHistory", None)
    return {"application": payload}


@app.get("/api/public/application-status")
def application_status(mobile: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    if not mobile.isdigit() or len(mobile) != 10:
        raise HTTPException(status_code=422, detail="Enter a valid 10-digit mobile number.")
    blocked = any(x.get("mobile") == mobile for x in record_value(db, "rm-demo-blocked-partner-mobiles"))
    if blocked:
        return {"blocked": True, "application": None}
    row = db.scalar(select(Application).where(Application.mobile == mobile).order_by(Application.submitted_at.desc()))
    return {"blocked": False, "application": (
        {"id": row.id, "status": row.status, "role": row.role} if row else None
    )}


@app.post("/api/retailer/activate")
def activate_retailer(
    body: AuthInput, request: Request, response: Response, db: Session = Depends(get_db),
) -> dict[str, Any]:
    if not body.name.isdigit() or len(body.name) != 10:
        raise HTTPException(status_code=422, detail="Confirm the registered 10-digit mobile number.")
    activate_key = throttle_key(request, "activate", normalized_identifier(body.identifier))
    throttle_check(db, activate_key)
    user = db.scalar(select(User).where(User.retail_id == normalized_identifier(body.identifier)))
    if not user or user.mobile != body.name or user.role != "retailer" or user.password_hash or not user.is_active:
        throttle_fail(db, activate_key)
        raise HTTPException(status_code=403, detail="Retail ID or registered mobile number could not be verified.")
    password_policy(body.password)
    if len(body.recovery) < 12:
        raise HTTPException(status_code=422, detail="Recovery phrase must be at least 12 characters.")
    try:
        consume_setup_token(user, body.activationToken)
    except HTTPException:
        throttle_fail(db, activate_key)
        raise
    throttle_clear(db, activate_key)
    user.password_hash = hash_secret(body.password)
    user.recovery_hash = hash_secret(body.recovery)
    user.updated_at = utc_now()
    db.commit()
    create_session(db, response, user)
    return {"user": session_user_data(user)}


def distributor_card(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "applicationId": payload.get("id", ""),
        "name": payload.get("name", ""),
        "mobile": payload.get("mobile", ""),
        "email": payload.get("email", ""),
        "distributorId": payload.get("generatedId", ""),
        "status": payload.get("status", ""),
        "area": {
            "jurisdiction": payload.get("jurisdiction", ""),
            "city": payload.get("city", ""),
            "pincodes": payload.get("servicePincodes", []),
        },
    }


def approved_distributor_application(db: Session, user: User) -> Application | None:
    return db.scalar(select(Application).where(
        Application.mobile == user.mobile, Application.role == "distributor",
        Application.status == "approved",
    ))


@app.get("/api/retailer/profile")
def retailer_profile(
    user: User = Depends(role_required("retailer")), db: Session = Depends(get_db),
) -> dict[str, Any]:
    own = db.scalar(select(Application).where(
        Application.mobile == user.mobile, Application.role == "retailer",
    ).order_by(Application.submitted_at.desc()))
    distributor = None
    if own and own.distributor_application_id:
        row = db.get(Application, own.distributor_application_id)
        if row:
            distributor = distributor_card(row.payload)
    return {"profile": session_user_data(user), "distributor": distributor, "helpline": get_helpline(db)}


@app.get("/api/distributor/retailers")
def distributor_retailers(
    user: User = Depends(role_required("distributor")), db: Session = Depends(get_db),
) -> dict[str, Any]:
    distributor = approved_distributor_application(db, user)
    if not distributor:
        raise HTTPException(status_code=403, detail="An approved Distributor profile is required.")
    rows = list(db.scalars(select(Application).where(
        Application.role == "retailer", Application.distributor_application_id == distributor.id,
    ).order_by(Application.submitted_at.desc())))
    accounts = {
        account.mobile: account for account in db.scalars(
            select(User).where(User.role == "retailer", User.mobile.in_([row.mobile for row in rows] or [""]))
        )
    }
    totals = {
        user_id: (count, total) for user_id, count, total in db.execute(
            select(TransactionRecord.user_id, func.count(), func.coalesce(func.sum(TransactionRecord.amount_paise), 0))
            .where(TransactionRecord.user_id.in_([a.id for a in accounts.values()] or [""]))
            .group_by(TransactionRecord.user_id)
        )
    }
    retailers = []
    for row in rows:
        account = accounts.get(row.mobile)
        count, total = totals.get(account.id, (0, 0)) if account else (0, 0)
        retailers.append({
            "applicationId": row.id, "name": row.payload.get("name", ""),
            "business": row.payload.get("business", ""), "mobile": row.mobile,
            "city": row.payload.get("city", ""), "pin": row.payload.get("operationalPin", ""),
            "status": row.status, "retailerId": row.payload.get("generatedId", ""),
            "active": bool(row.status == "approved" and account and account.is_active),
            "submittedAt": row.submitted_at.isoformat(),
            "transactionCount": count, "transactionTotalPaise": int(total),
        })
    return {
        "distributor": distributor_card(distributor.payload),
        "summary": {
            "total": len(retailers),
            "active": sum(1 for item in retailers if item["active"]),
            "pending": sum(1 for item in retailers if item["status"] == "pending"),
            "suspended": sum(1 for item in retailers if item["status"] == "suspended"),
            "transactions": sum(item["transactionCount"] for item in retailers),
        },
        "retailers": retailers,
    }


def partner_summary(row: Application) -> dict[str, Any]:
    payload = row.payload
    return {
        "applicationId": row.id, "role": row.role, "name": payload.get("name", ""),
        "business": payload.get("business", ""), "mobile": row.mobile,
        "city": payload.get("city", ""), "status": row.status,
        "partnerId": payload.get("generatedId", ""),
        "pin": payload.get("operationalPin", ""),
        "jurisdiction": payload.get("jurisdiction", ""),
        "pincodes": payload.get("servicePincodes", []),
        "distributorApplicationId": row.distributor_application_id,
        "submittedAt": row.submitted_at.isoformat(),
    }


@app.get("/api/admin/network")
def admin_network(
    _: User = Depends(role_required("master", "masteradmin", "subadmin")), db: Session = Depends(get_db),
) -> dict[str, Any]:
    rows = list(db.scalars(select(Application).order_by(Application.submitted_at.desc())))
    partners = [partner_summary(row) for row in rows]
    distributors = [item for item in partners if item["role"] == "distributor"]
    for item in distributors:
        mine = [r for r in partners if r["role"] == "retailer" and r["distributorApplicationId"] == item["applicationId"]]
        item["retailerCount"] = len(mine)
        item["activeRetailerCount"] = sum(1 for r in mine if r["status"] == "approved")
    names = {item["applicationId"]: item["name"] for item in distributors}
    retailers = [item for item in partners if item["role"] == "retailer"]
    for item in retailers:
        item["distributorName"] = names.get(item["distributorApplicationId"], "")
    return {"distributors": distributors, "retailers": retailers}


def next_partner_id(db: Session, role: str) -> str:
    prefix = "RTF" if role == "retailer" else "DST"
    used = {value for value in db.scalars(select(User.retail_id)) if value}
    used.update(str(row.payload.get("generatedId", "")).upper() for row in db.scalars(select(Application)))
    while True:
        candidate = prefix + str(secrets.randbelow(900000) + 100000)
        if candidate not in used:
            return candidate


@app.post("/api/admin/partners/{application_id}/action")
def partner_action(
    application_id: str, body: PartnerActionInput,
    user: User = Depends(role_required("master", "masteradmin", "subadmin", "distributor")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    row = db.get(Application, application_id)
    if not row:
        raise HTTPException(status_code=404, detail="Partner application not found.")
    if user.role == "distributor":
        own = approved_distributor_application(db, user)
        if (
            not own or row.role != "retailer" or row.distributor_application_id != own.id
            or body.action not in {"approve", "reject"}
        ):
            raise HTTPException(status_code=403, detail="This partner is not in your Distributor scope.")
    payload = dict(row.payload)
    setup_codes: list[dict[str, str]] = []
    if body.action in {"approve", "reject"}:
        if row.status not in {"pending", "correction_required"} or (
            body.action == "approve" and row.status != "pending"
        ):
            raise HTTPException(status_code=409, detail="Only pending applications can be reviewed.")
        if user.role in TWO_FACTOR_ROLES and row.distributor_application_id:
            raise HTTPException(status_code=403, detail="This application is in a Distributor's queue.")
    if body.action == "approve":
        if row.role == "distributor":
            ensure_unique_distributor_pins(db, payload)
        payload.update({
            "status": "approved", "approvedBy": user.name, "approvedAt": utc_now().isoformat(),
            "generatedId": str(payload.get("generatedId") or next_partner_id(db, row.role)),
        })
        row.payload, row.status = payload, "approved"
        setup_codes = sync_approved_account(db, payload)
        validate_all_distributor_pins(db)
    elif body.action == "reject":
        payload.update({
            "status": "rejected", "rejectedBy": user.name, "rejectedAt": utc_now().isoformat(),
            "rejectionReason": body.reason.strip(),
        })
        row.payload, row.status = payload, "rejected"
    elif body.action == "suspend":
        if row.status != "approved":
            raise HTTPException(status_code=409, detail="Only approved partners can be suspended.")
        payload["status"] = "suspended"
        row.payload, row.status = payload, "suspended"
        account = db.get(User, payload.get("accountUserId", ""))
        if account:
            account.is_active = False
            db.query(PortalSession).filter(PortalSession.user_id == account.id).delete()
    else:
        if row.status != "suspended":
            raise HTTPException(status_code=409, detail="Only suspended partners can be reactivated.")
        payload["status"] = "approved"
        row.payload, row.status = payload, "approved"
        account = db.get(User, payload.get("accountUserId", ""))
        if account:
            account.is_active = True
    if row.status in KYC_PURGE_STATUSES:
        purge_application_documents(db, row.id)
    record_audit(db, user, "partner_" + body.action, row.id, {"reason": body.reason.strip(), "role": row.role})
    db.commit()
    return {
        "status": row.status, "partnerId": row.payload.get("generatedId", ""),
        "setupCodes": setup_codes if user.role == "master" else [],
    }


@app.post("/api/owner/partners/{application_id}/setup-code")
def owner_issue_partner_setup_code(
    application_id: str, owner: User = Depends(role_required("master")), db: Session = Depends(get_db),
) -> dict[str, str]:
    """Only the owner can mint a first-login code; staff who approved a partner never see it."""
    row = db.get(Application, application_id)
    account = db.get(User, row.payload.get("accountUserId", "")) if row and row.status == "approved" else None
    if not account or account.role not in {"retailer", "distributor"}:
        raise HTTPException(status_code=404, detail="No approved partner account found for this application.")
    if account.password_hash:
        raise HTTPException(status_code=409, detail="This partner has already set a password.")
    account.setup_token_hash = account.setup_token_expires_at = None
    code = issue_setup_token(account)
    record_audit(db, owner, "partner_setup_code", row.id, {"role": account.role})
    db.commit()
    return {"identifier": account.retail_id or account.mobile, "mobile": account.mobile, "code": code or ""}


@app.post("/api/admin/retailers/{application_id}/reassign")
def reassign_retailer(
    application_id: str, body: ReassignInput,
    user: User = Depends(role_required("master", "masteradmin", "subadmin")), db: Session = Depends(get_db),
) -> dict[str, Any]:
    row = db.get(Application, application_id)
    if not row or row.role != "retailer":
        raise HTTPException(status_code=404, detail="Retailer application not found.")
    payload = dict(row.payload)
    target_id = body.distributorApplicationId.strip()
    if target_id:
        target = db.get(Application, target_id)
        if not target or target.role != "distributor" or target.status != "approved":
            raise HTTPException(status_code=422, detail="Choose an approved Distributor.")
        payload.update({
            "assignedDistributorApplicationId": target.id,
            "assignedDistributorId": target.payload.get("generatedId", ""),
            "assignedDistributorMobile": target.mobile, "assignedMasterAdmin": False,
        })
    else:
        for field in ("assignedDistributorApplicationId", "assignedDistributorId", "assignedDistributorMobile"):
            payload[field] = ""
        payload["assignedMasterAdmin"] = True
    payload["routedAt"] = utc_now().isoformat()
    row.payload, row.distributor_application_id = payload, target_id
    record_audit(db, user, "retailer_reassign", row.id, {"to": target_id or "master"})
    db.commit()
    return {"status": "reassigned", "distributorApplicationId": target_id}


@app.post("/api/retailer/upline-request")
def request_upline_change(
    body: UplineRequestInput,
    user: User = Depends(role_required("retailer")),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    requests = record_value(db, "rm-demo-upline-requests")
    if any(item.get("userId") == user.retail_id and item.get("status") == "pending" for item in requests):
        raise HTTPException(status_code=409, detail="A Upline change request is already awaiting review.")
    requests.insert(0, {
        "id": "UPL-" + uuid4().hex[:12].upper(),
        "userId": user.retail_id,
        "name": user.name,
        "mobile": user.mobile,
        "reason": body.reason.strip(),
        "requestedAt": utc_now().isoformat(),
        "status": "pending",
    })
    save_record(db, "rm-demo-upline-requests", requests)
    db.commit()
    return {"status": "received"}


@app.post("/api/transactions")
async def create_transaction(
    request: Request,
    user: User = Depends(role_required("master", "masteradmin", "subadmin", "retailer", "distributor")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    uploads: list[StarletteUploadFile] = []
    try:
        if request.headers.get("content-type", "").startswith("multipart/form-data"):
            form = await request.form()
            form_uploads = form.getlist("files")
            uploads = [item for item in form_uploads if isinstance(item, StarletteUploadFile)]
            if len(uploads) != len(form_uploads):
                raise HTTPException(status_code=422, detail="Transaction attachments are invalid.")
            raw_transaction = form.get("transaction")
            if not isinstance(raw_transaction, str):
                raise HTTPException(status_code=422, detail="Transaction details are required.")
            body = TransactionInput.model_validate_json(raw_transaction)
        elif request.headers.get("content-type", "").startswith("application/json"):
            body = TransactionInput.model_validate(await request.json())
        else:
            raise HTTPException(status_code=415, detail="Submit transaction details as JSON or multipart form data.")
    except HTTPException:
        for upload in uploads:
            await upload.close()
        raise
    except (ValidationError, ValueError, TypeError) as error:
        for upload in uploads:
            await upload.close()
        raise HTTPException(status_code=422, detail="Transaction details are invalid.") from error

    reference = body.reference.strip()
    saved_paths: list[Path] = []
    documents: list[dict[str, Any]] = []
    total_size = 0
    try:
        if len(uploads) > 10:
            raise HTTPException(status_code=422, detail="A transaction can include at most 10 documents.")
        if db.scalar(select(TransactionRecord).where(TransactionRecord.reference == reference)):
            raise HTTPException(status_code=409, detail="Transaction reference already exists.")
        row = TransactionRecord(
            user_id=user.id, reference=reference, service=body.service.strip(),
            amount_paise=body.amountPaise, details=body.details,
        )
        db.add(row)
        db.flush()
        if uploads:
            storage_dir = document_storage_dir()
            fernet = document_fernet()
            for upload in uploads:
                contents, content_type, filename = await read_validated_document(upload)
                total_size += len(contents)
                if total_size > MAX_TOTAL_DOCUMENT_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="All transaction documents together must be 40 MB or smaller.",
                    )
                storage_key, saved_path = await run_in_threadpool(
                    persist_document, storage_dir, contents, fernet,
                )
                saved_paths.append(saved_path)
                document = TransactionDocument(
                    transaction_id=row.id,
                    original_filename=filename,
                    content_type=content_type,
                    size_bytes=len(contents),
                    sha256_hex=sha256(contents).hexdigest(),
                    storage_key=storage_key,
                    uploaded_at=utc_now(),
                )
                db.add(document)
                db.flush()
                documents.append(document_public_data(document))
        db.commit()
    except Exception as error:
        db.rollback()
        for saved_path in saved_paths:
            saved_path.unlink(missing_ok=True)
        if not isinstance(error, HTTPException):
            LOGGER.exception("Transaction submission or document storage failed")
        raise
    finally:
        for upload in uploads:
            await upload.close()
    return {**transaction_data(row), "documents": documents}


@app.get("/api/transactions")
def list_transactions(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    query = select(TransactionRecord).order_by(TransactionRecord.created_at.desc())
    if user.role != "master":
        query = query.where(TransactionRecord.user_id == user.id)
    return [transaction_data(item) for item in db.scalars(query.limit(500))]


def transaction_data(row: TransactionRecord) -> dict[str, Any]:
    return {
        "id": row.id, "reference": row.reference, "service": row.service,
        "amountPaise": row.amount_paise, "status": row.status,
        "details": row.details, "createdAt": row.created_at.isoformat(),
    }


@app.post("/api/service-enquiries")
def create_service_enquiry(body: dict[str, Any], db: Session = Depends(get_db)) -> dict[str, str]:
    name = str(body.get("name", "")).strip()[:80]
    mobile = str(body.get("mobile", "")).strip()
    service = str(body.get("service", "")).strip()[:80]
    message = str(body.get("message", "")).strip()[:1000]
    if len(name) < 2 or not mobile.isdigit() or len(mobile) != 10 or len(service) < 2:
        raise HTTPException(status_code=422, detail="Enter a valid name, mobile and service.")
    requests = record_value(db, "rm-demo-service-requests")
    requests.insert(0, {
        "id": "SRV-" + uuid4().hex[:12].upper(), "name": name, "mobile": mobile,
        "service": service, "message": message,
        "requestedAt": utc_now().isoformat(), "status": "pending",
    })
    save_record(db, "rm-demo-service-requests", requests)
    db.commit()
    return {"status": "received"}


def get_ocr_reader() -> Any:
    global _ocr_reader
    if _ocr_reader is None:
        with OCR_LOCK:
            if _ocr_reader is None:
                import easyocr
                _ocr_reader = easyocr.Reader(["en", "hi"], gpu=False)
    return _ocr_reader


@app.post("/api/scan-document")
async def scan_document(file: UploadFile = File(...)) -> dict[str, str]:
    if file.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=415, detail="Select a JPEG or PNG image. PDF scanning is not supported.")
    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    if not contents:
        raise HTTPException(status_code=400, detail="The uploaded image is empty.")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The image must be 8 MB or smaller.")
    try:
        import cv2
        import numpy as np
        from PIL import Image, UnidentifiedImageError
        with Image.open(BytesIO(contents)) as image_header:
            if image_header.format not in {"JPEG", "PNG"}:
                raise HTTPException(status_code=415, detail="Select a JPEG or PNG image.")
            width, height = image_header.size
            if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
                raise HTTPException(status_code=413, detail="Image dimensions exceed the scan service limit.")
            image_header.verify()
        image = cv2.imdecode(np.frombuffer(contents, dtype=np.uint8), cv2.IMREAD_COLOR)
    except HTTPException:
        raise
    except UnidentifiedImageError as error:
        raise HTTPException(status_code=400, detail="The upload is not a valid image.") from error
    except Exception as error:
        LOGGER.exception("Document image validation failed")
        raise HTTPException(status_code=400, detail="The uploaded image could not be decoded.") from error
    if image is None:
        raise HTTPException(status_code=400, detail="The uploaded file is not a readable image.")
    try:
        reader = await run_in_threadpool(get_ocr_reader)
        results = await run_in_threadpool(reader.readtext, image)
    except Exception as error:
        LOGGER.exception("Document OCR failed")
        raise HTTPException(status_code=503, detail="OCR processing is unavailable. Try again later.") from error
    return {
        "status": "success",
        "extracted_text": " ".join(result[1] for result in results),
        "message": "Image text extraction completed. Document authenticity was not verified.",
    }


@app.get("/preview-dashboard", include_in_schema=False)
def preview_dashboard() -> FileResponse:
    return FileResponse(BASE_DIR / "dashboard.html", headers={"Cache-Control": "no-store"})


@app.get("/dashboard", include_in_schema=False)
def dashboard_page() -> FileResponse:
    return FileResponse(BASE_DIR / "dashboard.html", headers={"Cache-Control": "no-store"})


class AssistantChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(max_length=2000)


class PublicAssistantRequest(InputModel):
    message: str = Field(max_length=1000)


def load_ai_settings(db: Session) -> tuple[dict[str, Any], dict[str, Any]]:
    row = db.get(PortalRecord, AI_CONFIG_KEY)
    envelope = row.value if row and isinstance(row.value, dict) else {}
    version = envelope.get("version")
    meta = {
        "version": version if isinstance(version, int) else 0,
        "updatedAt": str(envelope.get("updatedAt", "")),
        "updatedBy": str(envelope.get("updatedBy", "")),
    }
    return safe_ai_config(envelope.get("config")), meta


def save_ai_config(db: Session, owner: User, config: dict[str, Any], action: str) -> dict[str, Any]:
    _, meta = load_ai_settings(db)
    envelope = {
        "config": config, "version": meta["version"] + 1,
        "updatedAt": utc_now().isoformat(), "updatedBy": owner.name,
    }
    row = db.get(PortalRecord, AI_CONFIG_KEY)
    if row is None:
        db.add(PortalRecord(key=AI_CONFIG_KEY, value=envelope))
    else:
        row.value = envelope
        row.updated_at = utc_now()
    record_audit(db, owner, action, AI_CONFIG_KEY, {"version": envelope["version"]})
    db.commit()
    return {"config": config, "meta": {k: envelope[k] for k in ("version", "updatedAt", "updatedBy")}}


def log_ai_event(
    db: Session, config: dict[str, Any], channel: str, actor_id: str, actor_role: str,
    message: str, reply: str, outcome: str,
) -> None:
    if not config["logConversations"] or outcome in {"empty", "disabled", "rate_limited"}:
        return
    try:
        db.add(AuditLog(
            actor_id=actor_id, actor_role=actor_role, action=AI_LOG_ACTIONS[channel], target=channel,
            detail={"question": redact_for_log(message), "reply": reply[:300], "outcome": outcome},
            created_at=utc_now(),
        ))
        db.commit()
    except Exception:
        db.rollback()
        LOGGER.exception("The assistant conversation could not be logged")


@app.get("/api/public/assistant/config")
def public_assistant_settings(db: Session = Depends(get_db)) -> dict[str, Any]:
    section = load_ai_settings(db)[0]["public"]
    return {"enabled": section["enabled"], "greeting": section["greeting"]}


@app.post("/api/public/assistant/chat")
def public_assistant_chat(
    payload: PublicAssistantRequest, request: Request, db: Session = Depends(get_db),
) -> JSONResponse:
    config = load_ai_settings(db)[0]
    remote = request.client.host if request.client else "unknown"
    body, status, outcome, message = run_chat(
        "public", payload.message, config, limiter=PUBLIC_ASSISTANT_LIMITER, rate_key=remote,
    )
    log_ai_event(db, config, "public", "public", "visitor", message, body["reply"], outcome)
    return JSONResponse(status_code=status, content=body, headers={"Cache-Control": "no-store"})


@app.post("/assistant/chat")
def assistant_chat(
    payload: AssistantChatRequest, request: Request,
    user: User = Depends(current_user), db: Session = Depends(get_db),
):
    check_origin(request)
    session_cookie = request.cookies.get(COOKIE_NAME, "")
    if not compare_digest(request.headers.get("x-csrf-token", ""), csrf_token_for(session_cookie)):
        raise HTTPException(status_code=403, detail="A valid CSRF token is required.")
    config = load_ai_settings(db)[0]
    body, status, outcome, message = run_chat(
        "portal", payload.message, config, limiter=ASSISTANT_LIMITER, rate_key=str(user.id), role=user.role,
    )
    log_ai_event(db, config, "portal", user.id, user.role, message, body["reply"], outcome)
    return JSONResponse(status_code=status, content=body, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------------------
# Supreme Owner console: every page, asset and API below requires the "master" role.
# ---------------------------------------------------------------------------
owner_only = role_required("master")
OWNER_PAGE_HEADERS = {"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow"}


def owner_console_file(request: Request, db: Session, filename: str) -> FileResponse | RedirectResponse:
    try:
        user = current_user(request, db)
    except HTTPException:
        return RedirectResponse("/login.html", status_code=303, headers=OWNER_PAGE_HEADERS)
    if user.role != "master":
        raise HTTPException(status_code=404, detail="Not found.")
    return FileResponse(OWNER_CONSOLE_DIR / filename, headers=OWNER_PAGE_HEADERS)


@app.get("/supreme-owner", include_in_schema=False)
def supreme_owner_page(request: Request, db: Session = Depends(get_db)):
    return owner_console_file(request, db, "owner.html")


@app.get("/supreme-owner/assets/{asset_name}", include_in_schema=False)
def supreme_owner_asset(asset_name: str, request: Request, db: Session = Depends(get_db)):
    if asset_name not in OWNER_CONSOLE_ASSETS:
        raise HTTPException(status_code=404, detail="Not found.")
    return owner_console_file(request, db, asset_name)


class OwnerPasswordInput(InputModel):
    password: str = Field(min_length=1, max_length=128)


class AiConfigInput(InputModel):
    config: dict[str, Any]


class AiTestInput(InputModel):
    channel: str = Field(pattern=r"^(public|portal)$")
    role: str = Field(default="retailer", pattern=r"^(retailer|distributor|subadmin|masteradmin|master)$")
    message: str = Field(max_length=1000)
    config: dict[str, Any] | None = None


def grouped_counts(db: Session, column: Any) -> dict[str, int]:
    return {str(key): count for key, count in db.execute(select(column, func.count()).group_by(column)).all()}


def count_rows(db: Session, model: Any) -> int:
    return db.scalar(select(func.count()).select_from(model)) or 0


@app.get("/api/supreme/overview")
def supreme_overview(_: User = Depends(owner_only), db: Session = Depends(get_db)) -> dict[str, Any]:
    config, meta = load_ai_settings(db)
    now = utc_now()
    return {
        "users": grouped_counts(db, User.role),
        "applications": grouped_counts(db, Application.status),
        "staff": grouped_counts(db, StaffAuthorization.status),
        "activeSessions": db.scalar(
            select(func.count()).select_from(PortalSession).where(PortalSession.expires_at > now)) or 0,
        "auditEntries": count_rows(db, AuditLog),
        "ai": {
            "publicEnabled": config["public"]["enabled"], "portalEnabled": config["portal"]["enabled"],
            "configVersion": meta["version"],
        },
        "serverTime": now.isoformat(),
    }


@app.get("/api/supreme/logs")
def supreme_logs(
    limit: int = Query(default=50, ge=1, le=200),
    action: str = Query(default="", max_length=40),
    beforeId: int = Query(default=0, ge=0),
    _: User = Depends(owner_only), db: Session = Depends(get_db),
) -> dict[str, Any]:
    query = select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)
    if action:
        query = query.where(AuditLog.action == action)
    if beforeId:
        query = query.where(AuditLog.id < beforeId)
    rows = list(db.scalars(query))
    return {
        "entries": [
            {
                "id": row.id, "actorId": row.actor_id, "actorRole": row.actor_role, "action": row.action,
                "target": row.target, "detail": row.detail, "createdAt": row.created_at.isoformat(),
            }
            for row in rows
        ],
        "actions": list(db.scalars(select(AuditLog.action).distinct().order_by(AuditLog.action))),
        "nextBeforeId": rows[-1].id if len(rows) == limit else 0,
    }


@app.get("/api/supreme/security")
def supreme_security(_: User = Depends(owner_only), db: Session = Depends(get_db)) -> dict[str, Any]:
    now = utc_now()
    owner_account = db.scalar(select(User).where(User.role == "master"))
    return {
        "sessionLifetimeHours": int(SESSION_LIFETIME.total_seconds() // 3600),
        "loginFailureLimit": LOGIN_FAILURE_LIMIT,
        "lockoutMinutes": int(LOGIN_LOCK_TIME.total_seconds() // 60),
        "secureCookies": COOKIE_SECURE,
        "kycRetentionDays": KYC_RETENTION_DAYS,
        "twoFactorRoles": sorted(MFA_LOGIN_ROLES),
        "dedicatedCsrfSecret": bool(os.getenv("CSRF_SECRET")),
        "bootstrapTokenConfigured": bool(os.getenv("RM_MASTER_BOOTSTRAP_TOKEN")),
        "ownerSetupComplete": bool(owner_account and owner_account.password_hash),
        "activeSessions": db.scalar(
            select(func.count()).select_from(PortalSession).where(PortalSession.expires_at > now)) or 0,
        "activeLockouts": db.scalar(
            select(func.count()).select_from(LoginAttempt).where(LoginAttempt.locked_until > now)) or 0,
        "staffWithoutTwoFactor": db.scalar(
            select(func.count()).select_from(User).where(
                User.role.in_(sorted(TWO_FACTOR_ROLES)), User.is_active.is_(True), User.totp_enrolled.is_(False))) or 0,
    }


@app.post("/api/supreme/security/revoke-sessions")
def supreme_revoke_sessions(
    body: OwnerPasswordInput, request: Request,
    owner: User = Depends(owner_only), db: Session = Depends(get_db),
) -> dict[str, int]:
    key = throttle_key(request, "owner-reauth", owner.id)
    throttle_check(db, key)
    if not verify_secret(body.password, owner.password_hash):
        throttle_fail(db, key)
        raise HTTPException(status_code=401, detail="Password verification failed.")
    throttle_clear(db, key)
    current_hash = sha256(request.cookies.get(COOKIE_NAME, "").encode()).hexdigest()
    revoked = db.query(PortalSession).filter(PortalSession.token_hash != current_hash).delete()
    record_audit(db, owner, "sessions_revoke_all", "all", {"revoked": revoked})
    db.commit()
    return {"revoked": revoked}


@app.post("/api/supreme/security/clear-lockouts")
def supreme_clear_lockouts(
    owner: User = Depends(owner_only), db: Session = Depends(get_db),
) -> dict[str, int]:
    cleared = db.query(LoginAttempt).delete()
    record_audit(db, owner, "lockouts_clear", "all", {"cleared": cleared})
    db.commit()
    return {"cleared": cleared}


@app.post("/api/supreme/staff/{staff_id}/sign-out")
def supreme_staff_sign_out(
    staff_id: str, owner: User = Depends(owner_only), db: Session = Depends(get_db),
) -> dict[str, int]:
    item = db.get(StaffAuthorization, staff_id)
    if not item:
        raise HTTPException(status_code=404, detail="Staff record not found.")
    user = db.scalar(select(User).where(User.mobile == item.mobile))
    revoked = db.query(PortalSession).filter(PortalSession.user_id == user.id).delete() if user else 0
    record_audit(db, owner, "staff_sign_out", item.mobile[-4:], {"role": item.role, "revoked": revoked})
    db.commit()
    return {"revoked": revoked}


@app.get("/api/supreme/database")
def supreme_database(_: User = Depends(owner_only), db: Session = Depends(get_db)) -> dict[str, Any]:
    db.execute(select(1))
    models = (
        User, StaffAuthorization, SiteSetting, PortalRecord, Application, CustomerDocument,
        AuditLog, TransactionDocument, PortalSession, LoginAttempt, TransactionRecord,
    )
    result: dict[str, Any] = {
        "dialect": engine.dialect.name, "driver": engine.dialect.driver, "healthy": True,
        "tables": {model.__tablename__: count_rows(db, model) for model in models},
        "pool": None,
        "note": "Database parameters are fixed at startup. Change them in the host's environment "
                "variables and redeploy.",
    }
    if not DB_URL.startswith("sqlite"):
        result["pool"] = {
            "DB_POOL_SIZE": positive_integer_setting("DB_POOL_SIZE", 5, 1, 50),
            "DB_MAX_OVERFLOW": positive_integer_setting("DB_MAX_OVERFLOW", 5, 0, 100),
            "DB_POOL_TIMEOUT_SECONDS": positive_integer_setting("DB_POOL_TIMEOUT_SECONDS", 30, 1, 300),
            "DB_POOL_RECYCLE_SECONDS": positive_integer_setting("DB_POOL_RECYCLE_SECONDS", 1800, 60, 86400),
        }
    return result


@app.get("/api/supreme/ai/config")
def supreme_ai_get_config(_: User = Depends(owner_only), db: Session = Depends(get_db)) -> dict[str, Any]:
    config, meta = load_ai_settings(db)
    return {"config": config, "meta": meta}


@app.put("/api/supreme/ai/config")
def supreme_ai_put_config(
    body: AiConfigInput, owner: User = Depends(owner_only), db: Session = Depends(get_db),
) -> dict[str, Any]:
    try:
        config = normalize_ai_config(body.config)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return save_ai_config(db, owner, config, "ai_config_update")


@app.post("/api/supreme/ai/config/reset")
def supreme_ai_reset_config(
    owner: User = Depends(owner_only), db: Session = Depends(get_db),
) -> dict[str, Any]:
    return save_ai_config(db, owner, default_ai_config(), "ai_config_reset")


@app.get("/api/supreme/ai/conversations")
def supreme_ai_conversations(
    channel: str = Query(default="", pattern=r"^(public|portal)?$"),
    limit: int = Query(default=50, ge=1, le=200),
    _: User = Depends(owner_only), db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    actions = [AI_LOG_ACTIONS[channel]] if channel else list(AI_LOG_ACTIONS.values())
    rows = db.scalars(
        select(AuditLog).where(AuditLog.action.in_(actions)).order_by(AuditLog.id.desc()).limit(limit))
    return [
        {
            "id": row.id, "channel": row.target, "role": row.actor_role,
            "question": row.detail.get("question", ""), "reply": row.detail.get("reply", ""),
            "outcome": row.detail.get("outcome", ""), "createdAt": row.created_at.isoformat(),
        }
        for row in rows
    ]


@app.post("/api/supreme/ai/test")
def supreme_ai_test(
    body: AiTestInput, _: User = Depends(owner_only), db: Session = Depends(get_db),
) -> dict[str, str]:
    if body.config is not None:
        try:
            config = normalize_ai_config(body.config)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
    else:
        config = load_ai_settings(db)[0]
    reply, _status, outcome, _message = run_chat(body.channel, body.message, config, role=body.role)
    return {"reply": reply["reply"], "outcome": outcome}


@app.get("/{file_path:path}", include_in_schema=False)
def serve_frontend(file_path: str):
    if file_path and file_path not in STATIC_FILES:
        raise HTTPException(status_code=404, detail="Not found.")
    candidate = (BASE_DIR / file_path).resolve()
    if not candidate.is_file():
        candidate = BASE_DIR / "index.html"
    return FileResponse(candidate)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("ocr_server:app", host="0.0.0.0", port=int(os.getenv("PORT", "8766")))

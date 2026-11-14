"""Clear the 2FA secret for one account so it can re-enroll an authenticator app.

Usage:
    python reset_2fa.py <mobile>            # dry run, shows the matched account
    python reset_2fa.py <mobile> --apply    # performs the reset

Uses DATABASE_URL (default: sqlite:///./rm_digital_centre.db), like ocr_server.py.
"""
import os
import sys
from datetime import datetime, timezone

from sqlalchemy import create_engine, text


def database_url() -> str:
    value = os.getenv("DATABASE_URL", "sqlite:///./rm_digital_centre.db")
    if value.startswith("postgres://"):
        return "postgresql+psycopg://" + value[len("postgres://"):]
    if value.startswith("postgresql://"):
        return "postgresql+psycopg://" + value[len("postgresql://"):]
    return value


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__)
        return 2
    mobile, apply = args[0], "--apply" in sys.argv
    engine = create_engine(database_url())
    with engine.begin() as conn:
        user = conn.execute(
            text("SELECT id, name, role, totp_enrolled FROM users WHERE mobile = :m"), {"m": mobile}
        ).first()
        if not user:
            print(f"No user with mobile {mobile}")
            return 1
        print(f"Found: {user.name} (role={user.role}, 2FA enrolled={bool(user.totp_enrolled)})")
        if not apply:
            print("Dry run. Re-run with --apply to reset.")
            return 0
        now = datetime.now(timezone.utc)
        conn.execute(
            text("UPDATE users SET totp_secret = NULL, totp_enrolled = :f, totp_last_step = 0, "
                 "updated_at = :now WHERE id = :id"),
            {"f": False, "now": now, "id": user.id},
        )
        # Staff roles can only enroll while their authorization is 'ready_for_2fa'; the owner has no such row.
        if user.role != "master":
            conn.execute(
                text("UPDATE staff_authorizations SET status = 'ready_for_2fa', updated_at = :now "
                     "WHERE mobile = :m"),
                {"now": now, "m": mobile},
            )
    print("2FA reset. Log in with your password, then scan the new QR code.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

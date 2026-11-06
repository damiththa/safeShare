from __future__ import annotations

import hashlib
import hmac
import os
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    app_public_name: str
    support_email: str
    box_client_id: str
    box_client_secret: str
    hmac_pepper: str
    gcp_project_id: str
    use_firestore: bool
    firestore_collection: str
    free_scrub_limit_per_month: int
    free_radar_fix_limit_per_month: int
    session_ttl_seconds: int = 3600


def load_settings() -> Settings:
    return Settings(
        app_public_name=os.getenv("APP_PUBLIC_NAME", "SafeShare for Box").strip(),
        # Left blank by default per owner preference; rendered on /privacy & /terms only if non-empty.
        support_email=os.getenv("SUPPORT_EMAIL", "").strip(),
        box_client_id=os.getenv("BOX_CLIENT_ID", "").strip(),
        box_client_secret=os.getenv("BOX_CLIENT_SECRET", "").strip(),
        hmac_pepper=os.getenv("HMAC_PEPPER", "").strip(),
        gcp_project_id=os.getenv("GCP_PROJECT_ID", "safeshare-box").strip(),
        use_firestore=os.getenv("USE_FIRESTORE", "true").strip().lower() in ("1", "true", "yes"),
        firestore_collection=os.getenv("FIRESTORE_COLLECTION", "safeshare_entitlements").strip(),
        free_scrub_limit_per_month=int(os.getenv("FREE_SCRUB_LIMIT", "3")),
        free_radar_fix_limit_per_month=int(os.getenv("FREE_RADAR_FIX_LIMIT", "5")),
    )


def compute_user_hash(box_user_id: str, pepper: str) -> str:
    """Irreversibly hashes numeric Box user ID so zero raw user identifiers touch Firestore."""
    if not pepper:
        raise ValueError("HMAC_PEPPER is not configured.")
    msg = f"safeshare:v1:box_user:{box_user_id}".encode("utf-8")
    return hmac.new(pepper.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def issue_session_proof(user_hash: str, pepper: str, ttl_seconds: int = 3600) -> str:
    """Creates a stateless HMAC proof so quota checks never require sending Box tokens back to Cloud Run."""
    exp = int(time.time()) + ttl_seconds
    payload = f"{user_hash}.{exp}"
    sig = hmac.new(pepper.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def verify_session_proof(proof: str, pepper: str) -> str | None:
    """Validates a stateless session proof and returns user_hash if authentic and unexpired."""
    if not proof or not pepper:
        return None
    parts = proof.split(".")
    if len(parts) != 3:
        return None
    user_hash, exp_str, provided_sig = parts
    try:
        exp = int(exp_str)
    except ValueError:
        return None
    if exp < int(time.time()):
        return None
    payload = f"{user_hash}.{exp}"
    expected_sig = hmac.new(pepper.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(provided_sig, expected_sig):
        return None
    return user_hash

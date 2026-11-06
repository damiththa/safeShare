from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.config import Settings


def current_period_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


class EntitlementStore:
    """
    Zero-PII Entitlement & Monthly Quota Store backed by GCP Firestore Native Mode.

    Entire stored schema per document (`{collection}/{user_hash}`):
      - plan: "free" | "pro"
      - period: "YYYY-MM"
      - scrub_used: int
      - radar_fixes_used: int
      - updated_at: UTC timestamp

    No emails, names, filenames, raw Box user IDs, or OAuth tokens are ever stored.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._memory_fallback: dict[str, dict[str, Any]] = {}
        self._firestore_client = None

    def _get_firestore(self):
        if not self._settings.use_firestore:
            return None
        if self._firestore_client is None:
            from google.cloud import firestore  # Lazy import for fast startup
            self._firestore_client = firestore.AsyncClient(project=self._settings.gcp_project_id)
        return self._firestore_client

    def _format_response(self, record: dict[str, Any]) -> dict[str, Any]:
        plan = record.get("plan", "free")
        scrub_used = int(record.get("scrub_used", 0))
        radar_used = int(record.get("radar_fixes_used", 0))
        scrub_limit = None if plan == "pro" else self._settings.free_scrub_limit_per_month
        radar_limit = None if plan == "pro" else self._settings.free_radar_fix_limit_per_month
        return {
            "plan": plan,
            "period": record.get("period", current_period_utc()),
            "scrub_used": scrub_used,
            "scrub_limit": scrub_limit,
            "scrub_remaining": None if scrub_limit is None else max(0, scrub_limit - scrub_used),
            "radar_fixes_used": radar_used,
            "radar_fixes_limit": radar_limit,
            "radar_fixes_remaining": None if radar_limit is None else max(0, radar_limit - radar_used),
        }

    async def get_status(self, user_hash: str) -> dict[str, Any]:
        period = current_period_utc()
        db = self._get_firestore()
        if db is None:
            rec = self._memory_fallback.get(user_hash)
            if not rec or rec.get("period") != period:
                rec = {
                    "plan": rec.get("plan", "free") if rec else "free",
                    "period": period,
                    "scrub_used": 0,
                    "radar_fixes_used": 0,
                }
                self._memory_fallback[user_hash] = rec
            return self._format_response(rec)

        doc_ref = db.collection(self._settings.firestore_collection).document(user_hash)
        snap = await doc_ref.get()
        if not snap.exists:
            init_data = {
                "plan": "free",
                "period": period,
                "scrub_used": 0,
                "radar_fixes_used": 0,
                "updated_at": datetime.now(timezone.utc),
            }
            await doc_ref.set(init_data)
            return self._format_response(init_data)

        data = snap.to_dict() or {}
        if data.get("period") != period:
            data["period"] = period
            data["scrub_used"] = 0
            data["radar_fixes_used"] = 0
            data["updated_at"] = datetime.now(timezone.utc)
            await doc_ref.set(data, merge=True)
        return self._format_response(data)

    async def consume_quota(self, user_hash: str, action: str, units: int = 1) -> tuple[bool, dict[str, Any]]:
        """
        Atomically checks and consumes quota for `action` ('scrub' or 'radar_fix').
        Returns (allowed: bool, updated_status: dict).
        """
        if action not in ("scrub", "radar_fix"):
            raise ValueError("Invalid quota action.")
        units = max(1, min(units, 500))
        period = current_period_utc()
        field_name = "scrub_used" if action == "scrub" else "radar_fixes_used"
        limit = (
            self._settings.free_scrub_limit_per_month
            if action == "scrub"
            else self._settings.free_radar_fix_limit_per_month
        )

        db = self._get_firestore()
        if db is None:
            status = await self.get_status(user_hash)
            rec = self._memory_fallback[user_hash]
            if rec.get("plan") == "pro":
                rec[field_name] = int(rec.get(field_name, 0)) + units
                return True, self._format_response(rec)
            current_val = int(rec.get(field_name, 0))
            if current_val + units > limit:
                return False, status
            rec[field_name] = current_val + units
            return True, self._format_response(rec)

        from google.cloud import firestore

        doc_ref = db.collection(self._settings.firestore_collection).document(user_hash)

        @firestore.async_transactional
        async def _txn_consume(transaction):
            snap = await doc_ref.get(transaction=transaction)
            data = snap.to_dict() if snap.exists else {}
            plan = data.get("plan", "free")
            scrub_used = int(data.get("scrub_used", 0))
            radar_used = int(data.get("radar_fixes_used", 0))
            if data.get("period") != period:
                scrub_used = 0
                radar_used = 0

            current_val = scrub_used if action == "scrub" else radar_used
            if plan != "pro" and (current_val + units > limit):
                return False, {
                    "plan": plan,
                    "period": period,
                    "scrub_used": scrub_used,
                    "radar_fixes_used": radar_used,
                }

            if action == "scrub":
                scrub_used += units
            else:
                radar_used += units

            updated = {
                "plan": plan,
                "period": period,
                "scrub_used": scrub_used,
                "radar_fixes_used": radar_used,
                "updated_at": datetime.now(timezone.utc),
            }
            transaction.set(doc_ref, updated, merge=True)
            return True, updated

        txn = db.transaction()
        allowed, updated_record = await _txn_consume(txn)
        return allowed, self._format_response(updated_record)

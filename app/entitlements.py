from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.config import Settings


def current_period_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


class EntitlementStore:
    """
    Zero-PII Entitlement & Monthly Comparison Quota Store backed by GCP Firestore Native Mode.

    Entire stored schema per document (`boxdiff_entitlements/{user_hash}`):
      - plan: "free" | "pro"
      - period: "YYYY-MM"
      - diffs_used: int
      - updated_at: UTC timestamp

    Zero emails, names, filenames, file bytes, or OAuth tokens are ever stored.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._memory_fallback: dict[str, dict[str, Any]] = {}
        self._firestore_client = None

    def _get_firestore(self):
        if not self._settings.use_firestore:
            return None
        if self._firestore_client is None:
            from google.cloud import firestore  # Lazy import for fast cold-start
            self._firestore_client = firestore.AsyncClient(project=self._settings.gcp_project_id)
        return self._firestore_client

    def _format_response(self, record: dict[str, Any]) -> dict[str, Any]:
        plan = record.get("plan", "free")
        diffs_used = int(record.get("diffs_used", 0))
        diffs_limit = None if plan == "pro" else self._settings.free_diff_limit_per_month
        return {
            "plan": plan,
            "period": record.get("period", current_period_utc()),
            "diffs_used": diffs_used,
            "diffs_limit": diffs_limit,
            "diffs_remaining": None if diffs_limit is None else max(0, diffs_limit - diffs_used),
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
                    "diffs_used": 0,
                }
                self._memory_fallback[user_hash] = rec
            return self._format_response(rec)

        doc_ref = db.collection(self._settings.firestore_collection).document(user_hash)
        snap = await doc_ref.get()
        if not snap.exists:
            init_data = {
                "plan": "free",
                "period": period,
                "diffs_used": 0,
                "updated_at": datetime.now(timezone.utc),
            }
            await doc_ref.set(init_data)
            return self._format_response(init_data)

        data = snap.to_dict() or {}
        if data.get("period") != period:
            data["period"] = period
            data["diffs_used"] = 0
            data["updated_at"] = datetime.now(timezone.utc)
            await doc_ref.set(data, merge=True)
        return self._format_response(data)

    async def consume_quota(self, user_hash: str, units: int = 1) -> tuple[bool, dict[str, Any]]:
        units = max(1, min(units, 100))
        period = current_period_utc()
        limit = self._settings.free_diff_limit_per_month

        db = self._get_firestore()
        if db is None:
            status = await self.get_status(user_hash)
            rec = self._memory_fallback[user_hash]
            if rec.get("plan") == "pro":
                rec["diffs_used"] = int(rec.get("diffs_used", 0)) + units
                return True, self._format_response(rec)
            current_val = int(rec.get("diffs_used", 0))
            if current_val + units > limit:
                return False, status
            rec["diffs_used"] = current_val + units
            return True, self._format_response(rec)

        from google.cloud import firestore

        doc_ref = db.collection(self._settings.firestore_collection).document(user_hash)

        @firestore.async_transactional
        async def _txn_consume(transaction):
            snap = await doc_ref.get(transaction=transaction)
            data = snap.to_dict() if snap.exists else {}
            plan = data.get("plan", "free")
            diffs_used = int(data.get("diffs_used", 0))
            if data.get("period") != period:
                diffs_used = 0

            if plan != "pro" and (diffs_used + units > limit):
                return False, {
                    "plan": plan,
                    "period": period,
                    "diffs_used": diffs_used,
                }

            diffs_used += units
            updated = {
                "plan": plan,
                "period": period,
                "diffs_used": diffs_used,
                "updated_at": datetime.now(timezone.utc),
            }
            transaction.set(doc_ref, updated, merge=True)
            return True, updated

        txn = db.transaction()
        allowed, updated_record = await _txn_consume(txn)
        return allowed, self._format_response(updated_record)

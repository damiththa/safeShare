from __future__ import annotations

from urllib.parse import urlencode
import httpx

from app.config import Settings

BOX_TOKEN_URL = "https://api.box.com/oauth2/token"
BOX_AUTHORIZE_URL = "https://account.box.com/api/oauth2/authorize"
BOX_USERS_ME_URL = "https://api.box.com/2.0/users/me"


def build_box_authorize_url(settings: Settings, redirect_uri: str, state: str) -> str:
    params = {
        "response_type": "code",
        "client_id": settings.box_client_id,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    return f"{BOX_AUTHORIZE_URL}?{urlencode(params)}"


async def _do_box_code_exchange(
    client: httpx.AsyncClient,
    payload: dict[str, str],
) -> dict[str, str | int]:
    token_resp = await client.post(BOX_TOKEN_URL, data=payload)
    if token_resp.status_code != 200:
        raise ValueError("Box OAuth code exchange failed or expired. Please relaunch from Box.")

    token_json = token_resp.json()
    access_token = token_json.get("access_token", "")
    expires_in = int(token_json.get("expires_in", 3600))
    if not access_token:
        raise ValueError("Box did not return an access token.")

    # Request ONLY numeric `id` — zero personal name or email ever enters Cloud Run memory.
    me_resp = await client.get(
        BOX_USERS_ME_URL,
        params={"fields": "id"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    if me_resp.status_code != 200:
        raise ValueError("Unable to verify Box session identity.")

    box_user_id = str(me_resp.json().get("id", "")).strip()
    if not box_user_id:
        raise ValueError("Missing numeric Box user ID.")

    # Note: refresh_token returned by Box is intentionally discarded and never stored.
    return {
        "access_token": access_token,
        "expires_in": expires_in,
        "box_user_id": box_user_id,
    }


async def exchange_auth_code_stateless(
    settings: Settings,
    auth_code: str,
    redirect_uri: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, str | int]:
    """
    Exchanges a short-lived Box OAuth 2.0 `auth_code` in memory, fetches ONLY the numeric
    `id` from `/users/me?fields=id` (never fetching name or email on the server), and returns
    the short-lived access_token to the caller's browser session without persisting anything.
    """
    if not settings.box_client_id or not settings.box_client_secret:
        raise RuntimeError("Box OAuth credentials are not configured in Secret Manager.")

    payload: dict[str, str] = {
        "grant_type": "authorization_code",
        "code": auth_code,
        "client_id": settings.box_client_id,
        "client_secret": settings.box_client_secret,
    }
    if redirect_uri:
        payload["redirect_uri"] = redirect_uri

    if http_client is not None:
        return await _do_box_code_exchange(http_client, payload)

    async with httpx.AsyncClient(timeout=15.0) as temp_client:
        return await _do_box_code_exchange(temp_client, payload)

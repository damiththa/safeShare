from __future__ import annotations

from contextlib import asynccontextmanager
import html
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import httpx
from pydantic import BaseModel, Field

from app.box_oauth import build_box_authorize_url, exchange_auth_code_stateless
from app.config import (
    compute_user_hash,
    issue_session_proof,
    load_settings,
    verify_session_proof,
)
from app.entitlements import EntitlementStore

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

settings = load_settings()
entitlements = EntitlementStore(settings)


@asynccontextmanager
async def lifespan(app_instance: FastAPI):
    entitlements.warm_up()
    limits = httpx.Limits(max_keepalive_connections=20, max_connections=50)
    async with httpx.AsyncClient(timeout=15.0, limits=limits) as shared_http:
        app_instance.state.http_client = shared_http
        yield


app = FastAPI(
    title="SafeShare for Box",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)
app.add_middleware(GZipMiddleware, minimum_size=500)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    # Allow Box Web App popup modal (`<iframe>`) embedding while blocking third-party clickjacking.
    csp = (
        "default-src 'self'; "
        "script-src 'self' 'wasm-unsafe-eval'; "
        "worker-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self' data:; "
        "img-src 'self' blob: data:; "
        "connect-src 'self' blob: data: https://api.box.com https://upload.box.com https://*.boxcloud.com https://*.box.com; "
        "frame-ancestors 'self' https://*.box.com https://*.app.box.com https://box.com;"
    )
    response.headers["Content-Security-Policy"] = csp
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
    elif request.url.path.startswith("/static/vendor/") or (
        request.url.path.startswith("/static/") and "v" in request.query_params
    ):
        response.headers["Cache-Control"] = "public, max-age=86400"
    else:
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


class OAuthExchangeRequest(BaseModel):
    auth_code: str = Field(..., min_length=4, max_length=512)
    redirect_uri: str | None = Field(default=None, max_length=512)


class QuotaStatusRequest(BaseModel):
    session_proof: str = Field(..., min_length=16, max_length=512)


class QuotaConsumeRequest(BaseModel):
    session_proof: str = Field(..., min_length=16, max_length=512)
    action: str = Field(..., pattern="^(scrub|radar_fix)$")
    units: int = Field(default=1, ge=1, le=500)


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "zero_pii": True}


@app.get("/api/public-config")
async def public_config(request: Request):
    origin = f"{request.headers.get('x-forwarded-proto', request.url.scheme)}://{request.headers.get('host', request.url.netloc)}"
    redirect_uri = f"{origin}/callback"
    return {
        "app_name": settings.app_public_name,
        "oauth_configured": bool(settings.box_client_id and settings.box_client_secret and settings.hmac_pepper),
        "authorize_base_ready": bool(settings.box_client_id),
        "redirect_uri": redirect_uri,
        "authorize_url_template": build_box_authorize_url(settings, redirect_uri, "standalone") if settings.box_client_id else "",
    }


@app.post("/api/oauth/exchange")
async def api_oauth_exchange(body: OAuthExchangeRequest, request: Request):
    try:
        box_session = await exchange_auth_code_stateless(
            settings=settings,
            auth_code=body.auth_code,
            redirect_uri=body.redirect_uri,
            http_client=getattr(request.app.state, "http_client", None),
        )
        user_hash = compute_user_hash(str(box_session["box_user_id"]), settings.hmac_pepper)
        quota_status = await entitlements.get_status(user_hash)
        session_proof = issue_session_proof(user_hash, settings.hmac_pepper, settings.session_ttl_seconds)
        return JSONResponse(
            {
                "access_token": box_session["access_token"],
                "expires_in": box_session["expires_in"],
                "session_proof": session_proof,
                "entitlement": quota_status,
            }
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/entitlement/status")
async def api_entitlement_status(body: QuotaStatusRequest):
    user_hash = verify_session_proof(body.session_proof, settings.hmac_pepper)
    if not user_hash:
        raise HTTPException(status_code=401, detail="Session proof expired or invalid.")
    status = await entitlements.get_status(user_hash)
    return {"entitlement": status}


@app.post("/api/entitlement/consume")
async def api_entitlement_consume(body: QuotaConsumeRequest):
    user_hash = verify_session_proof(body.session_proof, settings.hmac_pepper)
    if not user_hash:
        raise HTTPException(status_code=401, detail="Session proof expired or invalid.")
    allowed, status = await entitlements.consume_quota(user_hash, body.action, body.units)
    if not allowed:
        return JSONResponse(
            status_code=402,
            content={
                "allowed": False,
                "message": "Monthly Free tier limit reached. Upgrade to SafeShare Pro for unlimited access.",
                "entitlement": status,
            },
        )
    return {"allowed": True, "entitlement": status}


@app.get("/callback")
async def oauth_redirect_callback(code: str = "", state: str = ""):
    """Handles standalone OAuth 2.0 redirect flow (e.g., from Box App Center 'Add' button)."""
    fragment = urlencode({"auth_code": code, "state": state, "from_callback": "1"})
    return RedirectResponse(url=f"/#{fragment}", status_code=302)


@app.post("/launch")
async def box_post_launch(
    auth_code: str = Form(default=""),
    file_id: str = Form(default=""),
    folder_id: str = Form(default=""),
    mode: str = Form(default=""),
    redirect_to_box_url: str = Form(default=""),
):
    """Supports POST callback mode from Box Web App Integrations in addition to GET mode."""
    params = {
        k: v
        for k, v in {
            "auth_code": auth_code,
            "file_id": file_id,
            "folder_id": folder_id,
            "mode": mode,
            "return_url": redirect_to_box_url,
        }.items()
        if v
    }
    return RedirectResponse(url=f"/#{urlencode(params)}", status_code=303)


@app.api_route("/launch", methods=["GET", "HEAD"])
async def box_get_launch():
    return FileResponse(STATIC_DIR / "index.html")


def _render_legal_page(template_name: str) -> HTMLResponse:
    raw_html = (STATIC_DIR / template_name).read_text(encoding="utf-8")
    app_name = html.escape(settings.app_public_name)
    if settings.support_email:
        email_esc = html.escape(settings.support_email)
        contact_block = (
            f'<p class="contact-line">Questions or support inquiries: '
            f'<a href="mailto:{email_esc}">{email_esc}</a></p>'
        )
    else:
        contact_block = ""
    rendered = raw_html.replace("{{APP_NAME}}", app_name).replace("{{CONTACT_BLOCK}}", contact_block)
    return HTMLResponse(content=rendered)


@app.api_route("/privacy", methods=["GET", "HEAD"])
async def privacy_policy():
    return _render_legal_page("privacy.html")


@app.api_route("/terms", methods=["GET", "HEAD"])
async def terms_of_service():
    return _render_legal_page("terms.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.api_route("/", methods=["GET", "HEAD"])
async def index():
    return FileResponse(STATIC_DIR / "index.html")

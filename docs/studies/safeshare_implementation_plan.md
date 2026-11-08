# `SafeShare for Box` — Direct-to-GCP v1 Implementation Plan

## 1. Zero-Local-Footprint, 100% Direct-to-GCP Setup

Per your instructions:
* **Single Source Folder Only:** Code lives exclusively in `/Users/madushan/GitStuff/safeshare-box` (the temporary scratch folder has been deleted). **Zero Python virtual environments, zero packages, zero local servers, and zero `.env` secrets will ever be created on your Mac.**
* **Everything Builds, Runs & Stores Secrets Directly in GCP:**
  1. **GCP Cloud Build + Artifact Registry:** Builds our container remotely in Google Cloud directly from `/Users/madushan/GitStuff/safeshare-box`.
  2. **GCP Secret Manager:** Holds `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`, and `HMAC_PEPPER` strictly inside GCP—injected directly into Cloud Run memory at runtime.
  3. **GCP Firestore (Native Mode):** Holds only anonymous `{ user_hash, plan, period, usage_count }` entitlement records.
  4. **GCP Cloud Run (`https://safeshare-...run.app`):** Gives us a live managed `https://` URL immediately—meaning we skip `localhost` completely and connect straight into **Box's real in-page Popup Modal (`<iframe>`)** right-click menus from Day 1!

---

## 2. Project Directory Layout (`/Users/madushan/GitStuff/safeshare-box`)

```text
/Users/madushan/GitStuff/safeshare-box/
├── .gitignore                   # Ensures zero secrets or local artifacts ever enter git
├── Dockerfile                   # Clean Python 3.12-slim container built remotely by GCP Cloud Build
├── requirements.txt             # FastAPI + uvicorn + httpx + google-cloud-firestore
├── app/
│   ├── main.py                  # FastAPI app, Box iframe CSP headers & static routes
│   ├── config.py                # Reads env vars injected by GCP Secret Manager
│   ├── box_oauth.py             # Stateless Box OAuth code exchange (0 token storage)
│   └── entitlements.py          # Firestore Native Mode anonymous user_hash quota manager
├── static/
│   ├── index.html               # Unified SafeShare Modal UI (Scrub & Redact + ShareRadar)
│   ├── privacy.html             # Box App Center compliant Zero-PII Privacy Policy
│   ├── terms.html               # Terms of Service page
│   ├── css/styles.css           # Adaptive Box-native styling
│   └── js/
│       ├── app.js               # Box modal OAuth bootstrap (#auth_code#, #file_id#, #folder_id#)
│       ├── box_client.js        # Direct browser <-> api.box.com & upload.box.com CORS client
│       ├── metadata_xray.js     # Image EXIF/GPS, PDF /Info & XMP, DOCX XML/comments inspector
│       ├── pii_detector.js      # Regex + Luhn/ABA/Mod97 checksums + filename-PII detector
│       ├── redactor_engine.js   # True 300-DPI bitmap pixel burn + clean pdf-lib / DOCX rebuild
│       └── shareradar_engine.js # Recursive folder scanner, Opens/Downloads/+Delta snapshot & bulk fix
└── marketplace/
    ├── listing_copy.md          # Ready-to-paste Box App Center copy & exact callback URLs
    └── icon.svg                 # 512x512 SafeShare App Icon
```

---

## 3. Execution Sequence

1. **You Complete Box App Creation + GCP Project & Secret Manager Setup** *(walkthrough provided in chat)*.
2. **I Write the Complete `SafeShare v1` Codebase** inside `/Users/madushan/GitStuff/safeshare-box`.
3. **First Direct-to-GCP Deploy (`gcloud run deploy`):**
   * Cloud Build packages `/Users/madushan/GitStuff/safeshare-box` remotely in GCP, wires up the 3 secrets from **Secret Manager**, and gives us our live `https://safeshare-...run.app` URL.
4. **Paste Our Live `https://...run.app` URL Into Box Developer Console:**
   * Add our Cloud Run URL to Box **OAuth Redirect URI**, **CORS Domains**, and the **2 Web App Integrations** (*File: Scrub & Redact* and *Folder: ShareRadar Audit*).
5. **Live Testing Inside `app.box.com`:**
   * Right-click real test files and folders inside your Box account and test the end-to-end modal experience live on GCP!

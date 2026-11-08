# SafeShare for Box (`https://github.com/damiththa/safeShare.git`)

**SafeShare for Box** is a 2-in-1 **Zero-PII Box Web App Integration** that runs file metadata scrubbing, byte-destructive PDF/image redaction, and recursive folder Shared Link / external-guest auditing **100% inside the user's browser memory**—backed by a stateless **Google Cloud Run** + **Firestore Native** quota service in `us-central1`.

- 🏛️ **[Process & System Architecture — Archify v3.0 Diagram (`docs/ARCHITECTURE.md`)](./docs/ARCHITECTURE.md)**
- 📌 **[Parked Roadmap, Feature Enhancements & Guardrails (`docs/PARKED_ROADMAP_AND_REMINDERS.md`)](./docs/PARKED_ROADMAP_AND_REMINDERS.md)**
- 📦 **[Box App Center Configuration & Listing Copy (`marketplace/listing_copy.md`)](./marketplace/listing_copy.md)**

---

## Process & System Architecture (Rendered via Archify v3.0)

[![SafeShare Archify Process & System Architecture](./docs/architecture/safeshare-architecture.svg)](./docs/ARCHITECTURE.md)

> **Interactive Archify Viewer:** Open [`docs/architecture/safeshare-architecture.html`](./docs/architecture/safeshare-architecture.html) (compiled automatically in GitHub Actions via [`tt-a1i/archify`](https://github.com/tt-a1i/archify)) for interactive pan/zoom, guided process traces, and clickable GitHub file/line citations.

---

## Core Capabilities (`v1`)

1. **File Integration — `Scrub & Redact with SafeShare` (`.pdf`, `.jpg`, `.jpeg`, `.png`, `.webp`, `.docx`):**
   - **Automatic File Header Wipe:** Detects and completely strips hidden EXIF GPS coordinates, camera/lens serial numbers, embedded EXIF preview thumbnails, PDF `/Info` + Adobe XMP/PieceInfo streams, and Word `core.xml` / `app.xml` / `custom.xml` / reviewer comments (`0` hidden properties left behind on save).
   - **1-Click PII & HIPAA Safe Harbor PHI Studio + Lazy Wasm OCR:** Pre-identifies 17+ PII, Financial, and HIPAA PHI patterns (Medicare MBI, NPI, DEA, MRN, ICD-10, clinical dates, SSN, Luhn cards, IBAN, ABA routing, emails, phones, addresses) as see-through page highlights—toggle 1-by-1 right on the canvas, click **`Black Out All`**, or drag custom blackout boxes. Lazily loads in-browser `Tesseract.js` Wasm OCR *only* when opening images or scanned PDF pages.
   - **Byte-Destructive Export & Flexible Box Save:** Rasterizes redacted PDF pages at **250 DPI** with permanent `#000000` pixel burns (or scrubs Word `<w:t>` XML runs with `█` blocks), supports both **`Save as new copy`** (`_Clean`, zero Box Version History) and **`Replace original`** (plus automatic fallback for single-file Box scopes), and includes 1-click **`View Saved File`** verification.
2. **Folder Integration — `Audit Links & Guests (SafeShare)` (`ShareRadar`):**
   - **9 Sharing & Collaborator Telemetry Metrics (0 File Bytes Downloaded):** Surfaces `preview_count` (**Opens**), `download_count` (**Downloads**), `can_download`/`can_edit` flags, `effective_access`, `is_password_enabled`, `unshared_at` countdown vs `Never Expires`, dormancy age, external guest tenure in days, and **`+Δ` new opens/downloads** diffed against `_safeshare_radar_snapshot.json` stored inside the **user's own Box folder**.
   - **1-Click Bulk Remediation:** Bulk Revoke Links, Force View-Only, Stamp 30-Day Expiration, Remove External Collaborators, and export Audit CSV directly to Box.

---

## Strict Privacy, Performance & Operational Guardrails

- **Zero PII on GCP:** Zero file contents, filenames, emails, names, Shared Links, or Box OAuth tokens are ever stored or logged (`uvicorn --no-access-log`, `--min-instances=0`). Firestore (`safeshare_entitlements`) stores strictly `{ plan, period, scrub_used, radar_fixes_used, updated_at }` keyed by irreversible `HMAC_SHA256(HMAC_PEPPER, numeric_box_user_id)`—and quota is consumed *only* after Box confirms a successful save.
- **Zero Third-Party Runtime CDNs & Fast Load:** Permissive `MIT` / `Apache-2.0` browser libraries (`pdf-lib`, `pdf.js`, `exifr`, `JSZip`, and lazy-loaded `Tesseract.js`) are self-hosted in `/app/static/vendor/` (`script-src 'self' 'wasm-unsafe-eval'`), served with `defer` + `GZipMiddleware` + 24h versioned asset caching, parallel Box launch/download streams, and instant Page 1 PDF rendering.
- **Cloud-Only Builds & Owner-Gated Deployments:** Zero local runtime execution; **explicit owner confirmation is required before running any GCP Cloud Run deployment (`gcloud run deploy`).**

---

## Repository Structure

```text
safeShare/
├── app/
│   ├── main.py                        # Lifespan HTTP/gRPC warm-up, GZip, CSP & launch routes
│   ├── box_oauth.py                   # Stateless keep-alive Box auth_code exchange (/users/me?fields=id)
│   ├── entitlements.py                # Zero-PII Firestore Native monthly quota transactions (Free vs Pro)
│   └── config.py                      # Secret Manager env loader, HMAC user hashing & stateless session proofs
├── static/
│   ├── index.html                     # Deferred-vendor (<100ms paint) Clean, Redact & ShareRadar SPA
│   ├── privacy.html                   # Zero-retention Privacy Policy template
│   ├── terms.html                     # Terms of Service template
│   ├── css/styles.css                 # Calm daylight Box-native UI stylesheet, floating toasts & inline alerts
│   └── js/
│       ├── app.js                     # Parallel launch router, post-upload quota & 1-click saved-file verifier
│       ├── box_client.js              # Browser CORS Box SDK (no-store 302 stream, _Clean v1 & version replace)
│       ├── metadata_xray.js           # EXIF/GPS/Thumbnail, PDF /Info+XMP & DOCX XML metadata inspector
│       ├── pii_detector.js            # Line-stitched 17+ PII, Financial & HIPAA PHI detector engine
│       ├── ocr_engine.js              # Lazy-loaded in-browser Tesseract.js v5 Wasm OCR worker
│       ├── redactor_engine.js         # Interactive highlighter, full /Info+XMP wipe & 250-DPI pixel burner
│       └── shareradar_engine.js       # 9-metric ShareRadar auditor, +Δ snapshot diff & bulk remediation
├── docs/
│   ├── ARCHITECTURE.md                # Archify v3.0 System & Process Architecture walkthrough
│   ├── PARKED_ROADMAP_AND_REMINDERS.md# Deployment gate rules, single-folder rule & Pro tier roadmap
│   ├── architecture/                  # Archify v3.0 JSON spec + compiled GitHub SVG & interactive HTML
│   └── studies/                       # Marketplace research, PII/PHI feasibility study, specs & UI mocks
├── samples/
│   └── Sample_Patient_Intake_415-555-0194.pdf # Synthetic PII/PHI + hidden header metadata test file
├── marketplace/
│   ├── icon.svg                       # SafeShare 512x512 vector app icon
│   └── listing_copy.md                # Exact Box Developer Console & App Center configuration copy
├── scripts/
│   └── render_archify.py              # Cloud-executed Archify v3.0 evidence verifier & SVG/HTML compiler
├── .github/workflows/
│   └── archify.yml                    # GitHub Actions CI for Archify v3.0 verification & rendering
├── .env.example                       # Non-secret environment variable & Secret Manager reference template
├── Dockerfile                         # GCP Cloud Build image (vendors browser Wasm/JS & runs non-root Uvicorn)
└── requirements.txt
```

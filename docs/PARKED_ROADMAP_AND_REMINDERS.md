# SafeShare for Box — Parked Roadmap, Feature Enhancements & Guardrails

> **Purpose:** Single source of truth tracked in Git (`https://github.com/damiththa/safeShare.git`) for locked-in operational rules, Zero-PII security guardrails, and post-`v1` feature enhancements.

---

## 1. Operational & Deployment Guardrails (Mandatory)

- [x] **Explicit Owner Approval Before Every Deployment:** **Always check with the repository owner and obtain explicit confirmation BEFORE executing any GCP Cloud Run deployment (`gcloud run deploy`).** Never auto-deploy unprompted.
- [x] **100% Cloud Execution (Zero Local Compute):** Never run local Python servers, virtual environments, npm/Node installs, Docker builds, or `.env` secrets on the local machine. Container builds execute exclusively in **GCP Cloud Build** (`us-central1`) and Archify diagram compilation executes in **GitHub Actions** (`ubuntu-latest`).
- [x] **Single Local Project Folder (Everything Together):** `/Users/madushan/GitStuff/safeshare-box` is the sole directory for **all** project-related files—including source code, feasibility studies (`docs/studies/`), architecture specs (`docs/`), UI mocks, and synthetic test files (`samples/`). Never scatter project files in `/tmp` or external folders.
- [x] **Zero-PII Cloud Guarantee:**
  - Zero file bytes, filenames, folder paths, Shared Link URLs, emails, display names, or Box OAuth tokens ever touch GCP storage or logs (`uvicorn --no-access-log`).
  - `/api/oauth/exchange` requests strictly `/2.0/users/me?fields=id` (numeric ID only—never `name` or `login`), hashes it irreversibly via `HMAC_SHA256(HMAC_PEPPER, numeric_box_user_id)`, discards `refresh_token`, and returns the short-lived `access_token` solely to volatile browser RAM.
  - Firestore (`safeshare_entitlements` in `us-central1`) stores strictly `{ plan, period, scrub_used, radar_fixes_used, updated_at }` keyed by `user_hash`.
- [x] **Zero Third-Party Runtime CDNs & Permissive Licensing Only:**
  - `pdf-lib@1.17.1` (`MIT`), `pdfjs-dist@3.11.174` (`Apache-2.0`), `exifr@7.1.3` (`MIT`), `jszip@3.10.1` (`MIT`), and lazy-loaded `tesseract.js@5.1.1` (`Apache-2.0`) are vendored into `/app/static/vendor/` during GCP Cloud Build (`script-src 'self' 'wasm-unsafe-eval'`).
  - Strictly avoids `AGPL-3.0` dependencies (such as `MuPDF` / `PyMuPDF`).
- [x] **Anti-Version-History Leak Architecture (`_Clean` as `v1`):**
  - Sanitized/redacted files are always uploaded as **brand-new `v1` files (`_Clean`)** into the parent Box folder (using Box Web Integration Scope = *Parent folder of invoked file*) rather than `v2` overwrites, ensuring Box Collaborators with Editor permissions cannot download unredacted `v1` bytes from Box Version History.
- [x] **Support Contact Policy:**
  - `SUPPORT_EMAIL` defaults to `""` so `/privacy` and `/terms` display zero email addresses publicly; alias `box.developer@mdms.anonaddy.me` is reserved only if required on the Box App Center submission form.

---

## 2. `v1.1+` Feature Enhancements Backlog (Post-`v1` Roadmap)

- [ ] **Enhancement 1: Native Box Notes (`.boxnote`) Scrubbing & Clean PDF Export**
  - Files created directly inside Box via **`New + → Box Note`** use Box's ProseMirror JSON schema (`GET /2.0/files/:id/content`), which embeds internal author/collaborator user metadata inside JSON and lacks native Box PDF representations.
  - **Planned Flow (100% Browser RAM):** Parse `.boxnote` ProseMirror JSON in browser memory, surface embedded collaborator/revision metadata in Privacy X-Ray, run deterministic Auto-PII redaction (`SSN`, `Credit Card`, `ABA Routing`, `Email`, `Phone`), and render a clean, share-ready **`_SafeCopy.pdf`** via `pdf-lib` directly back into the Box folder.
- [ ] **Enhancement 2: Visual Canvas Redaction for Native & Uploaded Office Files (`.docx`, `.pptx`, `.xlsx`)**
  - Currently `v1` strips XML metadata (`core.xml`, `app.xml`, `comments.xml`) on `.docx` into `_SafeCopy.docx`.
  - **Planned Flow (Zero Server Compute via Box Representations API):** Request Box's cloud-generated `[pdf]` representation (`GET /2.0/files/:id?fields=representations` with `X-Rep-Hints: [pdf]`) for files created via **`New + → Word / Excel / PowerPoint`** (or uploaded Office docs), load the resulting PDF into `RedactorWorkspace` (`pdf.js`), allow interactive drag-to-redact + Auto-PII detection, and save a byte-flattened 250-DPI **`_SafeCopy.pdf`** to Box (`pdf,jpg,jpeg,png,webp,docx,pptx,xlsx,boxnote`).
- [x] **Enhancement 3: Pre-Identified PII & HIPAA PHI Highlighter + Lazy-Loaded Wasm OCR (`Tesseract.js`)**
  - Shipped combined Tier 1 (line-stitched PDF + `.docx` `<w:t>` block scrub + 17 PII/HIPAA PHI detectors starting as see-through highlights with 1-click **`Black Out All`** and click-on-canvas toggle) + Tier 2 (`ocr_engine.js` lazy-loading `Tesseract.js` v5 *only* on images and scanned PDF pages so normal digital PDFs download 0 OCR bytes). *Note: Monitor real-world load feel on Tier 2 OCR; modularized in `ocr_engine.js` so it can be tuned or gated cleanly.*
- [ ] **Enhancement 4: Freemium-to-Paid (`Pro`) Tier Expansion & Monetization Packaging**
  - Connect Stripe / LemonSqueezy checkout + webhook keyed strictly by anonymous `client_reference_id = user_hash` to upgrade `safeshare_entitlements/{user_hash}.plan` from `"free"` to `"pro"` without storing customer emails in Firestore (and tune `FREE_SCRUB_LIMIT=3`, `FREE_RADAR_FIX_LIMIT=5` down from beta testing defaults of `25`).
  - **High-Value Paid (`Pro`) Feature Candidates:**
    1. **Automated HIPAA PHI & Financial Pack + `Black Out All` / Scanned Image OCR** (gating 1-click bulk PHI/OCR auto-redaction or unlimited monthly saves behind `Pro`, while keeping basic metadata clean + manual blackout in `Free`).
    2. **Tier 3 In-Browser AI Deep Name & Clinical Entity Scan (`ONNX NER`):** Opt-in quantized browser NER model to catch unlabeled person/hospital names in free-flowing paragraphs.
    3. **Batch Folder Scrub & Redact:** Clean hidden metadata and auto-redact PII/PHI across an entire Box folder in one pass.
- [ ] **Enhancement 5: Popup vs. Separate Tab Evaluation & Box App Center Submission (`Publishing` Tab)**
  - Currently running in separate-tab mode (`The web integration will open in a new tab` = ON); revisit toggling OFF for floating popup mode if preferred after deeper UX testing.
  - Switch integrations from `Development` $\rightarrow$ `Online`, attach `512x512` PNG app icon + 3 live Box UI screenshots, and submit on the Box Developer Console **Publishing** tab.
- [x] **Enhancement 6: App #2 Standalone Product — `BoxDiff` (`boxdiff` Branch)**
  - Built, Archify-documented, and deployed live on `https://boxdiff-902354967061.us-central1.run.app` (`boxdiff` branch in this repository).

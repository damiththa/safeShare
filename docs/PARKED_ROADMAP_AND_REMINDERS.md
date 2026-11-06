# SafeShare for Box — Parked Roadmap, Feature Enhancements & Guardrails

> **Purpose:** Single source of truth tracked in Git (`https://github.com/damiththa/safeShare.git`) for locked-in operational rules, Zero-PII security guardrails, and post-`v1` feature enhancements.

---

## 1. Operational & Deployment Guardrails (Mandatory)

- [x] **Explicit Owner Approval Before Every Deployment:** **Always check with the repository owner and obtain explicit confirmation BEFORE executing any GCP Cloud Run deployment (`gcloud run deploy`).** Never auto-deploy unprompted.
- [x] **100% Cloud Execution (Zero Local Compute):** Never run local Python servers, virtual environments, npm/Node installs, Docker builds, or `.env` secrets on the local machine. Container builds execute exclusively in **GCP Cloud Build** (`us-central1`) and Archify diagram compilation executes in **GitHub Actions** (`ubuntu-latest`).
- [x] **Single Local Git Folder:** `/Users/madushan/GitStuff/safeshare-box` is the sole directory containing project source files on the developer machine.
- [x] **Zero-PII Cloud Guarantee:**
  - Zero file bytes, filenames, folder paths, Shared Link URLs, emails, display names, or Box OAuth tokens ever touch GCP storage or logs (`uvicorn --no-access-log`).
  - `/api/oauth/exchange` requests strictly `/2.0/users/me?fields=id` (numeric ID only—never `name` or `login`), hashes it irreversibly via `HMAC_SHA256(HMAC_PEPPER, numeric_box_user_id)`, discards `refresh_token`, and returns the short-lived `access_token` solely to volatile browser RAM.
  - Firestore (`safeshare_entitlements` in `us-central1`) stores strictly `{ plan, period, scrub_used, radar_fixes_used, updated_at }` keyed by `user_hash`.
- [x] **Zero Third-Party Runtime CDNs & Permissive Licensing Only:**
  - `pdf-lib@1.17.1` (`MIT`), `pdfjs-dist@3.11.174` (`Apache-2.0`), `exifr@7.1.3` (`MIT`), and `jszip@3.10.1` (`MIT`) are vendored into `/app/static/vendor/` during GCP Cloud Build (`script-src 'self' 'wasm-unsafe-eval'`).
  - Strictly avoids `AGPL-3.0` dependencies (such as `MuPDF` / `PyMuPDF`).
- [x] **Anti-Version-History Leak Architecture (`_SafeCopy` as `v1`):**
  - Sanitized/redacted files are always uploaded as **brand-new `v1` files (`_SafeCopy`)** into the parent Box folder (using Box Web Integration Scope = *Parent folder of invoked file*) rather than `v2` overwrites, ensuring Box Collaborators with Editor permissions cannot download unredacted `v1` bytes from Box Version History.
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
- [ ] **Enhancement 3: Optional In-Browser Wasm OCR for Scanned Documents & IDs (`Tesseract.js`)**
  - Add an opt-in browser Wasm OCR pass for flattened scans, photographed W-9s, driver's licenses, and receipts that contain no selectable PDF text layer, feeding word bounding boxes directly into `detectPiiInTextItems()`.
- [ ] **Enhancement 4: Zero-PII Pro Tier Billing Integration (`plan: "pro"`)**
  - Connect Stripe / LemonSqueezy checkout + webhook keyed strictly by anonymous `client_reference_id = user_hash` to upgrade `safeshare_entitlements/{user_hash}.plan` from `"free"` (3 scrubs & 5 bulk link fixes/month) to `"pro"` (unlimited) without storing customer emails in Firestore.
- [ ] **Enhancement 5: Box App Center Public Marketplace Submission (`Publishing` Tab)**
  - Switch both Box Web Integrations (`Scrub & Redact with SafeShare` and `Audit Links & Guests (SafeShare)`) from `Development` $\rightarrow$ `Online`, attach `512x512` PNG app icon + 3 live Box UI screenshots, and submit on the Box Developer Console **Publishing** tab.
- [ ] **Enhancement 6: App #2 Standalone Product — `BoxDiff` (Visual & Semantic File/Version Diff)**
  - Build and list `BoxDiff` as a separate focused Freemium Box Web App Integration (`Diff Against Another Version/File`) for pixel + text PDF diffs, `.docx` redlines, and multi-sheet `.xlsx`/`.csv` formula & cell diffs on the same Zero-PII browser Wasm stack.

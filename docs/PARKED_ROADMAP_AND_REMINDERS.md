# BoxDiff for Box — Parked Roadmap, Feature Enhancements & Guardrails

> **Purpose:** Single source of truth tracked on the `boxdiff` branch (`https://github.com/damiththa/safeShare/tree/boxdiff`) for locked-in operational rules, Zero-PII security guardrails, and post-`v1` feature enhancements.

---

## 1. Operational & Deployment Guardrails (Mandatory)

- [x] **Explicit Owner Approval Before Every Deployment:** **Always check with the repository owner and obtain explicit confirmation BEFORE executing any GCP Cloud Run deployment (`gcloud run deploy`).** Never auto-deploy unprompted.
- [x] **100% Cloud Execution (Zero Local Compute):** Never run local Python servers, virtual environments, npm/Node installs, Docker builds, or `.env` secrets on the local machine. Container builds execute exclusively in **GCP Cloud Build** (`us-central1`) and Archify diagram compilation executes in **GitHub Actions** (`ubuntu-latest`).
- [x] **Shared GCP Project & Repository, Isolated Service & Branch:**
  - **GitHub Repo:** `https://github.com/damiththa/safeShare.git` (`boxdiff` branch; `SafeShare` lives on `main`).
  - **GCP Project:** `safeshare-box` (`#902354967061`, `us-central1`).
  - **Cloud Run Service:** `boxdiff` (`https://boxdiff-902354967061.us-central1.run.app`).
  - **Secret Manager Secrets:** `BOXDIFF_CLIENT_ID`, `BOXDIFF_CLIENT_SECRET`, `HMAC_PEPPER`.
  - **Firestore Collection:** `boxdiff_entitlements` (domain-separated HMAC prefix `boxdiff:v1:box_user:`).
- [x] **100% Browser-Only `v1` Zero-PII Guarantee:**
  - Zero file bytes, version diffs, filenames, emails, display names, or Box OAuth tokens ever touch GCP storage or logs (`uvicorn --no-access-log`).
  - `/api/oauth/exchange` requests strictly `/2.0/users/me?fields=id`, computes `HMAC_SHA256(HMAC_PEPPER, "boxdiff:v1:box_user:" + id)`, discards `refresh_token`, and returns the short-lived `access_token` solely to volatile browser RAM.
- [x] **Zero-CVE Permissive Client Bundle:**
  - Vendors `pdf-lib@1.17.1` (`MIT`), `pdfjs-dist@3.11.174` (`Apache-2.0`), and `jszip@3.10.1` (`MIT`) at Cloud Build time.
  - Parses `.xlsx` OpenXML worksheets (`<f>` formulas + `<v>` values) directly via `JSZip` + browser `DOMParser`, avoiding `xlsx@0.18.5` (`CVE-2023-30533`) and `AGPL` libraries.
- [x] **Support Contact Policy:**
  - `SUPPORT_EMAIL` defaults to `""` so `/privacy` and `/terms` expose zero email addresses publicly; `box.developer@mdms.anonaddy.me` is reserved strictly if required on the Box App Center submission form.

---

## 2. `v1.1+` Feature Enhancements Backlog (Post-`v1` Roadmap)

- [ ] **Enhancement 1: Opt-In Vertex AI Gemini Flash "✨ Executive Change Brief" (Pro Tier)**
  - `v1` is strictly 100% browser-only. In `v1.1+`, add an explicit user-triggered opt-in button (`/api/ai/executive-brief`) sending *only* the compact redline hunk delta (never raw files) to **GCP Vertex AI (`gemini-2.5-flash`)** under GCP's zero-data-retention / zero-training enterprise guarantee to summarize contract & financial model risk shifts in plain English.
- [ ] **Enhancement 2: Native Box Office & Presentation Visual Diffs (`.pptx`, `.docx`, `.xlsx`, `.boxnote`)**
  - Use Box's `[pdf]` Representations API (`GET /2.0/files/:id?fields=representations` with `X-Rep-Hints: [pdf]`) so slide decks (`.pptx`) and Word layouts can be visually compared in `VisualComparator` (`Curtain Slider` + `Crimson Pixel Delta`) alongside `.boxnote` ProseMirror JSON redlining.
- [ ] **Enhancement 3: In-Browser Wasm OCR for Scanned Contract Text Redlines (`Tesseract.js`)**
  - Currently `BoxDiff v1` auto-switches scanned PDFs without a text layer to **Visual Curtain & Pixel Diff**. Adding opt-in browser Wasm OCR will unlock word-level text redlines and Smart `$ / % / Date` Clause Highlights on flat scanned PDFs too.
- [ ] **Enhancement 4: Side-by-Side Folder Tree Structure & Checksum Diff**
  - Add a Folder Web Integration (`Compare Two Box Folders`) comparing directory trees by relative path and Box `sha1` checksums without downloading unchanged files (`Added`, `Missing`, `Modified` files across Deal Rooms).
- [ ] **Enhancement 5: Zero-PII Pro Tier Billing Integration (`plan: "pro"`)**
  - Connect Stripe / LemonSqueezy checkout + webhook keyed strictly by anonymous `client_reference_id = user_hash` to upgrade `boxdiff_entitlements/{user_hash}.plan` from `"free"` (5 comparisons/month) to `"pro"` (unlimited).
- [ ] **Enhancement 6: Box App Center Public Marketplace Submission (`Publishing` Tab)**
  - Switch `Compare with BoxDiff` from `Development` $\rightarrow$ `Online`, attach `512x512` PNG app icon + 3 live Box UI screenshots, and submit on the Box Developer Console **Publishing** tab.

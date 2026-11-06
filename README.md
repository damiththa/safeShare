# BoxDiff for Box (`boxdiff` Branch)

**100% Browser-Only Version History Redlines, Visual Curtain/Pixel Diffs & Excel Formula Audits for Box.com**

[![BoxDiff Archify System & Process Architecture](./docs/architecture/boxdiff-architecture.svg)](./docs/architecture/boxdiff-architecture.html)

> **Repository Branch Layout (`damiththa/safeShare`):**
> - **`main` branch:** `SafeShare for Box` (`Scrub & Redact` + `ShareRadar` Folder Link & Collaborator Auditor) — Live at `https://safeshare-902354967061.us-central1.run.app`
> - **`boxdiff` branch (this branch):** `BoxDiff for Box` (`Compare with BoxDiff` File Version & Sibling Comparator) — Target service `https://boxdiff-902354967061.us-central1.run.app`

---

## ✨ What `BoxDiff v1` Does (100% Client-Side RAM)

1. **Contract & Text Redline (`.pdf`, `.docx`, `.txt`, `.md`, `.json`, `.csv`)**
   - Patience-anchored LCS line diff + inline word-level `<del>` / `<ins>` token highlights in both **Unified Redline** and **Side-by-Side** layouts.
   - **Smart Financial, Rate, Date & Legal Clause Callouts:** Automatically detects modified `$` amounts, `%` / `bps` rates, payment terms / dates, and key legal obligations (`indemnification`, `limitation of liability`, `termination`, `auto-renewal`) with 1-click scroll-to-clause.
   - **Cross-Format Capable:** Redline a `.docx` contract draft directly against a counterparty's signed `.pdf`!

2. **Visual Split Curtain Slider & Crimson Pixel Diff (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`)**
   - Interactive draggable **Split Curtain Slider**, **Crimson Pixel-Delta Overlay** (with live threshold control), and **Side-by-Side** page view.
   - Automatic multi-page quick delta strip (`P1 0%`, `P3 2.8% Δ`, ...) so reviewers jump straight to altered pages in scanned PDFs or engineering drawings.

3. **Zero-CVE Multi-Sheet Spreadsheet & Formula Audit (`.xlsx`, `.csv`)**
   - Parses OpenXML `.xlsx` archives (`xl/workbook.xml`, `xl/sharedStrings.xml`, `xl/worksheets/sheet*.xml`) via vendored `JSZip` + browser `DOMParser`—zero `xlsx@0.18.5` prototype-pollution CVEs.
   - Audits **both** raw Excel formulas (`<f>`) and evaluated values (`<v>`), specifically alerting on **Formula $\rightarrow$ Hardcoded Value Overrides** alongside numeric `%` deltas.

4. **Version History (`v1..vN`) + Sibling File Comparison + 1-Click `Redline_Report.pdf`**
   - Auto-loads Box Version History (`GET /2.0/files/:id/versions` + active `file_version`) and auto-compares `v(N-1) -> vN`.
   - When invoked on a `v1`-only file, automatically discovers compatible sibling files in the same Box parent folder.
   - Generates a multi-page **`Redline_Report_<Name>.pdf`** in browser memory (`pdf-lib`) and uploads it straight back into the Box folder with 1-click Box Shared Link creation.

---

## 🔒 Zero-PII Security & Cloud Architecture

- **Zero File Bytes Touch GCP:** All Box downloads (`?version=...&access_token=...` CORS 302 stream) and report uploads (`upload.box.com`) flow strictly between the user's browser and Box.com.
- **Stateless OAuth + Domain-Separated HMAC Quotas:** Cloud Run (`uvicorn --no-access-log`) exchanges `auth_code`, reads only numeric Box user `id`, computes `HMAC_SHA256(HMAC_PEPPER, "boxdiff:v1:box_user:" + id)`, and tracks monthly Free (`5 diffs/month`) vs Pro (`unlimited`) usage in Firestore collection `boxdiff_entitlements`.
- **Zero External Runtime CDNs:** `pdf-lib@1.17.1`, `pdfjs-dist@3.11.174`, and `jszip@3.10.1` are vendored at Cloud Build time under strict `script-src 'self' 'wasm-unsafe-eval'` CSP.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and [`docs/PARKED_ROADMAP_AND_REMINDERS.md`](./docs/PARKED_ROADMAP_AND_REMINDERS.md) for full process flows, deployment guardrails, and the `v1.1+` roadmap.

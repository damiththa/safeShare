# BoxDiff for Box — Box Developer Console & App Center Setup Guide

## 1. Box Developer Console — `Configuration` Tab

- **App Type:** Custom App (`User Authentication (OAuth 2.0)`)
- **OAuth 2.0 Redirect URI:**
  `https://boxdiff-902354967061.us-central1.run.app/callback`
- **Application Scopes:**
  - [x] Read all files and folders stored in Box
  - [x] Write all files and folders stored in Box
- **CORS Domains:**
  `https://boxdiff-902354967061.us-central1.run.app`

---

## 2. Box Developer Console — `Box Web Integrations` Tab (1 File Integration)

- **Web Integration Name:** `Compare with BoxDiff`
- **Description:** `Compare Box Version History (v1..vN) or sibling files with word-level contract redlines, visual curtain/pixel diffs, and Excel formula audits—100% in your browser.`
- **Supported File Extensions:** *Limit support to specific file extensions*
  `pdf, docx, xlsx, csv, txt, md, json, png, jpg, jpeg, webp`
- **Permissions Requirement:** `Full permissions are required` (needed to save `Redline_Report.pdf` back to the folder)
- **Web Integration Scopes:** **`The parent folder of the file/folder from which this web integration is invoked`** *(Critical: enables both Sibling File comparison in the same folder and saving `Redline_Report.pdf` back to the folder)*
- **Box item types:** `Files`
- **Client Callback URL:** `https://boxdiff-902354967061.us-central1.run.app/launch`
- **Prompt Message:** `Open this file in BoxDiff to compare versions or redline against another file directly in your browser (zero files stored on external servers).`
- **New window settings:** Toggle ON (`The web integration will open in a new tab`)
- **Callback Parameters (`Method = Get`):**
  1. Parameter Name: `auth_code` | Parameter Value: `#auth_code#`
  2. Parameter Name: `file_id` | Parameter Value: `#file_id#`
- **Web Integration Status:** `Development` while testing, then `Online` for App Center publishing.

---

## 3. Box App Center Marketplace Listing Copy

- **App Name:** BoxDiff — Visual, Contract & Spreadsheet Diff
- **Tagline:** Instant browser-only version history redlines, visual PDF/image curtain diffs, and Excel formula audits for Box.
- **Privacy Policy URL:** `https://boxdiff-902354967061.us-central1.run.app/privacy`
- **Terms of Service URL:** `https://boxdiff-902354967061.us-central1.run.app/terms`
- **Categories:** Productivity, Legal & Compliance, Finance & Accounting

### Overview Copy
Box stores your document Version History (`v1`, `v2`, `v3`), yet spotting what silently changed between `MSA_v3.docx` and `MSA_v4_Signed.pdf`—or catching a single overwritten `=SUM()` formula inside `Q4_Budget.xlsx`—still forces teams to download files and eyeball changes manually.

**BoxDiff** adds 1-click **Compare with BoxDiff** right inside your Box right-click **Integrations** menu:
1. **Contract & Text Redline (`.pdf`, `.docx`, `.txt`, `.md`, `.json`):** Word-level additions and deletions plus automatic callout cards for modified **$ Amounts**, **% Rates**, **Dates / Payment Terms**, and **Legal Clauses**—even across `.docx` vs `.pdf`.
2. **Visual Curtain & Pixel Diff (`.pdf`, `.png`, `.jpg`, `.webp`):** Interactive split-screen curtain slider and crimson pixel-delta overlay to spot moved signatures, engineering drawing revisions, and scanned page edits.
3. **Multi-Sheet Excel Formula & Cell Audit (`.xlsx`, `.csv`):** Inspects OpenXML formulas (`<f>`) and values (`<v>`) across every worksheet and flags dangerous **Formula -> Hardcoded Value** overrides.
4. **1-Click `Redline_Report.pdf` Export to Box:** Save an executive verification PDF straight back into your Box folder and copy a Box Shared Link in one click.
5. **100% Browser-Only Zero-PII Architecture:** Every byte stays in your browser RAM communicating directly with `api.box.com` and `upload.box.com`.

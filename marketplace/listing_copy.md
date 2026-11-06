# SafeShare for Box — Box App Center Configuration & Store Copy

Live Cloud Run URL: `https://safeshare-902354967061.us-central1.run.app`

---

## 1. Box Developer Console — Configuration Tab

* **OAuth 2.0 Redirect URI:** `https://safeshare-902354967061.us-central1.run.app/callback`
* **CORS Domains:** `https://safeshare-902354967061.us-central1.run.app`
* **Application Scopes:**
  * `[x]` Read all files and folders stored in Box
  * `[x]` Write all files and folders stored in Box

---

## 2. Box Developer Console — Integrations Tab (Create 2 Web App Integrations)

### Integration #1: File Right-Click ("Scrub & Redact with SafeShare")
* **Type:** File Integration
* **Integration Name:** `Scrub & Redact with SafeShare`
* **Description:** `Strip hidden EXIF/GPS/Author leaks and burn permanent redactions into a clean _SafeCopy file.`
* **Supported File Extensions:** `pdf, jpg, jpeg, png, webp, docx`
* **Permissions Required:** `Full permissions`
* **Launch Type:** `Popup` (Modal inside Box)
* **Callback URL:** `https://safeshare-902354967061.us-central1.run.app/launch`
* **Callback Parameters (`GET`):**
  * `mode` = `scrub`
  * `file_id` = `#file_id#`
  * `auth_code` = `#auth_code#`
  * `return_url` = `#redirect_to_box_url#`

### Integration #2: Folder Right-Click ("Audit Shared Links & Guests")
* **Type:** Folder Integration
* **Integration Name:** `Audit Links & Guests (SafeShare)`
* **Description:** `Audit active Shared Links (Opens, Downloads, Expiry) and external collaborators across subfolders.`
* **Permissions Required:** `Full permissions`
* **Launch Type:** `Popup` (Modal inside Box)
* **Callback URL:** `https://safeshare-902354967061.us-central1.run.app/launch`
* **Callback Parameters (`GET`):**
  * `mode` = `radar`
  * `folder_id` = `#folder_id#`
  * `auth_code` = `#auth_code#`
  * `return_url` = `#redirect_to_box_url#`

---

## 3. Box App Center — Publishing Tab Copy

* **App Name:** SafeShare for Box
* **Tagline:** Strip hidden file metadata, burn true PDF/image redactions, and audit exposed Shared Links—100% in your browser.
* **Categories:** Security & Compliance, Productivity
* **Privacy Policy URL:** `https://safeshare-902354967061.us-central1.run.app/privacy`
* **Terms of Service URL:** `https://safeshare-902354967061.us-central1.run.app/terms`
* **Install ("Add") URL:** `https://safeshare-902354967061.us-central1.run.app/`
* **Long Description:**
  SafeShare gives everyday Box users a fast, zero-retention privacy shield before and after sharing content externally:
  1. **Privacy X-Ray & Metadata Scrubber:** Instantly detect and strip hidden GPS coordinates, camera serial numbers, embedded EXIF preview thumbnails, PDF author properties, and Word reviewer comments.
  2. **True Byte-Destructive Redaction:** Auto-detect SSNs, payment cards, bank routing numbers, phone numbers, and emails—or draw custom redaction boxes—burning blackouts permanently into pixels inside a clean `_SafeCopy` file with zero unredacted Box Version History.
  3. **ShareRadar Folder Telemetry & Bulk Cleanup:** Scan your folders in seconds to uncover forgotten "Anyone with the link" URLs, view live Opens (`preview_count`), Downloads (`download_count`), `+Δ` recent traffic spikes, and external collaborator tenure—then revoke links, force view-only, or stamp 30-day expirations in bulk.
  **100% Client-Side Privacy:** All file scrubbing, redaction, and link auditing execute directly inside your browser memory via Box CORS. Your files never touch external servers.

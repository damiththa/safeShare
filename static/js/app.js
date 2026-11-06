import { BoxBrowserClient } from "./box_client.js";
import { detectFileFormatFromBytes, runMetadataXray } from "./metadata_xray.js";
import { generateAnonymousStem, inspectFilenameForPii } from "./pii_detector.js";
import { RedactorWorkspace } from "./redactor_engine.js";
import { ShareRadarScanner } from "./shareradar_engine.js";

const state = {
  boxClient: null,
  sessionProof: null,
  entitlement: null,
  returnUrl: null,
  activeFileMeta: null,
  activeFileFormat: null,
  pickerFolderId: "0",
  pickerParentId: null,
  radarScanner: null,
  redactor: null,
};

const el = (id) => document.getElementById(id);

function showToast(message, isError = false) {
  const banner = el("toast-banner");
  banner.className = `toast ${isError ? "toast-error" : "toast-info"}`;
  el("toast-text").textContent = message;
  banner.classList.remove("hidden");
}

function hideToast() {
  el("toast-banner").classList.add("hidden");
}

function updateQuotaBadge() {
  const badge = el("quota-badge");
  if (!state.entitlement) {
    badge.classList.add("hidden");
    return;
  }
  badge.classList.remove("hidden");
  if (state.entitlement.plan === "pro") {
    badge.className = "badge badge-safe";
    badge.textContent = "SafeShare Pro • Unlimited";
  } else {
    badge.className = "badge badge-neutral";
    badge.textContent = `Free: ${state.entitlement.scrub_remaining} scrubs • ${state.entitlement.radar_fixes_remaining} link fixes left`;
  }
}

async function consumeQuotaOrWarn(action, units = 1) {
  const resp = await fetch("/api/entitlement/consume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_proof: state.sessionProof,
      action,
      units,
    }),
  });
  const data = await resp.json();
  if (data.entitlement) {
    state.entitlement = data.entitlement;
    updateQuotaBadge();
  }
  if (!resp.ok || !data.allowed) {
    showToast(data.message || "Monthly Free tier quota reached.", true);
    return false;
  }
  return true;
}

function switchTab(tabName) {
  ["scrub", "radar", "picker"].forEach((t) => {
    el(`screen-${t}`).classList.toggle("hidden", t !== tabName);
    el(`btn-tab-${t}`).classList.toggle("active", t === tabName);
  });
}

function parseLaunchParams() {
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const get = (k) => hashParams.get(k) || searchParams.get(k) || "";

  const params = {
    authCode: get("auth_code") || get("code"),
    fileId: get("file_id"),
    folderId: get("folder_id"),
    mode: get("mode"),
    returnUrl: get("return_url") || get("redirect_to_box_url"),
    fromCallback: get("from_callback") === "1",
  };

  // Scrub sensitive auth_code from browser URL bar immediately
  if (params.authCode && window.history?.replaceState) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  return params;
}

async function bootstrap() {
  el("btn-toast-close").addEventListener("click", hideToast);
  el("btn-tab-scrub").addEventListener("click", () => switchTab("scrub"));
  el("btn-tab-radar").addEventListener("click", () => switchTab("radar"));
  el("btn-tab-picker").addEventListener("click", () => {
    switchTab("picker");
    loadPickerFolder(state.pickerFolderId);
  });
  el("btn-open-picker-from-scrub").addEventListener("click", () => {
    switchTab("picker");
    loadPickerFolder(state.pickerFolderId);
  });

  state.redactor = new RedactorWorkspace(el("redactor-canvas"), renderRedactorSidebarState);
  wireScrubControls();
  wireRadarControls();
  wirePickerControls();

  const pubCfg = await fetch("/api/public-config").then((r) => r.json());
  el("btn-oauth-connect").addEventListener("click", () => {
    if (!pubCfg.authorize_url_template) {
      showToast("Box OAuth credentials are not yet configured in GCP Secret Manager.", true);
      return;
    }
    window.location.href = pubCfg.authorize_url_template;
  });

  const launch = parseLaunchParams();
  if (launch.returnUrl && /^https:\/\/([a-z0-9-]+\.)*(box\.com|app\.box\.com)\//i.test(launch.returnUrl)) {
    state.returnUrl = launch.returnUrl;
    const btnRet = el("btn-return-box");
    btnRet.classList.remove("hidden");
    btnRet.addEventListener("click", () => {
      window.location.href = state.returnUrl;
    });
  }

  if (!launch.authCode) {
    return;
  }

  // Exchange short-lived auth_code via stateless Cloud Run endpoint
  el("connect-heading").textContent = "Establishing Zero-PII Box Session...";
  el("btn-oauth-connect").disabled = true;

  try {
    const exchResp = await fetch("/api/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_code: launch.authCode,
        redirect_uri: launch.fromCallback ? pubCfg.redirect_uri : null,
      }),
    });
    const exchData = await exchResp.json();
    if (!exchResp.ok) {
      throw new Error(exchData.detail || "Box OAuth exchange failed.");
    }

    state.boxClient = new BoxBrowserClient(exchData.access_token);
    state.sessionProof = exchData.session_proof;
    state.entitlement = exchData.entitlement;
    state.radarScanner = new ShareRadarScanner(state.boxClient);

    el("screen-connect").classList.add("hidden");
    el("main-tabs").classList.remove("hidden");
    updateQuotaBadge();

    if (launch.fileId || launch.mode === "scrub") {
      switchTab("scrub");
      if (launch.fileId) {
        await openFileInScrubber(launch.fileId);
      } else {
        el("scrub-empty-prompt").classList.remove("hidden");
      }
    } else if (launch.folderId || launch.mode === "radar") {
      switchTab("radar");
      await runRadarOnFolder(launch.folderId || "0");
    } else {
      switchTab("picker");
      await loadPickerFolder("0");
    }
  } catch (err) {
    el("connect-heading").textContent = "Connect SafeShare to Your Box Account";
    el("btn-oauth-connect").disabled = false;
    showToast(err.message || "Authentication failed.", true);
  }
}

/* ========================================================================= */
/* TAB 1: SCRUB & REDACT WORKFLOW                                            */
/* ========================================================================= */

async function openFileInScrubber(fileId) {
  hideToast();
  el("scrub-empty-prompt").classList.add("hidden");
  el("scrub-workspace").classList.remove("hidden");
  el("xray-title").textContent = "Downloading into browser RAM...";
  el("xray-list").innerHTML = "";
  el("pii-checklist").innerHTML = "";

  try {
    const meta = await state.boxClient.getFileMetadata(fileId);
    state.activeFileMeta = meta;
    if (meta.parent?.id) {
      state.pickerFolderId = String(meta.parent.id);
    }
    el("active-context-label").textContent = `File: ${meta.name}`;
    el("scrub-file-label").textContent = meta.name;

    const bytes = await state.boxClient.downloadFileBytes(fileId);
    const fmt = detectFileFormatFromBytes(bytes, meta.name);
    state.activeFileFormat = fmt;

    // Populate default output stem & check if filename itself leaks PII
    const rawStem = meta.name.replace(/\.[^.]+$/, "");
    const defaultStem = `${rawStem}_SafeCopy`;
    el("inp-output-stem").value = defaultStem;
    el("lbl-output-ext").textContent = fmt === "pdf" ? ".pdf" : fmt === "docx" ? ".docx" : fmt === "png" ? ".png" : ".jpg";
    checkFilenameWarning();

    // Run Metadata X-Ray
    const leaks = await runMetadataXray(bytes, fmt);
    const xrayCard = el("xray-card");
    const xrayList = el("xray-list");
    xrayList.innerHTML = "";

    if (leaks.length === 0) {
      xrayCard.className = "xray-box clean";
      el("xray-title").textContent = "✓ No Hidden Header Leaks Detected";
      const li = document.createElement("li");
      li.textContent = "Container will still be cleanly rebuilt on export.";
      xrayList.appendChild(li);
    } else {
      xrayCard.className = "xray-box";
      el("xray-title").textContent = `⚠️ ${leaks.length} Hidden Metadata Leak${leaks.length > 1 ? "s" : ""} Found`;
      for (const lk of leaks) {
        const li = document.createElement("li");
        li.innerHTML = `${lk.icon} <strong></strong>: <span></span>`;
        li.querySelector("strong").textContent = lk.title;
        li.querySelector("span").textContent = lk.detail;
        xrayList.appendChild(li);
      }
    }

    // Load into Redactor Canvas & run local PII scan
    await state.redactor.loadDocument(bytes, fmt);
    renderRedactorSidebarState();
  } catch (err) {
    showToast(err.message || "Failed to load file from Box.", true);
  }
}

function checkFilenameWarning() {
  const stem = el("inp-output-stem").value || "";
  const check = inspectFilenameForPii(stem);
  el("btn-anonymize-name").classList.toggle("hidden", !check.hasRisk);
}

function renderRedactorSidebarState() {
  const r = state.redactor;
  if (!r) return;

  el("page-indicator").textContent = `Page ${r.currentPage + 1} / ${r.pageCount}`;
  el("btn-prev-page").disabled = r.currentPage <= 0;
  el("btn-next-page").disabled = r.currentPage >= r.pageCount - 1;

  const totalRedactions = r.autoFindings.filter((f) => f.enabled).length + r.manualBoxes.length;
  el("pii-count-badge").textContent = `${totalRedactions} active`;

  const list = el("pii-checklist");
  list.innerHTML = "";
  if (r.autoFindings.length === 0 && r.manualBoxes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.padding = "6px 2px";
    empty.textContent =
      r.format === "docx"
        ? "Metadata-clean mode active for Word archive."
        : "No structured SSN/card/phone/email strings detected. Drag on the preview to draw custom black-out boxes.";
    list.appendChild(empty);
    return;
  }

  for (const f of r.autoFindings) {
    const row = document.createElement("label");
    row.className = "pii-item";
    const left = document.createElement("span");
    left.textContent = `${f.label} (${f.masked}) • p.${f.pageIndex + 1}`;
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = f.enabled;
    chk.addEventListener("change", () => {
      f.enabled = chk.checked;
      r.redrawOverlay();
      renderRedactorSidebarState();
    });
    row.append(left, chk);
    list.appendChild(row);
  }

  if (r.manualBoxes.length > 0) {
    const manualSummary = document.createElement("div");
    manualSummary.className = "pii-item";
    manualSummary.innerHTML = `<span>Custom Drawn Redaction Boxes (${r.manualBoxes.length})</span><span class="badge badge-safe">Active</span>`;
    list.appendChild(manualSummary);
  }
}

function wireScrubControls() {
  el("btn-prev-page").addEventListener("click", () => {
    state.redactor.renderPage(state.redactor.currentPage - 1);
    renderRedactorSidebarState();
  });
  el("btn-next-page").addEventListener("click", () => {
    state.redactor.renderPage(state.redactor.currentPage + 1);
    renderRedactorSidebarState();
  });
  el("btn-undo-box").addEventListener("click", () => state.redactor.undoLastManualBox());
  el("btn-clear-boxes").addEventListener("click", () => state.redactor.clearManualBoxes());
  el("inp-output-stem").addEventListener("input", checkFilenameWarning);
  el("btn-anonymize-name").addEventListener("click", () => {
    el("inp-output-stem").value = generateAnonymousStem();
    checkFilenameWarning();
  });

  const handleExport = async (createLinkAfter) => {
    if (!state.activeFileMeta || !state.redactor.rawBytes) return;
    const allowed = await consumeQuotaOrWarn("scrub", 1);
    if (!allowed) return;

    const btnA = el("btn-save-only");
    const btnB = el("btn-save-and-link");
    btnA.disabled = true;
    btnB.disabled = true;

    try {
      showToast("Flattening redactions & stripping metadata locally in browser...");
      const flattenAll = el("chk-flatten-all").checked;
      const result = await state.redactor.exportSanitizedBytes({ flattenAllPages: flattenAll });
      const parentId = state.activeFileMeta.parent?.id || "0";
      const stem = el("inp-output-stem").value.trim() || generateAnonymousStem();

      const uploaded = await state.boxClient.uploadNewSafeCopy(
        parentId,
        stem,
        result.extension,
        result.mimeType,
        result.bytes
      );

      if (createLinkAfter) {
        const sl = await state.boxClient.createSharedLinkForFile(uploaded.id, "open", true);
        if (sl?.url && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(sl.url).catch(() => {});
        }
        showToast(`Saved "${uploaded.name}" (clean v1) to Box! Clean Shared Link: ${sl?.url || "created"}`);
      } else {
        showToast(`Saved "${uploaded.name}" (clean v1, zero unredacted history) directly to your Box folder!`);
      }
    } catch (err) {
      showToast(err.message || "Failed to export sanitized copy.", true);
    } finally {
      btnA.disabled = false;
      btnB.disabled = false;
    }
  };

  el("btn-save-only").addEventListener("click", () => handleExport(false));
  el("btn-save-and-link").addEventListener("click", () => handleExport(true));
}

/* ========================================================================= */
/* TAB 2: SHARERADAR FOLDER TELEMETRY & BULK REMEDIATION                     */
/* ========================================================================= */

async function runRadarOnFolder(folderId) {
  hideToast();
  state.pickerFolderId = String(folderId || "0");
  el("radar-tbody").innerHTML =
    '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px;">Scanning Box folder metadata (0 file bytes downloaded)...</td></tr>';

  try {
    const folderMeta = folderId === "0" ? { id: "0", name: "All Files (Root)" } : await state.boxClient.getFolderMetadata(folderId);
    el("active-context-label").textContent = `Auditing Folder: ${folderMeta.name}`;

    await state.radarScanner.scanFolderTree(folderId, (scannedCount, riskCount) => {
      el("kpi-scan-progress").textContent = `Scanned ${scannedCount} items (${riskCount} findings)`;
    });

    refreshRadarUi();
  } catch (err) {
    showToast(err.message || "ShareRadar folder scan failed.", true);
  }
}

function refreshRadarUi() {
  const stats = state.radarScanner.getSummaryStats();
  el("kpi-open-links").textContent = `${stats.openPublicLinks} Exposed`;
  el("kpi-total-opens").textContent = `${stats.totalOpens.toLocaleString()} Opens`;
  el("kpi-total-downloads").textContent = `${stats.totalDownloads.toLocaleString()} Downloads`;
  el("kpi-external-guests").textContent = `${stats.externalGuests} Guests`;
  el("kpi-scan-progress").textContent = `${stats.totalScannedItems} items scanned • 0 file bytes downloaded`;

  if (stats.hasPriorSnapshot) {
    const snapDay = stats.priorSnapshotDate ? stats.priorSnapshotDate.slice(0, 10) : "last scan";
    el("kpi-delta-opens").textContent =
      stats.deltaOpensSum > 0 ? `🔥 +${stats.deltaOpensSum} new opens since ${snapDay}` : `No new opens since ${snapDay}`;
    el("kpi-delta-downloads").textContent =
      stats.deltaDownloadsSum > 0
        ? `🔥 +${stats.deltaDownloadsSum} new downloads since ${snapDay}`
        : `No new downloads since ${snapDay}`;
  } else {
    el("kpi-delta-opens").textContent = "Save snapshot to track +Δ new opens";
    el("kpi-delta-downloads").textContent = "Save snapshot to track +Δ downloads";
  }

  const filterMode = el("sel-radar-filter").value;
  const tbody = el("radar-tbody");
  tbody.innerHTML = "";

  const filtered = state.radarScanner.findings.filter((f) => {
    if (filterMode === "open_links") return f.kind === "shared_link" && f.accessLevel === "open";
    if (filterMode === "high_traffic") return f.kind === "shared_link" && (f.opens > 0 || f.downloads > 0);
    if (filterMode === "guests") return f.kind === "external_guest";
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px;">✓ Zero matching shared-link or external-guest exposures found in this folder tree!</td></tr>';
    return;
  }

  for (const f of filtered) {
    const tr = document.createElement("tr");

    // Checkbox cell
    const tdChk = document.createElement("td");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.className = "radar-row-chk";
    chk.dataset.findingId = f.findingId;
    chk.disabled = f.remediated;
    chk.checked = !f.remediated && f.severity === "high";
    tdChk.appendChild(chk);

    // Item & Path
    const tdItem = document.createElement("td");
    const nameStrong = document.createElement("div");
    nameStrong.style.fontWeight = "600";
    nameStrong.textContent = `${f.itemType === "folder" ? "📁 " : "📄 "}${f.name}`;
    const pathSub = document.createElement("div");
    pathSub.className = "muted";
    pathSub.textContent = f.path;
    tdItem.append(nameStrong, pathSub);

    // Exposure / Guest Role
    const tdExp = document.createElement("td");
    const expBadge = document.createElement("span");
    if (f.kind === "shared_link") {
      expBadge.className = `badge ${f.accessLevel === "open" ? "badge-danger" : "badge-warn"}`;
      expBadge.textContent = f.accessLevel === "open" ? "Anyone with link" : `Link: ${f.accessLevel}`;
      const permLine = document.createElement("div");
      permLine.className = "muted";
      permLine.style.marginTop = "3px";
      permLine.textContent = [
        f.canDownload ? "Download ON" : "View-Only",
        f.hasPassword ? "Password ON" : "No Password",
      ].join(" • ");
      tdExp.append(expBadge, permLine);
    } else {
      expBadge.className = "badge badge-warn";
      expBadge.textContent = `Guest: ${f.guestEmail}`;
      const roleLine = document.createElement("div");
      roleLine.className = "muted";
      roleLine.style.marginTop = "3px";
      roleLine.textContent = `Role: ${f.guestRole} (${f.collabStatus})`;
      tdExp.append(expBadge, roleLine);
    }

    // Opens & Downloads Telemetry
    const tdStats = document.createElement("td");
    if (f.kind === "shared_link") {
      const countsDiv = document.createElement("div");
      countsDiv.style.fontWeight = "600";
      countsDiv.textContent = `👁️ ${f.opens.toLocaleString()} Opens • ⬇️ ${f.downloads.toLocaleString()} Downloads`;
      tdStats.appendChild(countsDiv);
      if (f.deltaOpens !== null || f.deltaDownloads !== null) {
        const deltaDiv = document.createElement("div");
        const hasSpike = (f.deltaOpens || 0) > 0 || (f.deltaDownloads || 0) > 0;
        deltaDiv.className = hasSpike ? "" : "muted";
        if (hasSpike) deltaDiv.style.color = "var(--danger)";
        deltaDiv.textContent = hasSpike
          ? `🔥 +${f.deltaOpens || 0} opens / +${f.deltaDownloads || 0} downloads`
          : "No new traffic since snapshot";
        tdStats.appendChild(deltaDiv);
      }
    } else {
      tdStats.innerHTML = '<div class="muted">Direct Collaborator</div>';
    }

    // Duration Open / Dormancy
    const tdDur = document.createElement("td");
    if (f.kind === "shared_link") {
      const line1 = document.createElement("div");
      line1.textContent =
        f.trackedOpenDays !== null
          ? `Tracked open: ${f.trackedOpenDays}d`
          : `File dormant: ${f.dormantDays ?? 0}d`;
      const line2 = document.createElement("div");
      line2.className = "muted";
      line2.textContent =
        f.expiryDaysLeft !== null ? `Expires in ${f.expiryDaysLeft}d` : "♾️ Never expires";
      tdDur.append(line1, line2);
    } else {
      const line1 = document.createElement("div");
      line1.textContent = `Access held: ${f.tenureDays ?? 0} days`;
      const line2 = document.createElement("div");
      line2.className = "muted";
      line2.textContent = f.guestExpiryLeft !== null ? `Expires in ${f.guestExpiryLeft}d` : "♾️ No guest expiry";
      tdDur.append(line1, line2);
    }

    // Status
    const tdStatus = document.createElement("td");
    const stSpan = document.createElement("span");
    stSpan.className = `badge ${f.remediated ? "badge-safe" : f.severity === "high" ? "badge-danger" : "badge-warn"}`;
    stSpan.textContent = f.statusLabel;
    tdStatus.appendChild(stSpan);

    tr.append(tdChk, tdItem, tdExp, tdStats, tdDur, tdStatus);
    tbody.appendChild(tr);
  }
}

function wireRadarControls() {
  el("sel-radar-filter").addEventListener("change", refreshRadarUi);
  el("btn-rescan-radar").addEventListener("click", () => {
    const targetFolder =
      state.radarScanner?.totalScannedItems > 0
        ? state.radarScanner.rootFolderId
        : state.pickerFolderId || "0";
    runRadarOnFolder(targetFolder);
  });
  el("chk-radar-all").addEventListener("change", (e) => {
    document.querySelectorAll(".radar-row-chk:not(:disabled)").forEach((c) => {
      c.checked = e.target.checked;
    });
  });

  const executeBulkAction = async (actionType) => {
    const selectedIds = Array.from(document.querySelectorAll(".radar-row-chk:checked")).map(
      (c) => c.dataset.findingId
    );
    if (selectedIds.length === 0) {
      showToast("Select at least one exposed item first.", true);
      return;
    }

    const targets = state.radarScanner.findings.filter(
      (f) => selectedIds.includes(f.findingId) && !f.remediated
    );
    if (targets.length === 0) return;

    const allowed = await consumeQuotaOrWarn("radar_fix", targets.length);
    if (!allowed) return;

    let completed = 0;
    for (const item of targets) {
      try {
        await state.radarScanner.remediateFinding(item, actionType);
        completed++;
      } catch {
        // Continue remaining items if one lacks permission
      }
    }
    refreshRadarUi();
    showToast(`Remediated ${completed} item${completed === 1 ? "" : "s"} directly in your Box account!`);
  };

  el("btn-bulk-revoke").addEventListener("click", () => executeBulkAction("revoke"));
  el("btn-bulk-viewonly").addEventListener("click", () => executeBulkAction("view_only"));
  el("btn-bulk-expire30").addEventListener("click", () => executeBulkAction("expire_30d"));

  el("btn-save-radar-csv").addEventListener("click", async () => {
    try {
      await state.radarScanner.saveSnapshotAndCsvToBox();
      showToast("Saved Audit CSV + traffic-delta snapshot directly into your Box folder!");
    } catch (err) {
      showToast(err.message || "Failed to save Audit CSV to Box.", true);
    }
  });
}

/* ========================================================================= */
/* TAB 3: BUILT-IN BOX FOLDER & FILE BROWSER                                 */
/* ========================================================================= */

async function loadPickerFolder(folderId) {
  state.pickerFolderId = String(folderId || "0");
  const listEl = el("picker-list");
  listEl.innerHTML = '<div class="muted" style="padding:12px;">Loading Box folder...</div>';

  try {
    const folderMeta =
      state.pickerFolderId === "0"
        ? { id: "0", name: "All Files (Root)", parent: null }
        : await state.boxClient.getFolderMetadata(state.pickerFolderId);

    state.pickerParentId = folderMeta.parent?.id || null;
    el("picker-folder-title").textContent = `📁 ${folderMeta.name}`;
    el("btn-picker-up").disabled = !state.pickerParentId;

    const page = await state.boxClient.listFolderPage(state.pickerFolderId, 0, 200);
    listEl.innerHTML = "";
    const entries = page.entries || [];

    if (entries.length === 0) {
      listEl.innerHTML = '<div class="muted" style="padding:12px;">This Box folder is empty.</div>';
      return;
    }

    for (const item of entries) {
      const row = document.createElement("div");
      row.className = "picker-row";

      const title = document.createElement("div");
      title.style.fontWeight = "600";
      title.textContent = `${item.type === "folder" ? "📁" : "📄"} ${item.name}`;

      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "6px";

      if (item.type === "folder") {
        const btnOpen = document.createElement("button");
        btnOpen.className = "btn btn-secondary";
        btnOpen.textContent = "Open";
        btnOpen.addEventListener("click", () => loadPickerFolder(item.id));

        const btnAudit = document.createElement("button");
        btnAudit.className = "btn btn-primary";
        btnAudit.textContent = "📡 Audit in ShareRadar";
        btnAudit.addEventListener("click", () => {
          switchTab("radar");
          runRadarOnFolder(item.id);
        });
        actions.append(btnOpen, btnAudit);
      } else {
        const ext = (item.extension || "").toLowerCase();
        const supported = ["pdf", "jpg", "jpeg", "png", "webp", "docx"].includes(ext);
        const btnScrub = document.createElement("button");
        btnScrub.className = "btn btn-primary";
        btnScrub.disabled = !supported;
        btnScrub.textContent = supported ? "🛡️ Scrub & Redact" : `.${ext || "file"} unsupported`;
        if (supported) {
          btnScrub.addEventListener("click", () => {
            switchTab("scrub");
            openFileInScrubber(item.id);
          });
        }
        actions.appendChild(btnScrub);
      }

      row.append(title, actions);
      listEl.appendChild(row);
    }
  } catch (err) {
    showToast(err.message || "Unable to list Box folder.", true);
  }
}

function wirePickerControls() {
  el("btn-picker-up").addEventListener("click", () => {
    if (state.pickerParentId) loadPickerFolder(state.pickerParentId);
  });
  el("btn-audit-current-folder").addEventListener("click", () => {
    switchTab("radar");
    runRadarOnFolder(state.pickerFolderId);
  });
}

bootstrap();

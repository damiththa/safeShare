import { BoxBrowserClient } from "./box_client.js?v=7";
import { detectFileFormatFromBytes, runMetadataXray } from "./metadata_xray.js?v=7";
import { generateAnonymousStem, inspectFilenameForPii } from "./pii_detector.js?v=7";
import { RedactorWorkspace } from "./redactor_engine.js?v=7";
import { ShareRadarScanner } from "./shareradar_engine.js?v=7";

const state = {
  boxClient: null,
  sessionProof: null,
  entitlement: null,
  returnUrl: null,
  contextualLaunch: false,
  activeFileMeta: null,
  activeFileFormat: null,
  saveMode: "new_copy", // "new_copy" | "overwrite"
  piiCategoryFilter: "all",
  lastSavedFileId: null,
  lastSharedLinkUrl: null,
  pickerFolderId: "0",
  pickerParentId: null,
  radarScanner: null,
  radarFilter: "all",
  redactor: null,
};

const el = (id) => {
  const node = document.getElementById(id);
  if (!node) {
    return new Proxy(document.createElement("div"), {
      get(target, prop) {
        if (prop === "classList") {
          return {
            add: () => {},
            remove: () => {},
            toggle: () => false,
            contains: () => false,
          };
        }
        if (prop === "style") return {};
        if (prop === "addEventListener") return () => {};
        if (prop === "removeEventListener") return () => {};
        if (prop === "querySelectorAll") return () => [];
        if (prop === "querySelector") return () => null;
        if (prop === "appendChild") return () => {};
        if (prop === "append") return () => {};
        return target[prop];
      },
    });
  }
  return node;
};

function showToast(message, variant = "info") {
  const banner = el("toast-banner");
  const cls =
    variant === "error" ? "toast-error" : variant === "success" ? "toast-success" : "toast-info";
  banner.className = `toast ${cls}`;
  el("toast-text").textContent = message;
  banner.classList.remove("hidden");
}

function hideToast() {
  el("toast-banner").classList.add("hidden");
}

function closeOrReturnToBox() {
  if (state.returnUrl) {
    window.location.href = state.returnUrl;
    return;
  }
  // When opened as a popup window from Box, window.close() cleanly closes the popup right back to Box!
  try {
    window.close();
  } catch {
    // Ignore if blocked
  }
  // Fallback if opened in a standard tab where script close is ignored
  setTimeout(() => {
    if (!document.hidden) {
      window.location.href = "https://app.box.com";
    }
  }, 180);
}

function updateQuotaBadge() {
  const badge = el("quota-badge");
  if (!state.entitlement) {
    badge.classList.add("hidden");
    return;
  }
  badge.classList.remove("hidden");
  if (state.entitlement.plan === "pro") {
    badge.textContent = "Pro Plan";
  } else {
    const scrubs = state.entitlement.scrub_remaining;
    badge.textContent = `${scrubs} free save${scrubs === 1 ? "" : "s"} left`;
  }
}

async function checkQuotaAvailable(action, units = 1) {
  const resp = await fetch("/api/entitlement/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_proof: state.sessionProof }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.detail || "Session expired. Please reopen from Box.");
  }
  if (data.entitlement) {
    state.entitlement = data.entitlement;
    updateQuotaBadge();
  }
  const ent = data.entitlement || state.entitlement;
  if (ent && ent.plan !== "pro") {
    const remaining = action === "scrub" ? ent.scrub_remaining : ent.radar_fixes_remaining;
    const limitVal = action === "scrub" ? ent.scrub_limit : ent.radar_fixes_limit;
    if (typeof remaining === "number" && remaining < units) {
      return {
        allowed: false,
        message: `Monthly Free limit reached (${limitVal || 25}/month). Upgrade to Pro for unlimited access.`,
      };
    }
  }
  return { allowed: true, message: "" };
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
  const data = await resp.json().catch(() => ({}));
  if (data.entitlement) {
    state.entitlement = data.entitlement;
    updateQuotaBadge();
  }
  if (!resp.ok || !data.allowed) {
    showToast(data.message || "Monthly Free plan limit reached.", "error");
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
  el("btn-switch-item").addEventListener("click", () => {
    el("main-tabs").classList.remove("hidden");
    el("btn-switch-item").classList.add("hidden");
    switchTab("picker");
    loadPickerFolder(state.pickerFolderId);
  });
  el("btn-done-window").addEventListener("click", closeOrReturnToBox);
  el("btn-done-after-save").addEventListener("click", closeOrReturnToBox);

  state.redactor = new RedactorWorkspace(el("redactor-canvas"), renderRedactorSidebarState);
  wireScrubControls();
  wireRadarControls();
  wirePickerControls();

  let pubCfg = { authorize_url_template: "", redirect_uri: null };
  const pubCfgPromise = fetch("/api/public-config")
    .then((r) => r.json())
    .then((cfg) => {
      pubCfg = cfg;
      return cfg;
    })
    .catch(() => ({ authorize_url_template: "", redirect_uri: null }));

  el("btn-oauth-connect").addEventListener("click", async () => {
    if (!pubCfg.authorize_url_template) {
      await pubCfgPromise;
    }
    if (!pubCfg.authorize_url_template) {
      showToast("Box OAuth credentials are not configured yet.", "error");
      return;
    }
    window.location.href = pubCfg.authorize_url_template;
  });

  const launch = parseLaunchParams();
  if (launch.returnUrl && /^https:\/\/([a-z0-9-]+\.)*(box\.com|app\.box\.com)\//i.test(launch.returnUrl)) {
    state.returnUrl = launch.returnUrl;
  }

  if (!launch.authCode) {
    return;
  }

  el("connect-heading").textContent = launch.folderId
    ? "Opening your Box folder..."
    : "Opening your Box file...";
  el("connect-subtext").textContent = "Just a moment while we prepare your workspace.";
  el("btn-oauth-connect").disabled = true;

  try {
    // Only standalone /callback redirects need redirect_uri; Box Web Integration launches fire immediately!
    const redirectUri = launch.fromCallback ? (await pubCfgPromise).redirect_uri : null;
    const exchResp = await fetch("/api/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_code: launch.authCode,
        redirect_uri: redirectUri,
      }),
    });
    const exchData = await exchResp.json();
    if (!exchResp.ok) {
      throw new Error(exchData.detail || "Could not sign in with Box.");
    }

    state.boxClient = new BoxBrowserClient(exchData.access_token);
    state.sessionProof = exchData.session_proof;
    state.entitlement = exchData.entitlement;
    state.radarScanner = new ShareRadarScanner(state.boxClient);

    const badge = el("userBadge");
    if (badge) {
      badge.textContent = "Box Connected";
      badge.classList.remove("hidden");
    }

    // Non-blocking user badge personalization in browser memory only
    state.boxClient
      .getCurrentUser()
      .then((me) => {
        if (me && me.login) {
          badge.textContent = me.login;
          badge.title = me.name ? `${me.name} (${me.login})` : me.login;
          badge.classList.remove("hidden");
        }
      })
      .catch(() => {});

    el("screen-connect").classList.add("hidden");
    el("btn-done-window").classList.remove("hidden");
    updateQuotaBadge();

    // Contextual Launch Mode: keep UI super clean & focused on the single item clicked in Box!
    if (launch.fileId) {
      state.contextualLaunch = true;
      el("btn-switch-item").textContent = "Switch file";
      el("btn-switch-item").classList.remove("hidden");
      switchTab("scrub");
      await openFileInScrubber(launch.fileId);
    } else if (launch.folderId) {
      state.contextualLaunch = true;
      el("btn-switch-item").textContent = "Switch folder";
      el("btn-switch-item").classList.remove("hidden");
      switchTab("radar");
      await runRadarOnFolder(launch.folderId);
    } else {
      el("main-tabs").classList.remove("hidden");
      switchTab("picker");
      await loadPickerFolder("0");
    }
  } catch (err) {
    el("connect-heading").textContent = "Share Box files with confidence";
    el("connect-subtext").textContent =
      "Automatically remove hidden personal details, black out sensitive info, and review shared folders.";
    el("btn-oauth-connect").disabled = false;
    showToast(err.message || "Sign-in failed.", "error");
  }
}

/* ========================================================================= */
/* SCREEN 1: CLEAN & REDACT FILE                                             */
/* ========================================================================= */

async function openFileInScrubber(fileId) {
  hideToast();
  el("scrub-empty-prompt").classList.add("hidden");
  el("scrub-workspace").classList.remove("hidden");
  el("save-success-box").classList.add("hidden");
  el("save-error-box").classList.add("hidden");
  const xrayIcon = el("xray-badge-icon");
  xrayIcon.className = "check-circle is-neutral";
  xrayIcon.textContent = "•";
  el("xray-title").textContent = "File properties";
  el("xray-summary").textContent = "Checking file header...";
  el("xray-details-wrap").classList.add("hidden");
  el("xray-list").innerHTML = "";
  el("pii-checklist").innerHTML = "";
  state.lastSavedFileId = null;
  state.lastSharedLinkUrl = null;

  try {
    // Fetch Box file metadata and binary stream concurrently to cut a full network round-trip
    const [meta, bytes] = await Promise.all([
      state.boxClient.getFileMetadata(fileId),
      state.boxClient.downloadFileBytes(fileId),
    ]);
    state.activeFileMeta = meta;
    if (meta.parent?.id) {
      state.pickerFolderId = String(meta.parent.id);
    }
    el("active-context-label").textContent = meta.name;
    el("scrub-file-label").textContent = meta.name;

    const fmt = detectFileFormatFromBytes(bytes, meta.name);
    state.activeFileFormat = fmt;

    const isDocx = fmt === "docx";
    state.piiCategoryFilter = "all";
    el("canvas-wrapper").classList.toggle("hidden", isDocx);
    el("docx-friendly-card").classList.toggle("hidden", !isDocx);
    el("draw-helper-tip").classList.toggle("hidden", isDocx);
    el("pii-section-card").classList.remove("hidden");

    // Clean, friendly default output filename (`_Clean`)
    const rawStem = meta.name.replace(/\.[^.]+$/, "");
    el("inp-output-stem").value = /_Clean(\s*\(\d+\))?$/i.test(rawStem) ? rawStem : `${rawStem}_Clean`;
    el("lbl-output-ext").textContent =
      fmt === "pdf" ? ".pdf" : fmt === "docx" ? ".docx" : fmt === "png" ? ".png" : ".jpg";
    checkFilenameWarning();

    // Run header clean-up check and Page 1 rendering concurrently
    const [leaks] = await Promise.all([
      runMetadataXray(bytes, fmt),
      state.redactor.loadDocument(bytes, fmt),
    ]);
    const xrayList = el("xray-list");
    xrayList.innerHTML = "";

    if (leaks.length === 0) {
      xrayIcon.className = "check-circle";
      xrayIcon.textContent = "✓";
      el("xray-title").textContent = "File properties clean";
      el("xray-summary").textContent = "No hidden author, GPS, or device data.";
      el("xray-details-wrap").classList.add("hidden");
    } else {
      xrayIcon.className = "check-circle is-amber";
      xrayIcon.textContent = "!";
      el("xray-title").textContent =
        leaks.length === 1 ? "1 hidden file property" : `${leaks.length} hidden file properties`;
      el("xray-summary").textContent = "Removed automatically on save.";
      el("xray-details-summary").textContent = `Show hidden properties (${leaks.length})`;
      el("xray-details-wrap").classList.remove("hidden");

      for (const lk of leaks) {
        const li = document.createElement("li");
        const b = document.createElement("strong");
        b.textContent = `${lk.title}: `;
        const sp = document.createElement("span");
        sp.textContent = lk.detail;
        li.append(b, sp);
        xrayList.appendChild(li);
      }
    }

    renderRedactorSidebarState();
  } catch (err) {
    console.error("openFileInScrubber error:", err);
    showToast(err.message || "Unable to open this file from Box.", "error");
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

  // Only show page stepper on multi-page PDFs
  const showStepper = r.format === "pdf" && r.pageCount > 1;
  el("page-stepper").classList.toggle("hidden", !showStepper);
  if (showStepper) {
    el("page-indicator").textContent = `${r.currentPage + 1} / ${r.pageCount}`;
    el("btn-prev-page").disabled = r.currentPage <= 0;
    el("btn-next-page").disabled = r.currentPage >= r.pageCount - 1;
  }

  // Only show Undo/Clear buttons when user has actually drawn custom blackout boxes
  el("manual-box-controls").classList.toggle("hidden", r.manualBoxes.length === 0);

  // Background OCR indicator for images & scanned PDFs
  el("ocr-progress-row").classList.toggle("hidden", !r.isOcrScanning);
  if (r.isOcrScanning) {
    el("ocr-progress-text").textContent = r.ocrStatusText || "Scanning image text for PII & PHI...";
  }

  const totalFound = r.autoFindings.length;
  const activeAuto = r.autoFindings.filter((f) => f.enabled).length;
  const totalActive = activeAuto + r.manualBoxes.length;

  if (totalFound === 0 && r.manualBoxes.length === 0) {
    el("pii-count-badge").textContent = r.isOcrScanning ? "Scanning..." : "None found";
  } else if (totalActive === 0) {
    el("pii-count-badge").textContent = `${totalFound} highlighted`;
  } else {
    el("pii-count-badge").textContent = `${totalActive} blacked out`;
  }

  // Category filter pills (only display categories that actually have matches)
  const catCounts = {
    all: totalFound,
    phi: r.autoFindings.filter((f) => f.category === "phi").length,
    pii: r.autoFindings.filter((f) => f.category === "pii").length,
    financial: r.autoFindings.filter((f) => f.category === "financial").length,
  };
  if (state.piiCategoryFilter !== "all" && !catCounts[state.piiCategoryFilter]) {
    state.piiCategoryFilter = "all";
  }

  const nonZeroCats = ["phi", "pii", "financial"].filter((c) => catCounts[c] > 0);
  const pillsWrap = el("pii-category-pills");
  pillsWrap.classList.toggle("hidden", nonZeroCats.length < 2);
  if (nonZeroCats.length >= 2) {
    const labels = {
      all: `All (${catCounts.all})`,
      phi: `PHI (${catCounts.phi})`,
      pii: `Personal (${catCounts.pii})`,
      financial: `Financial (${catCounts.financial})`,
    };
    pillsWrap.querySelectorAll(".cat-pill").forEach((btn) => {
      const cat = btn.dataset.cat;
      const count = catCounts[cat] || 0;
      btn.classList.toggle("hidden", cat !== "all" && count === 0);
      btn.classList.toggle("active", state.piiCategoryFilter === cat);
      btn.textContent = labels[cat] || cat;
    });
  }

  const visibleFindings = r.autoFindings.filter(
    (f) => state.piiCategoryFilter === "all" || f.category === state.piiCategoryFilter
  );

  // 1-Click Bulk Action Bar ("Black Out All" + "Reset")
  const bulkBar = el("pii-bulk-bar");
  bulkBar.classList.toggle("hidden", totalFound === 0);
  if (totalFound > 0) {
    const uncheckedVisible = visibleFindings.filter((f) => !f.enabled).length;
    const btnBlackoutAll = el("btn-blackout-all");
    btnBlackoutAll.disabled = uncheckedVisible === 0;
    if (uncheckedVisible === 0) {
      btnBlackoutAll.textContent = "All Selected Blacked Out";
    } else if (state.piiCategoryFilter === "all") {
      btnBlackoutAll.textContent = `Black Out All (${totalFound})`;
    } else {
      btnBlackoutAll.textContent = `Black Out ${visibleFindings.length} Shown`;
    }
    el("btn-unselect-all").disabled = activeAuto === 0;
  }

  const list = el("pii-checklist");
  list.innerHTML = "";

  if (totalFound === 0 && r.manualBoxes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pii-empty";
    empty.textContent = r.isOcrScanning
      ? "Reading image text privately in your browser to highlight PII & PHI..."
      : r.format === "docx"
      ? "No structured PII or PHI patterns found in document body."
      : "No SSNs, PHI IDs, dates, cards, emails, or phones detected. Drag anywhere on the page to black out custom areas.";
    list.appendChild(empty);
    return;
  }

  const catShortTag = { phi: "PHI", pii: "PII", financial: "FIN" };

  for (const f of visibleFindings) {
    const row = document.createElement("label");
    row.className = `pii-item ${f.enabled ? "is-covered" : ""}`;

    row.addEventListener("mouseenter", () => r.setHoveredFinding(f.id));
    row.addEventListener("mouseleave", () => r.setHoveredFinding(null));

    const infoDiv = document.createElement("div");
    const titleRow = document.createElement("div");
    titleRow.className = "pii-title-row";

    const catBadge = document.createElement("span");
    catBadge.className = `pii-cat-tag pii-cat-${f.category || "pii"}`;
    catBadge.textContent = catShortTag[f.category] || "PII";

    const titleText = document.createElement("span");
    titleText.textContent = f.label;
    titleRow.append(catBadge, titleText);

    const metaDiv = document.createElement("div");
    metaDiv.className = "pii-item-meta";
    const locLabel = f.isDocxText
      ? f.occurrences > 1
        ? `${f.occurrences} matches in document`
        : "In Word text"
      : r.pageCount > 1
      ? `Page ${f.pageIndex + 1}`
      : f.enabled
      ? "Blacked out"
      : "Highlighted on page";
    metaDiv.textContent = `${f.masked} · ${locLabel}`;
    infoDiv.append(titleRow, metaDiv);

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = f.enabled;
    chk.addEventListener("change", async () => {
      f.enabled = chk.checked;
      if (!f.isDocxText && r.format === "pdf" && r.currentPage !== f.pageIndex) {
        await r.renderPage(f.pageIndex);
      } else {
        r.redrawOverlay();
      }
      renderRedactorSidebarState();
    });

    row.append(infoDiv, chk);
    list.appendChild(row);
  }

  if (r.manualBoxes.length > 0) {
    const manualRow = document.createElement("div");
    manualRow.className = "pii-item is-covered";
    const lbl = document.createElement("span");
    lbl.textContent = `${r.manualBoxes.length} custom blackout area${r.manualBoxes.length === 1 ? "" : "s"}`;
    const pill = document.createElement("span");
    pill.className = "badge badge-safe";
    pill.textContent = "Covered";
    manualRow.append(lbl, pill);
    list.appendChild(manualRow);
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
  el("btn-blackout-all").addEventListener("click", () => {
    state.redactor.setAllAutoFindings(true, state.piiCategoryFilter);
  });
  el("btn-unselect-all").addEventListener("click", () => {
    state.redactor.setAllAutoFindings(false, "all");
  });
  document.querySelectorAll(".cat-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.piiCategoryFilter = btn.dataset.cat || "all";
      renderRedactorSidebarState();
    });
  });
  const applySaveModeUi = (mode) => {
    state.saveMode = mode === "overwrite" ? "overwrite" : "new_copy";
    const isOverwrite = state.saveMode === "overwrite";
    el("btn-mode-new-copy").classList.toggle("active", !isOverwrite);
    el("btn-mode-overwrite").classList.toggle("active", isOverwrite);
    el("filename-field-wrap").classList.toggle("hidden", isOverwrite);
    el("btn-save-only").textContent = isOverwrite
      ? "Replace Original in Box"
      : "Save New Copy to Box";
    el("btn-save-and-link").textContent = isOverwrite
      ? "Replace & Copy Link"
      : "Save Copy & Copy Link";
    el("save-mode-note").textContent = isOverwrite
      ? "Replaces this file in Box with the cleaned version."
      : "Saves a new clean file. Original stays untouched.";
    el("save-error-box").classList.add("hidden");
  };

  el("btn-mode-new-copy").addEventListener("click", () => applySaveModeUi("new_copy"));
  el("btn-mode-overwrite").addEventListener("click", () => applySaveModeUi("overwrite"));

  el("inp-output-stem").addEventListener("input", checkFilenameWarning);
  el("btn-anonymize-name").addEventListener("click", () => {
    el("inp-output-stem").value = generateAnonymousStem();
    checkFilenameWarning();
  });

  el("btn-open-saved-file").addEventListener("click", () => {
    if (!state.lastSavedFileId) return;
    openFileInScrubber(state.lastSavedFileId);
  });

  el("btn-copy-saved-link").addEventListener("click", async () => {
    if (!state.lastSavedFileId) return;
    try {
      if (!state.lastSharedLinkUrl) {
        const sl = await state.boxClient.createSharedLinkForFile(state.lastSavedFileId, "open", true);
        state.lastSharedLinkUrl = sl?.url || null;
      }
      if (state.lastSharedLinkUrl && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(state.lastSharedLinkUrl);
        showToast("Share link copied to clipboard!", "success");
      }
    } catch (err) {
      showToast(err.message || "Could not create share link.", "error");
    }
  });

  const showSaveError = (msg) => {
    const errBox = el("save-error-box");
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
    showToast(msg, "error");
  };

  const handleExport = async (createLinkAfter) => {
    if (!state.activeFileMeta || !state.redactor.rawBytes) return;
    const errBox = el("save-error-box");
    errBox.classList.add("hidden");
    el("save-success-box").classList.add("hidden");

    const btnA = el("btn-save-only");
    const btnB = el("btn-save-and-link");
    btnA.disabled = true;
    btnB.disabled = true;

    try {
      // 1. Pre-check quota WITHOUT decrementing so failed uploads never burn free saves!
      const quotaCheck = await checkQuotaAvailable("scrub", 1);
      if (!quotaCheck.allowed) {
        showSaveError(quotaCheck.message);
        return;
      }

      showToast("Saving redacted file to Box...", "info");
      const result = await state.redactor.exportSanitizedBytes({ flattenAllPages: false });
      const parentId = state.activeFileMeta.parent?.id || "0";
      const stem = el("inp-output-stem").value.trim() || "Clean_Copy";

      let uploaded = null;
      let usedSingleFileFallback = false;

      if (state.saveMode === "overwrite") {
        uploaded = await state.boxClient.uploadNewFileVersion(
          state.activeFileMeta.id,
          state.activeFileMeta.name,
          result.mimeType,
          result.bytes
        );
      } else {
        try {
          uploaded = await state.boxClient.uploadNewSafeCopy(
            parentId,
            stem,
            result.extension,
            result.mimeType,
            result.bytes
          );
        } catch (uploadErr) {
          // If Box Web Integration is configured with single-file scope instead of parent-folder scope,
          // POST /files/content returns 403; automatically fall back to saving a new version on {file_id}!
          if (uploadErr && uploadErr.status === 403) {
            uploaded = await state.boxClient.uploadNewFileVersion(
              state.activeFileMeta.id,
              state.activeFileMeta.name,
              result.mimeType,
              result.bytes
            );
            usedSingleFileFallback = true;
          } else {
            throw uploadErr;
          }
        }
      }

      // 2. Consume quota ONLY AFTER Box confirms the file was saved!
      await consumeQuotaOrWarn("scrub", 1);

      state.lastSavedFileId = uploaded.id;
      state.lastSharedLinkUrl = null;

      const subEl = el("save-success-sub");
      if (usedSingleFileFallback) {
        subEl.textContent = "Replaced original file in Box (single-file Box scope active).";
        subEl.classList.remove("hidden");
      } else {
        subEl.textContent = "";
        subEl.classList.add("hidden");
      }

      if (state.saveMode === "overwrite" || usedSingleFileFallback) {
        const xIcon = el("xray-badge-icon");
        xIcon.className = "check-circle";
        xIcon.textContent = "✓";
        el("xray-title").textContent = "File properties cleaned";
        el("xray-summary").textContent = "Hidden header data removed.";
        el("xray-details-wrap").classList.add("hidden");
      }

      if (createLinkAfter) {
        const sl = await state.boxClient.createSharedLinkForFile(uploaded.id, "open", true);
        state.lastSharedLinkUrl = sl?.url || null;
        if (state.lastSharedLinkUrl && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(state.lastSharedLinkUrl).catch(() => {});
        }
        hideToast();
        el("save-success-title").textContent = `Saved "${uploaded.name}" & copied link`;
      } else {
        hideToast();
        el("save-success-title").textContent =
          state.saveMode === "overwrite" || usedSingleFileFallback
            ? `Replaced "${uploaded.name}" in Box`
            : `Saved "${uploaded.name}" to Box`;
      }

      el("btn-copy-saved-link").classList.remove("hidden");
      el("save-success-box").classList.remove("hidden");
    } catch (err) {
      showSaveError(err.message || "Could not save redacted file to Box.");
    } finally {
      btnA.disabled = false;
      btnB.disabled = false;
    }
  };

  el("btn-save-only").addEventListener("click", () => handleExport(false));
  el("btn-save-and-link").addEventListener("click", () => handleExport(true));
}

/* ========================================================================= */
/* SCREEN 2: FOLDER SHARING SUMMARY (SHARERADAR)                             */
/* ========================================================================= */

async function runRadarOnFolder(folderId) {
  hideToast();
  state.pickerFolderId = String(folderId || "0");
  el("radar-tbody").innerHTML =
    '<tr><td colspan="6" class="empty-cell">Checking shared links and guests in this folder...</td></tr>';

  try {
    const folderMeta =
      folderId === "0"
        ? { id: "0", name: "All Files" }
        : await state.boxClient.getFolderMetadata(folderId);
    el("active-context-label").textContent = folderMeta.name;
    el("radar-folder-heading").textContent = `Sharing Summary — ${folderMeta.name}`;

    await state.radarScanner.scanFolderTree(folderId, (scannedCount) => {
      el("kpi-scan-progress").textContent = `Checking ${scannedCount} items...`;
    });

    refreshRadarUi();
  } catch (err) {
    showToast(err.message || "Could not scan this Box folder.", "error");
  }
}

function refreshRadarUi() {
  const stats = state.radarScanner.getSummaryStats();
  el("kpi-open-links").textContent = stats.openPublicLinks.toLocaleString();
  el("kpi-total-opens").textContent = stats.totalOpens.toLocaleString();
  el("kpi-total-downloads").textContent = stats.totalDownloads.toLocaleString();
  el("kpi-external-guests").textContent = stats.externalGuests.toLocaleString();
  el("kpi-scan-progress").textContent = `Checked ${stats.totalScannedItems} files and folders`;

  if (stats.hasPriorSnapshot) {
    const snapDay = stats.priorSnapshotDate ? stats.priorSnapshotDate.slice(0, 10) : "last check";
    el("kpi-delta-opens").textContent =
      stats.deltaOpensSum > 0
        ? `+${stats.deltaOpensSum} new views since ${snapDay}`
        : `No new views since ${snapDay}`;
    el("kpi-delta-downloads").textContent =
      stats.deltaDownloadsSum > 0
        ? `+${stats.deltaDownloadsSum} new downloads since ${snapDay}`
        : `No new downloads since ${snapDay}`;
  } else {
    el("kpi-delta-opens").textContent = "Times shared links were opened";
    el("kpi-delta-downloads").textContent = "Times shared files were downloaded";
  }

  const tbody = el("radar-tbody");
  tbody.innerHTML = "";

  const filtered = state.radarScanner.findings.filter((f) => {
    if (state.radarFilter === "open_links") return f.kind === "shared_link" && f.accessLevel === "open";
    if (state.radarFilter === "high_traffic") return f.kind === "shared_link" && (f.opens > 0 || f.downloads > 0);
    if (state.radarFilter === "guests") return f.kind === "external_guest";
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty-cell">Everything looks clean — no matching shared links or outside guests found.</td></tr>';
    return;
  }

  for (const f of filtered) {
    const tr = document.createElement("tr");

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
    nameStrong.textContent = f.name;
    const pathSub = document.createElement("div");
    pathSub.className = "muted";
    pathSub.style.fontSize = "12px";
    pathSub.textContent = `${f.itemType === "folder" ? "Folder" : "File"} · ${f.path}`;
    tdItem.append(nameStrong, pathSub);

    // Access
    const tdExp = document.createElement("td");
    const expBadge = document.createElement("span");
    if (f.kind === "shared_link") {
      expBadge.className = `badge ${f.accessLevel === "open" ? "badge-warn" : "badge-neutral"}`;
      expBadge.textContent =
        f.accessLevel === "open" ? "Anyone with link" : `Shared link (${f.accessLevel})`;
      const permLine = document.createElement("div");
      permLine.className = "muted";
      permLine.style.fontSize = "12px";
      permLine.style.marginTop = "3px";
      permLine.textContent = [
        f.canDownload ? "Can download" : "View only",
        f.hasPassword ? "Password protected" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      tdExp.append(expBadge, permLine);
    } else {
      expBadge.className = "badge badge-neutral";
      expBadge.textContent = f.guestEmail;
      const roleLine = document.createElement("div");
      roleLine.className = "muted";
      roleLine.style.fontSize = "12px";
      roleLine.style.marginTop = "3px";
      roleLine.textContent = `Outside ${f.guestRole}`;
      tdExp.append(expBadge, roleLine);
    }

    // Views & Downloads
    const tdStats = document.createElement("td");
    if (f.kind === "shared_link") {
      const countsDiv = document.createElement("div");
      countsDiv.textContent = `${f.opens.toLocaleString()} views · ${f.downloads.toLocaleString()} downloads`;
      tdStats.appendChild(countsDiv);
      if ((f.deltaOpens || 0) > 0 || (f.deltaDownloads || 0) > 0) {
        const deltaDiv = document.createElement("div");
        deltaDiv.style.fontSize = "12px";
        deltaDiv.style.color = "var(--primary)";
        deltaDiv.textContent = `+${f.deltaOpens || 0} new views, +${f.deltaDownloads || 0} downloads`;
        tdStats.appendChild(deltaDiv);
      }
    } else {
      tdStats.innerHTML = '<span class="muted">Invited collaborator</span>';
    }

    // Expiration
    const tdDur = document.createElement("td");
    if (f.kind === "shared_link") {
      tdDur.textContent =
        f.expiryDaysLeft !== null ? `Expires in ${f.expiryDaysLeft} days` : "No expiration set";
    } else {
      tdDur.textContent =
        f.guestExpiryLeft !== null
          ? `Expires in ${f.guestExpiryLeft} days`
          : `Added ${f.tenureDays ?? 0} days ago`;
    }

    // Status
    const tdStatus = document.createElement("td");
    const stSpan = document.createElement("span");
    stSpan.className = `badge ${f.remediated ? "badge-safe" : "badge-neutral"}`;
    stSpan.textContent = f.remediated ? f.statusLabel.replace(/^✓\s*/, "") : "Active";
    tdStatus.appendChild(stSpan);

    tr.append(tdChk, tdItem, tdExp, tdStats, tdDur, tdStatus);
    tbody.appendChild(tr);
  }
}

function wireRadarControls() {
  document.querySelectorAll(".filter-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.radarFilter = btn.dataset.filter || "all";
      refreshRadarUi();
    });
  });

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
      showToast("Check at least one item in the list first.", "info");
      return;
    }

    const targets = state.radarScanner.findings.filter(
      (f) => selectedIds.includes(f.findingId) && !f.remediated
    );
    if (targets.length === 0) return;

    try {
      const quotaCheck = await checkQuotaAvailable("radar_fix", targets.length);
      if (!quotaCheck.allowed) {
        showToast(quotaCheck.message, "error");
        return;
      }
    } catch (err) {
      showToast(err.message || "Could not verify session quota.", "error");
      return;
    }

    let completed = 0;
    for (const item of targets) {
      try {
        await state.radarScanner.remediateFinding(item, actionType);
        completed++;
      } catch {
        // Continue remaining items if one lacks permission
      }
    }
    if (completed > 0) {
      await consumeQuotaOrWarn("radar_fix", completed);
    }
    refreshRadarUi();
    showToast(`Updated ${completed} item${completed === 1 ? "" : "s"} in Box.`, "success");
  };

  el("btn-bulk-revoke").addEventListener("click", () => executeBulkAction("revoke"));
  el("btn-bulk-viewonly").addEventListener("click", () => executeBulkAction("view_only"));
  el("btn-bulk-expire30").addEventListener("click", () => executeBulkAction("expire_30d"));

  el("btn-save-radar-csv").addEventListener("click", async () => {
    try {
      await state.radarScanner.saveSnapshotAndCsvToBox();
      showToast("Saved Sharing Report CSV to your Box folder!", "success");
    } catch (err) {
      showToast(err.message || "Could not save report to Box.", "error");
    }
  });
}

/* ========================================================================= */
/* SCREEN 3: SIMPLE BOX FOLDER & FILE PICKER                                 */
/* ========================================================================= */

async function loadPickerFolder(folderId) {
  state.pickerFolderId = String(folderId || "0");
  const listEl = el("picker-list");
  listEl.innerHTML = '<div class="muted" style="padding:14px;">Loading Box folder...</div>';

  try {
    const folderMeta =
      state.pickerFolderId === "0"
        ? { id: "0", name: "All Files", parent: null }
        : await state.boxClient.getFolderMetadata(state.pickerFolderId);

    state.pickerParentId = folderMeta.parent?.id || null;
    el("picker-folder-title").textContent = folderMeta.name;
    el("btn-picker-up").disabled = !state.pickerParentId;

    const page = await state.boxClient.listFolderPage(state.pickerFolderId, 0, 200);
    listEl.innerHTML = "";
    const entries = page.entries || [];

    if (entries.length === 0) {
      listEl.innerHTML = '<div class="muted" style="padding:14px;">This folder is empty.</div>';
      return;
    }

    for (const item of entries) {
      const row = document.createElement("div");
      row.className = "picker-row";

      const title = document.createElement("div");
      title.style.fontWeight = "600";
      title.textContent = item.name;

      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "8px";

      if (item.type === "folder") {
        const btnOpen = document.createElement("button");
        btnOpen.className = "btn btn-ghost btn-sm";
        btnOpen.type = "button";
        btnOpen.textContent = "Open";
        btnOpen.addEventListener("click", () => loadPickerFolder(item.id));

        const btnAudit = document.createElement("button");
        btnAudit.className = "btn btn-secondary btn-sm";
        btnAudit.type = "button";
        btnAudit.textContent = "Check Sharing";
        btnAudit.addEventListener("click", () => {
          switchTab("radar");
          runRadarOnFolder(item.id);
        });
        actions.append(btnOpen, btnAudit);
      } else {
        const ext = (item.extension || "").toLowerCase();
        const supported = ["pdf", "jpg", "jpeg", "png", "webp", "docx"].includes(ext);
        const btnScrub = document.createElement("button");
        btnScrub.className = supported ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm";
        btnScrub.type = "button";
        btnScrub.disabled = !supported;
        btnScrub.textContent = supported ? "Clean & Redact" : "Unsupported";
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
    showToast(err.message || "Unable to list Box folder.", "error");
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

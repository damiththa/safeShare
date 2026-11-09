import { BoxBrowserClient } from "./box_client.js?v=7";
import { extractDocumentText, computeTextRedline } from "./text_diff.js?v=7";
import { VisualComparator, supportsVisualComparison } from "./visual_diff.js?v=7";
import { diffSpreadsheets, supportsSpreadsheetComparison } from "./spreadsheet_diff.js?v=7";
import { generateRedlineReportPdf } from "./report_exporter.js?v=7";

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js?v=7";
}

const TEXT_EXTS = new Set(["pdf", "docx", "txt", "md", "json", "csv"]);
const SUPPORTED_EXTS = new Set(["pdf", "docx", "xlsx", "csv", "txt", "md", "json", "png", "jpg", "jpeg", "webp"]);

function isTextCapable(ext) {
  return TEXT_EXTS.has((ext || "").toLowerCase().replace(/^\./, ""));
}

function getExtFromName(name, fallbackExt = "") {
  if (fallbackExt) return fallbackExt.toLowerCase().replace(/^\./, "");
  const m = /\.([a-zA-Z0-9]+)$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

function areFormatsCompatible(extA, extB) {
  const a = (extA || "").toLowerCase();
  const b = (extB || "").toLowerCase();
  if (!a || !b) return false;
  if (isTextCapable(a) && isTextCapable(b)) return true;
  if (supportsVisualComparison(a) && supportsVisualComparison(b)) return true;
  if (supportsSpreadsheetComparison(a) && supportsSpreadsheetComparison(b)) return true;
  return false;
}

const state = {
  publicConfig: null,
  boxClient: null,
  sessionProof: null,
  entitlement: null,
  returnUrl: null,
  currentFolderId: "0",
  parentFolderId: "0",

  candidates: new Map(),
  byteCache: new Map(),
  comparedPairs: new Set(),

  leftDesc: null,
  rightDesc: null,

  activeMode: "text", // "text" | "visual" | "sheet"
  textViewStyle: "unified", // "unified" | "split"
  changesOnly: true,

  textDiffResult: null,
  scannedPdfDetected: false,

  visualComparator: new VisualComparator(),
  visualLoaded: false,
  visualSubMode: "curtain", // "curtain" | "pixel" | "side"
  visualPage: 1,
  visualTotalPages: 1,
  pixelThreshold: 24,
  latestVisualRender: null,
  pageSummaries: [],

  spreadsheetResult: null,
  activeSheetIdx: 0,
  sheetFilter: "all", // "all" | "formulas" | "overrides" | "values"
  sheetSearch: "",

  lastUploadedReportId: null,
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

function showBanner(message, level = "info") {
  const banner = el("statusBanner");
  const txt = el("statusBannerText");
  banner.className = `status-banner ${level}`;
  txt.textContent = message;
  banner.classList.remove("hidden");
}

function hideBanner() {
  el("statusBanner").classList.add("hidden");
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatShortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function updateQuotaBadge(ent) {
  if (!ent) return;
  state.entitlement = ent;
  const badge = el("quotaBadge");
  badge.classList.remove("hidden");
  if (ent.plan === "pro" || ent.diffs_limit === null) {
    badge.textContent = "Pro · Unlimited Diffs";
  } else {
    badge.textContent = `Free: ${ent.diffs_remaining}/${ent.diffs_limit} diffs left (${ent.period})`;
  }
}

function parseLaunchParams() {
  const merged = new URLSearchParams(window.location.search);
  if (window.location.hash && window.location.hash.length > 1) {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    for (const [k, v] of hashParams.entries()) {
      merged.set(k, v);
    }
  }
  if (window.location.search || window.location.hash) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  return {
    authCode: merged.get("auth_code") || merged.get("code") || "",
    fileId: merged.get("file_id") || "",
    folderId: merged.get("folder_id") || "",
    returnUrl: merged.get("return_url") || merged.get("redirect_to_box_url") || "",
    fromCallback: merged.get("from_callback") === "1",
  };
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.detail || data.message || `Request failed (${resp.status})`);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function initApp() {
  bindEvents();
  const launch = parseLaunchParams();

  if (launch.returnUrl && /^https:\/\/([a-z0-9-]+\.)*box\.com(\/|$)/i.test(launch.returnUrl)) {
    state.returnUrl = launch.returnUrl;
    const retBtn = el("btnReturnBox");
    retBtn.href = launch.returnUrl;
    retBtn.classList.remove("hidden");
  }

  try {
    state.publicConfig = await fetchJson("/api/public-config", { method: "GET" });
  } catch (err) {
    showBanner(`Unable to load service configuration: ${err.message}`, "error");
    return;
  }

  if (!launch.authCode) {
    el("connectScreen").classList.remove("hidden");
    return;
  }

  el("connectScreen").classList.add("hidden");
  showBanner("Establishing stateless Box session...", "info");

  try {
    const exchangePayload = {
      auth_code: launch.authCode,
      redirect_uri: launch.fromCallback ? state.publicConfig.redirect_uri : null,
    };
    const session = await fetchJson("/api/oauth/exchange", {
      method: "POST",
      body: JSON.stringify(exchangePayload),
    });

    state.boxClient = new BoxBrowserClient(session.access_token);
    state.sessionProof = session.session_proof;
    updateQuotaBadge(session.entitlement);

    el("workspaceTabs").classList.remove("hidden");
    el("userBadge").classList.remove("hidden");
    hideBanner();

    // Non-blocking user badge personalization in browser memory only
    state.boxClient
      .getCurrentUser()
      .then((me) => {
        if (me && me.login) {
          el("userBadge").textContent = me.login;
          el("userBadge").title = me.name ? `${me.name} (${me.login})` : me.login;
        }
      })
      .catch(() => {});

    if (launch.fileId) {
      switchWorkspaceTab("compare");
      await loadPrimaryFileContext(launch.fileId);
    } else {
      switchWorkspaceTab("browse");
      await loadFolderBrowser(launch.folderId || "0");
    }
  } catch (err) {
    el("connectScreen").classList.remove("hidden");
    showBanner(`Box authorization failed: ${err.message}`, "error");
  }
}

function switchWorkspaceTab(tab) {
  const isCompare = tab === "compare";
  el("tabCompare").classList.toggle("active", isCompare);
  el("tabBrowse").classList.toggle("active", !isCompare);
  el("compareWorkspace").classList.toggle("hidden", !isCompare);
  el("browseWorkspace").classList.toggle("hidden", isCompare);
}

/**
 * Loads a Box file's Version History (`v1..vN`) + compatible sibling files in the parent folder.
 */
async function loadPrimaryFileContext(fileId) {
  showBanner("Loading file metadata & version history directly from Box...", "info");
  try {
    const meta = await state.boxClient.getFileMetadata(fileId);
    const ext = getExtFromName(meta.name, meta.extension);
    const parentId = (meta.parent && meta.parent.id) ? String(meta.parent.id) : "0";
    const parentName = (meta.parent && meta.parent.name) || "Parent Folder";
    state.currentFolderId = parentId;

    const versionsResp = await state.boxClient.listFileVersions(fileId);
    const timeline = state.boxClient.buildVersionTimeline(meta, versionsResp);

    state.candidates.clear();
    const versionOptions = [];
    for (const ver of timeline) {
      const key = `ver:${meta.id}:${ver.versionId}`;
      const desc = {
        key,
        kind: "version",
        fileId: String(meta.id),
        downloadVersionId: ver.isCurrent ? null : ver.versionId,
        name: ver.name || meta.name,
        ext,
        label: `${meta.name} — ${ver.vLabel}`,
        size: ver.size,
        sha1: ver.sha1,
        timestamp: ver.timestamp,
        parentFolderId: parentId,
      };
      state.candidates.set(key, desc);
      versionOptions.push(desc);
    }

    // Also inspect sibling files in parent folder (enabled when Box Web Integration uses Parent Folder scope)
    const siblingOptions = [];
    try {
      const folderPage = await state.boxClient.listFolderPage(parentId, 0, 200);
      const entries = (folderPage && folderPage.entries) || [];
      for (const item of entries) {
        if (item.type !== "file" || String(item.id) === String(meta.id)) continue;
        if (item.name.startsWith("Redline_Report_")) continue;
        const sibExt = getExtFromName(item.name, item.extension);
        if (!SUPPORTED_EXTS.has(sibExt) || !areFormatsCompatible(ext, sibExt)) continue;

        const key = `file:${item.id}:current`;
        const desc = {
          key,
          kind: "file",
          fileId: String(item.id),
          downloadVersionId: null,
          name: item.name,
          ext: sibExt,
          label: `${item.name} (Sibling File)`,
          size: item.size || 0,
          sha1: item.sha1 || "",
          timestamp: item.modified_at || item.content_modified_at || item.created_at || "",
          parentFolderId: parentId,
        };
        state.candidates.set(key, desc);
        siblingOptions.push(desc);
      }
    } catch {
      // Single-file scope fallback: sibling folder listing unavailable, version history still works
    }

    renderSelectorDropdowns(meta.name, parentName, versionOptions, siblingOptions);
    hideBanner();

    if (versionOptions.length >= 2) {
      const prevVer = versionOptions[versionOptions.length - 2];
      const currVer = versionOptions[versionOptions.length - 1];
      el("leftSelect").value = prevVer.key;
      el("rightSelect").value = currVer.key;
      syncSelectorMetaLabels();
      await runActiveComparison();
    } else {
      const currVer = versionOptions[0];
      el("rightSelect").value = currVer.key;
      if (siblingOptions.length > 0) {
        el("leftSelect").value = siblingOptions[0].key;
        syncSelectorMetaLabels();
        showEmptyPrompt(
          `${meta.name} is on v1 (no prior versions yet)`,
          `We pre-selected compatible sibling file "${siblingOptions[0].name}" from "${parentName}" as Baseline (Left). Adjust the Left dropdown if needed and click Run Comparison.`
        );
      } else {
        el("leftSelect").value = currVer.key;
        syncSelectorMetaLabels();
        const restrictionNote = versionsResp.restricted
          ? " (Note: Box returned 403 on version history for this account tier.)"
          : "";
        showEmptyPrompt(
          `${meta.name} has only 1 version (v1) and no sibling files in "${parentName}"`,
          `Upload a revised v2 in Box or place a second compatible document in the same folder (or open Browse Box Folder above) to run a diff.${restrictionNote}`
        );
      }
    }
  } catch (err) {
    showBanner(`Failed to load Box file: ${err.message}`, "error");
  }
}

function renderSelectorDropdowns(primaryFileName, parentFolderName, versionOptions, siblingOptions) {
  for (const selectId of ["leftSelect", "rightSelect"]) {
    const sel = el(selectId);
    sel.innerHTML = "";

    if (versionOptions.length > 0) {
      const grpVer = document.createElement("optgroup");
      grpVer.label = `Version History — ${primaryFileName}`;
      for (const opt of versionOptions) {
        const o = document.createElement("option");
        o.value = opt.key;
        const dt = formatShortDate(opt.timestamp);
        o.textContent = dt ? `${opt.label} · ${dt}` : opt.label;
        grpVer.appendChild(o);
      }
      sel.appendChild(grpVer);
    }

    if (siblingOptions.length > 0) {
      const grpSib = document.createElement("optgroup");
      grpSib.label = `Compatible Files in "${parentFolderName}"`;
      for (const opt of siblingOptions) {
        const o = document.createElement("option");
        o.value = opt.key;
        o.textContent = `${opt.name} (${formatBytes(opt.size)})`;
        grpSib.appendChild(o);
      }
      sel.appendChild(grpSib);
    }
  }
}

function ensureCandidateOptionInDropdowns(desc) {
  state.candidates.set(desc.key, desc);
  for (const selectId of ["leftSelect", "rightSelect"]) {
    const sel = el(selectId);
    const exists = Array.from(sel.options).some((o) => o.value === desc.key);
    if (!exists) {
      const o = document.createElement("option");
      o.value = desc.key;
      o.textContent = desc.label;
      sel.appendChild(o);
    }
  }
}

function syncSelectorMetaLabels() {
  const lDesc = state.candidates.get(el("leftSelect").value) || null;
  const rDesc = state.candidates.get(el("rightSelect").value) || null;
  state.leftDesc = lDesc;
  state.rightDesc = rDesc;

  el("leftMetaInfo").textContent = lDesc
    ? `.${lDesc.ext.toUpperCase()} · ${formatBytes(lDesc.size)} · SHA1 ${(lDesc.sha1 || "n/a").slice(0, 10)}`
    : "No baseline selected";
  el("rightMetaInfo").textContent = rDesc
    ? `.${rDesc.ext.toUpperCase()} · ${formatBytes(rDesc.size)} · SHA1 ${(rDesc.sha1 || "n/a").slice(0, 10)}`
    : "No target selected";
}

function showEmptyPrompt(title, body) {
  el("diffToolbar").classList.add("hidden");
  el("paneTextDiff").classList.add("hidden");
  el("paneVisualDiff").classList.add("hidden");
  el("paneSheetDiff").classList.add("hidden");
  el("emptyPromptTitle").textContent = title;
  el("emptyPromptBody").textContent = body;
  el("emptyPromptCard").classList.remove("hidden");
}

async function getCachedBytes(desc) {
  const cacheKey = `${desc.fileId}:${desc.downloadVersionId || "current"}:${desc.sha1 || ""}`;
  if (state.byteCache.has(cacheKey)) {
    return state.byteCache.get(cacheKey);
  }
  const bytes = await state.boxClient.downloadFileBytes(desc.fileId, desc.downloadVersionId);
  if (state.byteCache.size >= 8) {
    const oldestKey = state.byteCache.keys().next().value;
    state.byteCache.delete(oldestKey);
  }
  state.byteCache.set(cacheKey, bytes);
  return bytes;
}

/**
 * Validates compatibility, checks/consumes 1 monthly quota unit (once per unique pair),
 * downloads both versions/files into browser RAM, and executes the appropriate diff engines.
 */
async function runActiveComparison() {
  syncSelectorMetaLabels();
  const left = state.leftDesc;
  const right = state.rightDesc;

  if (!left || !right) {
    showBanner("Please select both a Baseline (Left) and Target (Right) file or version.", "warn");
    return;
  }

  if (left.key === right.key) {
    showBanner(
      "Baseline and Target point to the exact same file version. Choose a different prior version or a second file in the folder.",
      "warn"
    );
    return;
  }

  const canText = isTextCapable(left.ext) && isTextCapable(right.ext);
  const canVisual = supportsVisualComparison(left.ext) && supportsVisualComparison(right.ext);
  const canSheet = supportsSpreadsheetComparison(left.ext) && supportsSpreadsheetComparison(right.ext);

  if (!canText && !canVisual && !canSheet) {
    showBanner(
      `Cannot compare .${left.ext} directly against .${right.ext}. Select two documents (.pdf/.docx/.txt), two spreadsheets (.xlsx/.csv), or two visual files (.pdf/.png/.jpg/.webp).`,
      "warn"
    );
    return;
  }

  // Quota check (charged at most once per unique pair in session)
  const pairKey = `${left.key}::${right.key}`;
  if (!state.comparedPairs.has(pairKey)) {
    try {
      const qResp = await fetchJson("/api/entitlement/consume", {
        method: "POST",
        body: JSON.stringify({ session_proof: state.sessionProof, units: 1 }),
      });
      state.comparedPairs.add(pairKey);
      updateQuotaBadge(qResp.entitlement);
    } catch (err) {
      if (err.status === 402 && err.payload && err.payload.entitlement) {
        updateQuotaBadge(err.payload.entitlement);
      }
      showBanner(err.message, "warn");
      return;
    }
  }

  el("emptyPromptCard").classList.add("hidden");
  el("exportSuccessStrip").classList.add("hidden");
  el("btnRunDiff").disabled = true;
  showBanner(`Downloading "${left.name}" and "${right.name}" directly into browser memory...`, "info");

  try {
    const [leftBytes, rightBytes] = await Promise.all([getCachedBytes(left), getCachedBytes(right)]);

    // Identical SHA-1 check
    const isShaIdentical = Boolean(left.sha1 && right.sha1 && left.sha1 === right.sha1);
    el("identicalNotice").classList.toggle("hidden", !isShaIdentical);

    // Reset engine states
    state.textDiffResult = null;
    state.scannedPdfDetected = false;
    state.spreadsheetResult = null;
    state.visualLoaded = false;
    state.latestVisualRender = null;
    state.pageSummaries = [];
    await state.visualComparator.dispose();

    showBanner("Computing redlines & deltas in browser memory...", "info");

    if (canSheet) {
      state.spreadsheetResult = await diffSpreadsheets(leftBytes, left.ext, rightBytes, right.ext);
      state.activeSheetIdx = Math.max(
        0,
        state.spreadsheetResult.sheets.findIndex((s) => s.changeCount > 0)
      );
    }

    if (canText) {
      const [leftDoc, rightDoc] = await Promise.all([
        extractDocumentText(leftBytes, left.ext),
        extractDocumentText(rightBytes, right.ext),
      ]);
      state.scannedPdfDetected = Boolean(leftDoc.isScannedLikely || rightDoc.isScannedLikely);
      state.textDiffResult = computeTextRedline(leftDoc.text, rightDoc.text);
    }

    if (canVisual) {
      const visInfo = await state.visualComparator.loadPair(leftBytes, left.ext, rightBytes, right.ext);
      state.visualLoaded = true;
      state.visualPage = 1;
      state.visualTotalPages = visInfo.totalPages;
    }

    // Configure Mode Pills
    el("modeBtnText").disabled = !canText;
    el("modeBtnVisual").disabled = !canVisual;
    el("modeBtnSheet").disabled = !canSheet;

    el("diffToolbar").classList.remove("hidden");
    el("btnExportBoxPdf").disabled = false;
    el("btnDownloadLocalPdf").disabled = false;

    // Pick smartest default mode
    let initialMode = "text";
    if (canSheet && (left.ext === "xlsx" || right.ext === "xlsx" || (left.ext === "csv" && right.ext === "csv"))) {
      initialMode = "sheet";
    } else if (!canText && canVisual) {
      initialMode = "visual";
    } else if (canVisual && state.scannedPdfDetected) {
      initialMode = "visual";
    }

    await activateDiffMode(initialMode);
    hideBanner();
  } catch (err) {
    showBanner(`Comparison failed: ${err.message}`, "error");
  } finally {
    el("btnRunDiff").disabled = false;
  }
}

async function activateDiffMode(mode) {
  state.activeMode = mode;
  el("modeBtnText").classList.toggle("active", mode === "text");
  el("modeBtnVisual").classList.toggle("active", mode === "visual");
  el("modeBtnSheet").classList.toggle("active", mode === "sheet");

  el("paneTextDiff").classList.toggle("hidden", mode !== "text");
  el("paneVisualDiff").classList.toggle("hidden", mode !== "visual");
  el("paneSheetDiff").classList.toggle("hidden", mode !== "sheet");

  renderKpiSummaryStrip();

  if (mode === "text" && state.textDiffResult) {
    renderTextRedlinePane();
  } else if (mode === "visual" && state.visualLoaded) {
    await renderVisualDiffPane();
  } else if (mode === "sheet" && state.spreadsheetResult) {
    renderSpreadsheetDiffPane();
  }
}

function renderKpiSummaryStrip() {
  const strip = el("kpiSummaryStrip");
  strip.innerHTML = "";

  const addChip = (text, cls = "") => {
    const sp = document.createElement("span");
    sp.className = `kpi-chip ${cls}`.trim();
    sp.textContent = text;
    strip.appendChild(sp);
  };

  if (state.activeMode === "text" && state.textDiffResult) {
    const st = state.textDiffResult.stats;
    addChip(`${st.modifiedLines} Modified`, "kpi-mod");
    addChip(`+${st.addedLines} Added`, "kpi-add");
    addChip(`-${st.removedLines} Removed`, "kpi-del");
    if (st.highlightCount > 0) {
      addChip(`${st.highlightCount} Key Clause/Number Shifts`, "kpi-mod");
    }
  } else if (state.activeMode === "sheet" && state.spreadsheetResult) {
    const st = state.spreadsheetResult.stats;
    addChip(`${st.totalChanges} Cell Deltas`, "kpi-mod");
    addChip(`${st.formulaChanges} Formula Edits`, st.formulaChanges ? "kpi-mod" : "");
    if (st.hardcodedOverrides > 0) {
      addChip(`${st.hardcodedOverrides} Hardcoded Overrides!`, "kpi-del");
    }
    addChip(`+${st.addedCells} / -${st.removedCells} Cells`, "kpi-add");
  } else if (state.activeMode === "visual" && state.visualLoaded) {
    addChip(`${state.visualTotalPages} Page${state.visualTotalPages === 1 ? "" : "s"}`, "");
    if (state.latestVisualRender) {
      addChip(
        `Page ${state.visualPage}: ${state.latestVisualRender.changedPercent.toFixed(2)}% Δ`,
        state.latestVisualRender.changedPercent > 0.02 ? "kpi-del" : "kpi-add"
      );
    }
  }
}

/* ============================================================================
 * PANE 1: TEXT & CONTRACT REDLINE RENDERER
 * ============================================================================ */
function renderTextRedlinePane() {
  const res = state.textDiffResult;
  if (!res) return;

  el("scannedPdfHint").classList.toggle("hidden", !state.scannedPdfDetected);

  // Smart Highlights
  const hlBox = el("smartHighlightsBox");
  const hlList = el("smartHighlightsList");
  hlList.innerHTML = "";

  if (res.highlights.length > 0) {
    hlBox.classList.remove("hidden");
    el("highlightsCountBadge").textContent = `${res.highlights.length} key shift${res.highlights.length === 1 ? "" : "s"}`;
    for (const hl of res.highlights) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "highlight-item";
      const top = document.createElement("div");
      top.className = "hl-top";
      const badgeSpan = document.createElement("span");
      badgeSpan.textContent = hl.badge;
      const lineSpan = document.createElement("span");
      lineSpan.textContent = `Line ${hl.lineRef}`;
      top.append(badgeSpan, lineSpan);

      const delta = document.createElement("div");
      delta.className = "hl-delta";
      delta.textContent = `${hl.before} → ${hl.after}`;

      btn.append(top, delta);
      btn.addEventListener("click", () => {
        const rowEl = document.getElementById(hl.changeId);
        if (rowEl) {
          rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
          rowEl.classList.add("flash-target");
          setTimeout(() => rowEl.classList.remove("flash-target"), 1800);
        }
      });
      hlList.appendChild(btn);
    }
  } else {
    hlBox.classList.add("hidden");
  }

  // Filter blocks with +-3 lines of context when `state.changesOnly` is checked
  const blocks = res.blocks;
  const visibleMask = new Array(blocks.length).fill(!state.changesOnly);
  if (state.changesOnly) {
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].kind !== "eq") {
        for (let k = Math.max(0, i - 3); k <= Math.min(blocks.length - 1, i + 3); k++) {
          visibleMask[k] = true;
        }
      }
    }
  }

  const container = el("textDiffContainer");
  container.innerHTML = "";

  if (res.stats.totalChanges === 0 && state.changesOnly) {
    const emptyMsg = document.createElement("div");
    emptyMsg.style.padding = "24px";
    emptyMsg.style.textAlign = "center";
    emptyMsg.textContent =
      "Zero text differences found between Baseline and Target. Uncheck 'Show changed sections only' above to read the full document text.";
    container.appendChild(emptyMsg);
    return;
  }

  const table = document.createElement("table");
  table.className = "diff-table";
  const tbody = document.createElement("tbody");

  let skippedCount = 0;
  const flushSkipped = () => {
    if (skippedCount > 0) {
      const tr = document.createElement("tr");
      tr.className = "row-sep";
      const td = document.createElement("td");
      td.colSpan = state.textViewStyle === "unified" ? 4 : 4;
      td.textContent = `⋯ ${skippedCount} unchanged line${skippedCount === 1 ? "" : "s"} hidden ⋯`;
      tr.appendChild(td);
      tbody.appendChild(tr);
      skippedCount = 0;
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    if (!visibleMask[i]) {
      skippedCount++;
      continue;
    }
    flushSkipped();
    const b = blocks[i];

    if (state.textViewStyle === "unified") {
      if (b.kind === "eq") {
        tbody.appendChild(buildUnifiedRow(b.leftLineNo, b.rightLineNo, "", null, b.leftText, ""));
      } else if (b.kind === "del") {
        tbody.appendChild(buildUnifiedRow(b.leftLineNo, "", "−", "row-del", b.leftText, b.changeId));
      } else if (b.kind === "add") {
        tbody.appendChild(buildUnifiedRow("", b.rightLineNo, "+", "row-add", b.rightText, b.changeId));
      } else if (b.kind === "mod") {
        tbody.appendChild(
          buildUnifiedRow(b.leftLineNo, "", "−", "row-del", null, b.changeId, b.inline.leftTokens)
        );
        tbody.appendChild(
          buildUnifiedRow("", b.rightLineNo, "+", "row-add", null, "", b.inline.rightTokens)
        );
      }
    } else {
      // Side-by-Side view
      const tr = document.createElement("tr");
      if (b.changeId) tr.id = b.changeId;

      const tdLnL = document.createElement("td");
      tdLnL.className = "diff-ln";
      tdLnL.textContent = b.leftLineNo || "";

      const tdLeft = document.createElement("td");
      tdLeft.style.width = "50%";
      if (b.kind === "del" || b.kind === "mod") tdLeft.className = "row-del";
      if (b.kind === "mod" && b.inline) {
        appendHighlightedTokens(tdLeft, b.inline.leftTokens);
      } else {
        tdLeft.textContent = b.leftText || "";
      }

      const tdLnR = document.createElement("td");
      tdLnR.className = "diff-ln";
      tdLnR.textContent = b.rightLineNo || "";

      const tdRight = document.createElement("td");
      tdRight.style.width = "50%";
      if (b.kind === "add" || b.kind === "mod") tdRight.className = "row-add";
      if (b.kind === "mod" && b.inline) {
        appendHighlightedTokens(tdRight, b.inline.rightTokens);
      } else {
        tdRight.textContent = b.rightText || "";
      }

      tr.append(tdLnL, tdLeft, tdLnR, tdRight);
      tbody.appendChild(tr);
    }
  }
  flushSkipped();

  table.appendChild(tbody);
  container.appendChild(table);
}

function buildUnifiedRow(lnLeft, lnRight, sign, rowCls, plainText, rowId, tokens = null) {
  const tr = document.createElement("tr");
  if (rowCls) tr.className = rowCls;
  if (rowId) tr.id = rowId;

  const tdL = document.createElement("td");
  tdL.className = "diff-ln";
  tdL.textContent = lnLeft || "";

  const tdR = document.createElement("td");
  tdR.className = "diff-ln";
  tdR.textContent = lnRight || "";

  const tdSign = document.createElement("td");
  tdSign.className = "diff-sign";
  tdSign.textContent = sign;

  const tdCode = document.createElement("td");
  if (tokens) {
    appendHighlightedTokens(tdCode, tokens);
  } else {
    tdCode.textContent = plainText || "";
  }

  tr.append(tdL, tdR, tdSign, tdCode);
  return tr;
}

function appendHighlightedTokens(containerEl, tokens) {
  for (const tok of tokens) {
    if (tok.type === "del") {
      const del = document.createElement("del");
      del.className = "tok-del";
      del.textContent = tok.value;
      containerEl.appendChild(del);
    } else if (tok.type === "add") {
      const ins = document.createElement("ins");
      ins.className = "tok-ins";
      ins.textContent = tok.value;
      containerEl.appendChild(ins);
    } else {
      containerEl.appendChild(document.createTextNode(tok.value));
    }
  }
}

/* ============================================================================
 * PANE 2: VISUAL CURTAIN & PIXEL DIFF RENDERER
 * ============================================================================ */
async function renderVisualDiffPane() {
  if (!state.visualLoaded) return;

  el("curtainStage").classList.toggle("hidden", state.visualSubMode !== "curtain");
  el("pixelStage").classList.toggle("hidden", state.visualSubMode !== "pixel");
  el("sideStage").classList.toggle("hidden", state.visualSubMode !== "side");

  el("pageIndicator").textContent = `Page ${state.visualPage} / ${state.visualTotalPages}`;
  el("btnPrevPage").disabled = state.visualPage <= 1;
  el("btnNextPage").disabled = state.visualPage >= state.visualTotalPages;

  const res = await state.visualComparator.renderPageComparison(state.visualPage, {
    targetWidth: 1080,
    threshold: state.pixelThreshold,
  });
  state.latestVisualRender = res;

  copyCanvasToTarget(res.leftCanvas, el("curtainLeftCanvas"));
  copyCanvasToTarget(res.rightCanvas, el("curtainRightCanvas"));
  copyCanvasToTarget(res.diffCanvas, el("pixelDiffCanvas"));
  copyCanvasToTarget(res.leftCanvas, el("sideLeftCanvas"));
  copyCanvasToTarget(res.rightCanvas, el("sideRightCanvas"));

  updateCurtainPosition(Number(el("curtainSlider").value || 50));

  el("visualPageDeltaBadge").textContent = `${res.changedPercent.toFixed(2)}% pixels changed`;
  renderKpiSummaryStrip();

  // Multi-page quick summary strip (computed once per comparison)
  const stripEl = el("pageDeltaStrip");
  if (state.visualTotalPages > 1) {
    stripEl.classList.remove("hidden");
    if (state.pageSummaries.length === 0) {
      state.pageSummaries = await state.visualComparator.scanQuickPageDeltas(state.pixelThreshold, 20);
    }
    stripEl.innerHTML = "";
    for (const ps of state.pageSummaries) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `page-pill ${ps.hasChanges ? "changed" : ""} ${ps.pageNum === state.visualPage ? "active" : ""}`.trim();
      btn.textContent = `P${ps.pageNum} (${ps.changedPercent.toFixed(1)}%)`;
      btn.addEventListener("click", async () => {
        state.visualPage = ps.pageNum;
        await renderVisualDiffPane();
      });
      stripEl.appendChild(btn);
    }
  } else {
    stripEl.classList.add("hidden");
  }
}

function copyCanvasToTarget(srcCanvas, destCanvas) {
  destCanvas.width = srcCanvas.width;
  destCanvas.height = srcCanvas.height;
  const ctx = destCanvas.getContext("2d");
  ctx.drawImage(srcCanvas, 0, 0);
}

function updateCurtainPosition(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  el("curtainSlider").value = String(Math.round(clamped));
  el("curtainLeftClip").style.clipPath = `inset(0 ${(100 - clamped).toFixed(2)}% 0 0)`;
  el("curtainDivider").style.left = `${clamped.toFixed(2)}%`;
}

/* ============================================================================
 * PANE 3: SPREADSHEET MULTI-SHEET CELL & FORMULA DIFF RENDERER
 * ============================================================================ */
function renderSpreadsheetDiffPane() {
  const res = state.spreadsheetResult;
  if (!res) return;

  const overrideAlert = el("formulaOverrideAlert");
  if (res.stats.hardcodedOverrides > 0) {
    overrideAlert.classList.remove("hidden");
    overrideAlert.textContent = `Audit Alert: ${res.stats.hardcodedOverrides} cell formula(s) in Baseline were overwritten with hardcoded literal numbers in Target! Click 'Hardcoded Overrides' below to inspect them.`;
  } else {
    overrideAlert.classList.add("hidden");
  }

  // Sheet Tabs
  const tabsBar = el("sheetTabsBar");
  tabsBar.innerHTML = "";
  res.sheets.forEach((sh, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `sheet-tab ${idx === state.activeSheetIdx ? "active" : ""}`;
    btn.textContent = `${sh.sheetName} (${sh.changeCount})`;
    btn.addEventListener("click", () => {
      state.activeSheetIdx = idx;
      renderSpreadsheetDiffPane();
    });
    tabsBar.appendChild(btn);
  });

  const activeSheet = res.sheets[state.activeSheetIdx] || res.sheets[0];
  const tbody = el("sheetDiffTableBody");
  tbody.innerHTML = "";

  if (!activeSheet) return;

  const q = state.sheetSearch.trim().toLowerCase();
  const filtered = activeSheet.changes.filter((ch) => {
    if (state.sheetFilter === "formulas" && ch.kind !== "formula_changed" && ch.kind !== "formula_overwritten") {
      return false;
    }
    if (state.sheetFilter === "overrides" && ch.kind !== "formula_overwritten") {
      return false;
    }
    if (state.sheetFilter === "values" && ch.kind !== "value_changed") {
      return false;
    }
    if (q) {
      const hay = `${ch.address} ${ch.leftValue} ${ch.rightValue} ${ch.leftFormula || ""} ${ch.rightFormula || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.style.textAlign = "center";
    td.style.padding = "22px";
    td.textContent = "No cell changes match the current filter on this worksheet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const ch of filtered.slice(0, 500)) {
    const tr = document.createElement("tr");

    const tdCell = document.createElement("td");
    tdCell.className = "cell-addr";
    tdCell.textContent = ch.address;

    const tdType = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge ${
      ch.kind === "formula_overwritten"
        ? "badge-override"
        : ch.kind === "formula_changed"
          ? "badge-formula"
          : "badge-safe"
    }`;
    badge.textContent = ch.badge;
    tdType.appendChild(badge);

    const tdLeft = document.createElement("td");
    appendCellFormulaAndValue(tdLeft, ch.leftFormula, ch.leftValue);

    const tdRight = document.createElement("td");
    appendCellFormulaAndValue(tdRight, ch.rightFormula, ch.rightValue);

    const tdDelta = document.createElement("td");
    tdDelta.className = "mono-sm";
    tdDelta.textContent = ch.numericDelta ? ch.numericDelta.formatted : "—";

    tr.append(tdCell, tdType, tdLeft, tdRight, tdDelta);
    tbody.appendChild(tr);
  }
}

function appendCellFormulaAndValue(td, formula, value) {
  if (formula) {
    const fp = document.createElement("div");
    fp.className = "formula-pill";
    fp.textContent = formula;
    td.appendChild(fp);
  }
  const vp = document.createElement("div");
  vp.textContent = value !== "" ? value : "(empty)";
  if (value === "") vp.className = "muted";
  td.appendChild(vp);
}

/* ============================================================================
 * FOLDER BROWSER WORKSPACE
 * ============================================================================ */
async function loadFolderBrowser(folderId) {
  showBanner("Loading Box folder items...", "info");
  try {
    const [folderMeta, page] = await Promise.all([
      state.boxClient.getFolderMetadata(folderId),
      state.boxClient.listFolderPage(folderId, 0, 200),
    ]);
    state.currentFolderId = String(folderMeta.id);
    state.parentFolderId = (folderMeta.parent && folderMeta.parent.id) ? String(folderMeta.parent.id) : null;

    el("folderTitle").textContent = folderMeta.name || "All Files";
    el("btnUpFolder").disabled = !state.parentFolderId;

    const tbody = el("folderTableBody");
    tbody.innerHTML = "";
    const entries = (page && page.entries) || [];

    for (const item of entries) {
      const tr = document.createElement("tr");

      const tdName = document.createElement("td");
      tdName.style.fontWeight = "600";
      tdName.textContent = item.type === "folder" ? `📁 ${item.name}` : `📄 ${item.name}`;

      const ext = item.type === "file" ? getExtFromName(item.name, item.extension) : "folder";
      const tdType = document.createElement("td");
      tdType.textContent = item.type === "folder" ? "Folder" : `.${ext.toUpperCase()}`;

      const tdSize = document.createElement("td");
      tdSize.textContent = item.type === "folder" ? "—" : formatBytes(item.size);

      const tdMod = document.createElement("td");
      tdMod.textContent = formatShortDate(item.modified_at || item.content_modified_at);

      const tdAct = document.createElement("td");
      const actRow = document.createElement("div");
      actRow.className = "row-actions";

      if (item.type === "folder") {
        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "btn btn-ghost btn-sm";
        openBtn.textContent = "Open Folder";
        openBtn.addEventListener("click", () => loadFolderBrowser(item.id));
        actRow.appendChild(openBtn);
      } else if (SUPPORTED_EXTS.has(ext)) {
        const verBtn = document.createElement("button");
        verBtn.type = "button";
        verBtn.className = "btn btn-primary btn-sm";
        verBtn.textContent = "Compare Versions";
        verBtn.addEventListener("click", async () => {
          switchWorkspaceTab("compare");
          await loadPrimaryFileContext(item.id);
        });

        const setLeftBtn = document.createElement("button");
        setLeftBtn.type = "button";
        setLeftBtn.className = "btn btn-ghost btn-sm";
        setLeftBtn.textContent = "Set Left";
        setLeftBtn.addEventListener("click", () => assignFileFromBrowser(item, "left"));

        const setRightBtn = document.createElement("button");
        setRightBtn.type = "button";
        setRightBtn.className = "btn btn-ghost btn-sm";
        setRightBtn.textContent = "Set Right";
        setRightBtn.addEventListener("click", () => assignFileFromBrowser(item, "right"));

        actRow.append(verBtn, setLeftBtn, setRightBtn);
      } else {
        const unsup = document.createElement("span");
        unsup.className = "muted";
        unsup.textContent = "Unsupported in v1";
        actRow.appendChild(unsup);
      }

      tdAct.appendChild(actRow);
      tr.append(tdName, tdType, tdSize, tdMod, tdAct);
      tbody.appendChild(tr);
    }

    hideBanner();
  } catch (err) {
    showBanner(`Unable to load Box folder: ${err.message}`, "error");
  }
}

function assignFileFromBrowser(item, side) {
  const ext = getExtFromName(item.name, item.extension);
  const desc = {
    key: `file:${item.id}:current`,
    kind: "file",
    fileId: String(item.id),
    downloadVersionId: null,
    name: item.name,
    ext,
    label: `${item.name} (Box File)`,
    size: item.size || 0,
    sha1: item.sha1 || "",
    timestamp: item.modified_at || item.content_modified_at || "",
    parentFolderId: state.currentFolderId || "0",
  };
  ensureCandidateOptionInDropdowns(desc);
  if (side === "left") {
    el("leftSelect").value = desc.key;
    showBanner(`Assigned "${item.name}" as Baseline (Left). Pick a Target (Right) or switch to Compare & Redline.`, "success");
  } else {
    el("rightSelect").value = desc.key;
    switchWorkspaceTab("compare");
    syncSelectorMetaLabels();
    showBanner(`Assigned "${item.name}" as Target (Right). Click Run Comparison when ready.`, "success");
  }
  syncSelectorMetaLabels();
}

/* ============================================================================
 * REPORT PDF EXPORT (SAVE TO BOX OR DOWNLOAD LOCALLY)
 * ============================================================================ */
async function buildCurrentReportBytes() {
  return generateRedlineReportPdf({
    leftDescriptor: state.leftDesc,
    rightDescriptor: state.rightDesc,
    activeMode: state.activeMode,
    textDiffResult: state.textDiffResult,
    spreadsheetResult: state.spreadsheetResult,
    visualSnapshotResult: state.latestVisualRender,
  });
}

async function handleSaveReportToBox() {
  if (!state.leftDesc || !state.rightDesc) return;
  el("btnExportBoxPdf").disabled = true;
  showBanner("Generating Redline_Report.pdf in browser memory & uploading to Box...", "info");

  try {
    const pdfBytes = await buildCurrentReportBytes();
    const stem = (state.rightDesc.name || "Document").replace(/\.[^.]+$/, "");
    const folderId = state.rightDesc.parentFolderId || state.currentFolderId || "0";
    const uploaded = await state.boxClient.uploadReportPdf(folderId, stem, pdfBytes);

    state.lastUploadedReportId = uploaded.id;
    el("exportSuccessText").textContent = `Saved "${uploaded.name}" directly to your Box folder!`;
    el("exportSuccessStrip").classList.remove("hidden");
    hideBanner();
  } catch (err) {
    showBanner(`Report upload failed: ${err.message}`, "error");
  } finally {
    el("btnExportBoxPdf").disabled = false;
  }
}

async function handleDownloadReportLocal() {
  if (!state.leftDesc || !state.rightDesc) return;
  try {
    const pdfBytes = await buildCurrentReportBytes();
    const stem = (state.rightDesc.name || "Document").replace(/\.[^.]+$/, "");
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Redline_Report_${stem}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    showBanner(`Failed to generate PDF: ${err.message}`, "error");
  }
}

/* ============================================================================
 * EVENT LISTENERS
 * ============================================================================ */
function bindEvents() {
  el("statusBannerClose").addEventListener("click", hideBanner);

  el("btnConnectBox").addEventListener("click", () => {
    if (!state.publicConfig || !state.publicConfig.authorize_url_template) {
      showBanner("Box OAuth Client ID is not configured on this server yet.", "error");
      return;
    }
    window.location.href = state.publicConfig.authorize_url_template;
  });

  el("tabCompare").addEventListener("click", () => switchWorkspaceTab("compare"));
  el("tabBrowse").addEventListener("click", async () => {
    switchWorkspaceTab("browse");
    await loadFolderBrowser(state.currentFolderId || "0");
  });

  el("leftSelect").addEventListener("change", syncSelectorMetaLabels);
  el("rightSelect").addEventListener("change", syncSelectorMetaLabels);

  el("btnSwapSides").addEventListener("click", () => {
    const l = el("leftSelect").value;
    const r = el("rightSelect").value;
    el("leftSelect").value = r;
    el("rightSelect").value = l;
    syncSelectorMetaLabels();
  });

  el("btnRunDiff").addEventListener("click", () => runActiveComparison());
  el("btnExportBoxPdf").addEventListener("click", () => handleSaveReportToBox());
  el("btnDownloadLocalPdf").addEventListener("click", () => handleDownloadReportLocal());

  el("btnCopyReportLink").addEventListener("click", async () => {
    if (!state.lastUploadedReportId) return;
    try {
      const linkObj = await state.boxClient.createSharedLinkForFile(state.lastUploadedReportId, "open", true);
      if (linkObj && linkObj.url) {
        await navigator.clipboard.writeText(linkObj.url);
        showBanner(`Copied Box Shared Link to clipboard: ${linkObj.url}`, "success");
      }
    } catch (err) {
      showBanner(`Could not create Shared Link: ${err.message}`, "warn");
    }
  });

  // Main Mode Pills
  el("modeBtnText").addEventListener("click", () => activateDiffMode("text"));
  el("modeBtnVisual").addEventListener("click", () => activateDiffMode("visual"));
  el("modeBtnSheet").addEventListener("click", () => activateDiffMode("sheet"));

  // Text Subcontrols
  el("btnTextUnified").addEventListener("click", () => {
    state.textViewStyle = "unified";
    el("btnTextUnified").classList.add("active");
    el("btnTextSplit").classList.remove("active");
    renderTextRedlinePane();
  });
  el("btnTextSplit").addEventListener("click", () => {
    state.textViewStyle = "split";
    el("btnTextSplit").classList.add("active");
    el("btnTextUnified").classList.remove("active");
    renderTextRedlinePane();
  });
  el("chkChangesOnly").addEventListener("change", (e) => {
    state.changesOnly = e.target.checked;
    renderTextRedlinePane();
  });

  // Visual Subcontrols
  const setVisSubMode = async (m) => {
    state.visualSubMode = m;
    el("visModeCurtain").classList.toggle("active", m === "curtain");
    el("visModePixel").classList.toggle("active", m === "pixel");
    el("visModeSide").classList.toggle("active", m === "side");
    await renderVisualDiffPane();
  };
  el("visModeCurtain").addEventListener("click", () => setVisSubMode("curtain"));
  el("visModePixel").addEventListener("click", () => setVisSubMode("pixel"));
  el("visModeSide").addEventListener("click", () => setVisSubMode("side"));

  el("btnPrevPage").addEventListener("click", async () => {
    if (state.visualPage > 1) {
      state.visualPage--;
      await renderVisualDiffPane();
    }
  });
  el("btnNextPage").addEventListener("click", async () => {
    if (state.visualPage < state.visualTotalPages) {
      state.visualPage++;
      await renderVisualDiffPane();
    }
  });

  el("pixelThresholdRange").addEventListener("change", async (e) => {
    state.pixelThreshold = parseInt(e.target.value, 10) || 24;
    el("pixelThresholdLabel").textContent = String(state.pixelThreshold);
    state.pageSummaries = [];
    await renderVisualDiffPane();
  });
  el("pixelThresholdRange").addEventListener("input", (e) => {
    el("pixelThresholdLabel").textContent = e.target.value;
  });

  // Curtain slider + direct pointer drag on canvas
  el("curtainSlider").addEventListener("input", (e) => {
    updateCurtainPosition(Number(e.target.value));
  });

  const vp = el("curtainViewport");
  let draggingCurtain = false;
  const moveCurtainFromPointer = (clientX) => {
    const rect = vp.getBoundingClientRect();
    if (!rect.width) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    updateCurtainPosition(pct);
  };
  vp.addEventListener("pointerdown", (e) => {
    draggingCurtain = true;
    vp.setPointerCapture(e.pointerId);
    moveCurtainFromPointer(e.clientX);
  });
  vp.addEventListener("pointermove", (e) => {
    if (draggingCurtain) moveCurtainFromPointer(e.clientX);
  });
  vp.addEventListener("pointerup", () => {
    draggingCurtain = false;
  });

  // Spreadsheet Subcontrols
  const setSheetFilter = (f) => {
    state.sheetFilter = f;
    el("sheetFilterAll").classList.toggle("active", f === "all");
    el("sheetFilterFormulas").classList.toggle("active", f === "formulas");
    el("sheetFilterOverrides").classList.toggle("active", f === "overrides");
    el("sheetFilterValues").classList.toggle("active", f === "values");
    renderSpreadsheetDiffPane();
  };
  el("sheetFilterAll").addEventListener("click", () => setSheetFilter("all"));
  el("sheetFilterFormulas").addEventListener("click", () => setSheetFilter("formulas"));
  el("sheetFilterOverrides").addEventListener("click", () => setSheetFilter("overrides"));
  el("sheetFilterValues").addEventListener("click", () => setSheetFilter("values"));
  el("sheetSearchInput").addEventListener("input", (e) => {
    state.sheetSearch = e.target.value || "";
    renderSpreadsheetDiffPane();
  });

  // Folder Browser Navigation
  el("btnUpFolder").addEventListener("click", () => {
    if (state.parentFolderId) loadFolderBrowser(state.parentFolderId);
  });
  el("btnRootFolder").addEventListener("click", () => loadFolderBrowser("0"));
}

initApp();

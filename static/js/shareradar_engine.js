/**
 * ShareRadar Folder Link & External-Collaborator Telemetry Auditor.
 *
 * Implements the full 9-Metric Shared-Link & Collaborator Spec:
 *  1. preview_count (Total Link Opens / Views)
 *  2. download_count (Total Link Downloads)
 *  3. Exfiltration flags (can_download, can_edit, download_url)
 *  4. Effective Exposure Scope (access & effective_access)
 *  5. Security Controls (is_password_enabled, unshared_at countdown vs Never Expires, vanity_url)
 *  6. File Dormancy Age (created_at, content_modified_at)
 *  7. External Guest Tenure in Days (collaboration.created_at, role, expires_at)
 *  8. +Delta New Opens & Downloads Since Last Scan (diffed against _safeshare_radar_snapshot.json in User's Box)
 *  9. Tracked Open Duration in Days (first_seen_open_at stored in User's Box — Zero GCP Storage)
 */

import { SNAPSHOT_FILENAME } from "./box_client.js?v=6";

function daysBetween(isoStart, nowMs = Date.now()) {
  if (!isoStart) return null;
  const ms = nowMs - new Date(isoStart).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

function daysUntil(isoFuture, nowMs = Date.now()) {
  if (!isoFuture) return null;
  const ms = new Date(isoFuture).getTime() - nowMs;
  return Math.ceil(ms / 86400000);
}

function formatPathCollection(item) {
  const entries = item.path_collection?.entries || [];
  if (!entries.length) return "/";
  return "/" + entries.slice(1).map((e) => e.name).join("/") + "/";
}

export class ShareRadarScanner {
  constructor(boxClient) {
    this.box = boxClient;
    this.rootFolderId = "0";
    this.snapshotFileId = null;
    this.previousSnapshot = null;
    this.findings = [];
    this.totalScannedItems = 0;
  }

  async scanFolderTree(rootFolderId, onProgress) {
    this.rootFolderId = String(rootFolderId || "0");
    this.snapshotFileId = null;
    this.previousSnapshot = null;
    this.findings = [];
    this.totalScannedItems = 0;

    const me = await this.box.getCurrentUser();
    const myDomain = (me.login || "").split("@")[1]?.toLowerCase() || "";

    // Also inspect the root folder itself if not "0"
    const queue = [this.rootFolderId];
    const maxFolders = 60;
    let visitedFolders = 0;

    // First check if a previous _safeshare_radar_snapshot.json exists in rootFolderId
    const rootFirstPage = await this.box.listFolderPage(this.rootFolderId, 0, 200);
    const snapEntry = (rootFirstPage.entries || []).find(
      (e) => e.type === "file" && e.name === SNAPSHOT_FILENAME
    );
    if (snapEntry) {
      this.snapshotFileId = snapEntry.id;
      try {
        const rawBytes = await this.box.downloadFileBytes(snapEntry.id);
        this.previousSnapshot = JSON.parse(new TextDecoder("utf-8").decode(rawBytes));
      } catch {
        this.previousSnapshot = null;
      }
    }

    const prevItemsMap = this.previousSnapshot?.items || {};
    const nowIso = new Date().toISOString();

    while (queue.length > 0 && visitedFolders < maxFolders) {
      const folderId = queue.shift();
      visitedFolders++;

      let offset = 0;
      const limit = 200;
      while (true) {
        const page =
          folderId === this.rootFolderId && offset === 0
            ? rootFirstPage
            : await this.box.listFolderPage(folderId, offset, limit);

        const entries = page.entries || [];
        for (const item of entries) {
          if (item.name === SNAPSHOT_FILENAME) continue;
          this.totalScannedItems++;
          onProgress?.(this.totalScannedItems, this.findings.length);

          if (item.type === "folder") {
            queue.push(item.id);
          }

          // 1. Evaluate Shared Link Exposure & Telemetry
          if (item.shared_link) {
            const sl = item.shared_link;
            const effAccess = sl.effective_access || sl.access || "open";
            const opens = Number(sl.preview_count || 0);
            const downloads = Number(sl.download_count || 0);
            const canDownload = Boolean(sl.permissions?.can_download);
            const canEdit = Boolean(sl.permissions?.can_edit);
            const hasPassword = Boolean(sl.is_password_enabled);
            const expiryDaysLeft = daysUntil(sl.unshared_at);
            const dormantDays = daysBetween(item.content_modified_at || item.modified_at || item.created_at);

            const key = `${item.type}:${item.id}`;
            const prior = prevItemsMap[key];
            const deltaOpens = prior ? Math.max(0, opens - Number(prior.opens || 0)) : null;
            const deltaDownloads = prior ? Math.max(0, downloads - Number(prior.downloads || 0)) : null;
            const firstSeenOpenIso = prior?.first_seen_open_at || nowIso;
            const trackedOpenDays = prior ? daysBetween(firstSeenOpenIso) : null;

            const isPublicOpen = effAccess === "open";
            const severity = isPublicOpen && (!hasPassword || expiryDaysLeft === null) ? "high" : "medium";

            this.findings.push({
              findingId: `link-${item.type}-${item.id}`,
              kind: "shared_link",
              severity,
              itemType: item.type,
              itemId: item.id,
              name: item.name,
              path: formatPathCollection(item),
              accessLevel: effAccess,
              opens,
              downloads,
              deltaOpens,
              deltaDownloads,
              canDownload,
              canEdit,
              hasPassword,
              unsharedAt: sl.unshared_at || null,
              expiryDaysLeft,
              vanityUrl: sl.vanity_url || null,
              dormantDays,
              firstSeenOpenIso,
              trackedOpenDays,
              url: sl.url,
              statusLabel: isPublicOpen ? "Public Link" : `Link (${effAccess})`,
              remediated: false,
            });
          }

          // 2. Evaluate External Collaborators (Guests outside user's email domain)
          if (item.has_collaborations && myDomain) {
            try {
              const collabs = await this.box.listItemCollaborations(item.type, item.id);
              for (const c of collabs.entries || []) {
                const guestLogin = (c.accessible_by?.login || "").toLowerCase();
                if (!guestLogin) continue;
                const guestDomain = guestLogin.split("@")[1] || "";
                if (guestDomain && guestDomain !== myDomain) {
                  const tenureDays = daysBetween(c.created_at || c.acknowledged_at);
                  const guestExpiryLeft = daysUntil(c.expires_at);
                  this.findings.push({
                    findingId: `collab-${c.id}`,
                    kind: "external_guest",
                    severity: c.role === "editor" || c.role === "co-owner" ? "high" : "medium",
                    itemType: item.type,
                    itemId: item.id,
                    collabId: c.id,
                    name: item.name,
                    path: formatPathCollection(item),
                    guestEmail: guestLogin,
                    guestName: c.accessible_by?.name || guestLogin,
                    guestRole: c.role,
                    collabStatus: c.status,
                    tenureDays,
                    guestExpiryLeft,
                    opens: 0,
                    downloads: 0,
                    statusLabel: `External ${c.role}`,
                    remediated: false,
                  });
                }
              }
            } catch {
              // User may lack manage_collaborators permission on a shared folder; skip gracefully
            }
          }
        }

        offset += entries.length;
        if (offset >= (page.total_count || 0) || entries.length === 0) break;
      }
    }

    // Sort highest-risk & highest download/open activity first
    this.findings.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
      return b.downloads * 3 + b.opens - (a.downloads * 3 + a.opens);
    });

    return this.getSummaryStats();
  }

  getSummaryStats() {
    let openPublicLinks = 0;
    let totalOpens = 0;
    let totalDownloads = 0;
    let deltaOpensSum = 0;
    let deltaDownloadsSum = 0;
    let externalGuests = 0;

    for (const f of this.findings) {
      if (f.remediated) continue;
      if (f.kind === "shared_link") {
        if (f.accessLevel === "open") openPublicLinks++;
        totalOpens += f.opens;
        totalDownloads += f.downloads;
        if (f.deltaOpens) deltaOpensSum += f.deltaOpens;
        if (f.deltaDownloads) deltaDownloadsSum += f.deltaDownloads;
      } else if (f.kind === "external_guest") {
        externalGuests++;
      }
    }

    return {
      totalScannedItems: this.totalScannedItems,
      openPublicLinks,
      totalOpens,
      totalDownloads,
      deltaOpensSum,
      deltaDownloadsSum,
      hasPriorSnapshot: Boolean(this.previousSnapshot),
      priorSnapshotDate: this.previousSnapshot?.captured_at || null,
      externalGuests,
      cleanItems: Math.max(0, this.totalScannedItems - openPublicLinks - externalGuests),
    };
  }

  async remediateFinding(finding, actionType) {
    if (finding.kind === "shared_link") {
      if (actionType === "revoke") {
        await this.box.updateSharedLinkSettings(finding.itemType, finding.itemId, null);
        finding.remediated = true;
        finding.statusLabel = "✓ Link Revoked";
      } else if (actionType === "view_only") {
        await this.box.updateSharedLinkSettings(finding.itemType, finding.itemId, {
          permissions: { can_download: false, can_preview: true },
        });
        finding.canDownload = false;
        finding.remediated = true;
        finding.statusLabel = "✓ View-Only";
      } else if (actionType === "expire_30d") {
        const in30Days = new Date(Date.now() + 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
        await this.box.updateSharedLinkSettings(finding.itemType, finding.itemId, {
          unshared_at: in30Days,
        });
        finding.unsharedAt = in30Days;
        finding.expiryDaysLeft = 30;
        finding.remediated = true;
        finding.statusLabel = "✓ 30d Expiry Set";
      }
    } else if (finding.kind === "external_guest" && actionType === "revoke") {
      await this.box.removeCollaboration(finding.collabId);
      finding.remediated = true;
      finding.statusLabel = "✓ Guest Removed";
    }
  }

  async saveSnapshotAndCsvToBox() {
    const itemsRecord = {};
    for (const f of this.findings) {
      if (f.kind === "shared_link" && !f.remediated) {
        itemsRecord[`${f.itemType}:${f.itemId}`] = {
          opens: f.opens,
          downloads: f.downloads,
          first_seen_open_at: f.firstSeenOpenIso,
        };
      }
    }
    const snapshotJson = JSON.stringify(
      {
        schema: "safeshare.radar.v1",
        captured_at: new Date().toISOString(),
        items: itemsRecord,
      },
      null,
      2
    );

    const savedSnap = await this.box.upsertUtilityFile(
      this.rootFolderId,
      SNAPSHOT_FILENAME,
      "application/json",
      snapshotJson,
      this.snapshotFileId
    );
    if (savedSnap?.id) this.snapshotFileId = savedSnap.id;

    // Also build a clean human-readable Audit CSV in the user's Box folder
    const header = [
      "Kind",
      "Severity",
      "Name",
      "Path",
      "Exposure_Or_Guest",
      "Link_Opens",
      "Link_Downloads",
      "Delta_Opens",
      "Delta_Downloads",
      "Can_Download",
      "Password_Enabled",
      "Expires_At",
      "Days_Dormant_Or_Tenure",
      "Current_Status",
    ];
    const rows = this.findings.map((f) => [
      f.kind,
      f.severity,
      `"${(f.name || "").replace(/"/g, '""')}"`,
      `"${(f.path || "").replace(/"/g, '""')}"`,
      `"${(f.kind === "shared_link" ? f.accessLevel : `${f.guestEmail} (${f.guestRole})`).replace(/"/g, '""')}"`,
      f.opens ?? "",
      f.downloads ?? "",
      f.deltaOpens ?? "",
      f.deltaDownloads ?? "",
      f.canDownload ?? "",
      f.hasPassword ?? "",
      f.unsharedAt ?? "Never",
      f.kind === "shared_link" ? f.dormantDays ?? "" : f.tenureDays ?? "",
      `"${f.statusLabel}"`,
    ]);
    const csvContent = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const today = new Date().toISOString().slice(0, 10);
    await this.box.uploadNewSafeCopy(
      this.rootFolderId,
      `ShareRadar_Audit_${today}`,
      ".csv",
      "text/csv",
      new TextEncoder().encode(csvContent)
    );
  }
}

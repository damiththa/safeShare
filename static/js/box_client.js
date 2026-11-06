/**
 * Browser-Direct Box.com CORS API Client (Memory-Only Session Token).
 * Communicates directly between the user's browser and api.box.com / upload.box.com
 * so zero user files, filenames, or shared links ever transit our GCP server.
 */

const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";
export const SNAPSHOT_FILENAME = "_safeshare_radar_snapshot.json";

export class BoxBrowserClient {
  constructor(accessToken) {
    this._token = accessToken;
    this._meCache = null;
  }

  _authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${this._token}`,
      ...extra,
    };
  }

  async _jsonFetch(url, options = {}) {
    const resp = await fetch(url, {
      ...options,
      headers: this._authHeaders(options.headers || {}),
    });
    if (resp.status === 204) return null;
    let body = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    if (!resp.ok) {
      const msg = (body && (body.message || body.error_description)) || `Box API error (${resp.status})`;
      const err = new Error(msg);
      err.status = resp.status;
      err.boxBody = body;
      throw err;
    }
    return body;
  }

  async getCurrentUser() {
    if (this._meCache) return this._meCache;
    this._meCache = await this._jsonFetch(`${BOX_API}/users/me?fields=id,name,login`);
    return this._meCache;
  }

  async getFileMetadata(fileId) {
    const fields = "id,name,size,sha1,extension,parent,shared_link,created_at,content_modified_at,permissions";
    return this._jsonFetch(`${BOX_API}/files/${encodeURIComponent(fileId)}?fields=${fields}`);
  }

  async getFolderMetadata(folderId) {
    const fields = "id,name,parent,shared_link,created_at,content_modified_at,permissions";
    return this._jsonFetch(`${BOX_API}/folders/${encodeURIComponent(folderId)}?fields=${fields}`);
  }

  /**
   * Downloads raw file bytes directly into browser memory.
   * Uses query-param `access_token` without custom headers so the browser executes a CORS
   * simple GET request and cleanly follows Box's 302 redirect to dl.boxcloud.com.
   */
  async downloadFileBytes(fileId) {
    const url = `${BOX_API}/files/${encodeURIComponent(fileId)}/content?access_token=${encodeURIComponent(this._token)}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const resp = await fetch(url, { method: "GET", redirect: "follow" });
      if (resp.status === 202) {
        const retrySec = parseInt(resp.headers.get("Retry-After") || "2", 10);
        await new Promise((r) => setTimeout(r, Math.min(retrySec, 5) * 1000));
        continue;
      }
      if (!resp.ok) {
        throw new Error(`Unable to read file from Box (HTTP ${resp.status}). Ensure CORS domain is whitelisted.`);
      }
      const buf = await resp.arrayBuffer();
      return new Uint8Array(buf);
    }
    throw new Error("File is still preparing on Box; please try again in a few seconds.");
  }

  /**
   * Uploads a brand-new v1 file (`_SafeCopy`) to Box so zero unredacted Version History exists.
   * Automatically handles 409 name collisions by appending ` (2)`, ` (3)`, etc.
   */
  async uploadNewSafeCopy(parentFolderId, stemName, extWithDot, mimeType, uint8Bytes) {
    const cleanStem = stemName.replace(/[\\/:*?"<>|]/g, "_").trim() || "Sanitized_Copy";

    for (let suffixIdx = 1; suffixIdx <= 12; suffixIdx++) {
      const candidateName =
        suffixIdx === 1 ? `${cleanStem}${extWithDot}` : `${cleanStem} (${suffixIdx})${extWithDot}`;

      // Box Upload API strictly requires `attributes` BEFORE `file` in FormData.
      const form = new FormData();
      form.append(
        "attributes",
        JSON.stringify({
          name: candidateName,
          parent: { id: String(parentFolderId) },
        })
      );
      form.append("file", new Blob([uint8Bytes], { type: mimeType }), candidateName);

      const resp = await fetch(`${BOX_UPLOAD_API}/files/content`, {
        method: "POST",
        headers: this._authHeaders(),
        body: form,
      });

      if (resp.status === 409) {
        continue;
      }

      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = (data && data.message) || `Upload to Box failed (HTTP ${resp.status})`;
        throw new Error(msg);
      }
      const uploadedEntry = data && data.entries && data.entries[0];
      if (!uploadedEntry) throw new Error("Upload succeeded but Box returned no file entry.");
      return uploadedEntry;
    }
    throw new Error("Too many files with the same name in this folder; please choose a new name.");
  }

  /**
   * Uploads or updates a small utility file in the user's Box folder (used for Audit CSV & Snapshot JSON).
   */
  async upsertUtilityFile(parentFolderId, fileName, mimeType, textContent, existingFileId = null) {
    const blob = new Blob([textContent], { type: mimeType });
    if (existingFileId) {
      const form = new FormData();
      form.append("attributes", JSON.stringify({ name: fileName }));
      form.append("file", blob, fileName);
      const resp = await fetch(`${BOX_UPLOAD_API}/files/${encodeURIComponent(existingFileId)}/content`, {
        method: "POST",
        headers: this._authHeaders(),
        body: form,
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.entries && data.entries[0];
      }
    }
    return this.uploadNewSafeCopy(
      parentFolderId,
      fileName.replace(/\.[^.]+$/, ""),
      fileName.match(/\.[^.]+$/)?.[0] || ".txt",
      mimeType,
      new TextEncoder().encode(textContent)
    );
  }

  async createSharedLinkForFile(fileId, access = "open", canDownload = true) {
    const data = await this._jsonFetch(`${BOX_API}/files/${encodeURIComponent(fileId)}?fields=shared_link`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shared_link: {
          access,
          permissions: { can_download: canDownload, can_preview: true },
        },
      }),
    });
    return data.shared_link;
  }

  async listFolderPage(folderId, offset = 0, limit = 200) {
    const fields = [
      "id",
      "name",
      "type",
      "size",
      "extension",
      "path_collection",
      "shared_link",
      "has_collaborations",
      "permissions",
      "created_at",
      "content_modified_at",
      "modified_at",
    ].join(",");
    return this._jsonFetch(
      `${BOX_API}/folders/${encodeURIComponent(folderId)}/items?fields=${fields}&offset=${offset}&limit=${limit}`
    );
  }

  async listItemCollaborations(itemType, itemId) {
    const plural = itemType === "folder" ? "folders" : "files";
    const fields = "id,role,status,created_at,acknowledged_at,expires_at,accessible_by";
    return this._jsonFetch(`${BOX_API}/${plural}/${encodeURIComponent(itemId)}/collaborations?fields=${fields}`);
  }

  async updateSharedLinkSettings(itemType, itemId, sharedLinkPayload) {
    const plural = itemType === "folder" ? "folders" : "files";
    return this._jsonFetch(`${BOX_API}/${plural}/${encodeURIComponent(itemId)}?fields=id,name,shared_link`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shared_link: sharedLinkPayload }),
    });
  }

  async removeCollaboration(collabId) {
    return this._jsonFetch(`${BOX_API}/collaborations/${encodeURIComponent(collabId)}`, {
      method: "DELETE",
    });
  }
}

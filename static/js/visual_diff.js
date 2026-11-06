/**
 * Client-Side Visual Curtain Slider & Perceptual Pixel-Overlay Diff Engine (`BoxDiff v1`).
 * Supports `.pdf` (`pdf.js`) and `.png` / `.jpg` / `.jpeg` / `.webp` entirely in browser RAM.
 */

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

function ensurePdfWorker() {
  if (window.pdfjsLib && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js";
  }
}

function mimeForExt(ext) {
  const e = (ext || "").toLowerCase().replace(/^\./, "");
  if (e === "png") return "image/png";
  if (e === "webp") return "image/webp";
  return "image/jpeg";
}

export function supportsVisualComparison(ext) {
  const e = (ext || "").toLowerCase().replace(/^\./, "");
  return e === "pdf" || IMAGE_EXTS.has(e);
}

export class VisualComparator {
  constructor() {
    this._leftSource = null;
    this._rightSource = null;
    this.leftPageCount = 0;
    this.rightPageCount = 0;
    this.totalPages = 0;
  }

  async loadPair(leftBytes, leftExt, rightBytes, rightExt) {
    await this.dispose();
    this._leftSource = await this._openSource(leftBytes, leftExt);
    this._rightSource = await this._openSource(rightBytes, rightExt);
    this.leftPageCount = this._leftSource.pageCount;
    this.rightPageCount = this._rightSource.pageCount;
    this.totalPages = Math.max(this.leftPageCount, this.rightPageCount, 1);
    return {
      totalPages: this.totalPages,
      leftPages: this.leftPageCount,
      rightPages: this.rightPageCount,
    };
  }

  async _openSource(uint8Bytes, ext) {
    const cleanExt = (ext || "").toLowerCase().replace(/^\./, "");
    if (cleanExt === "pdf") {
      ensurePdfWorker();
      if (!window.pdfjsLib) throw new Error("PDF engine (pdf.js) is not loaded.");
      const pdfDoc = await window.pdfjsLib.getDocument({ data: uint8Bytes.slice(0) }).promise;
      return {
        kind: "pdf",
        pdfDoc,
        pageCount: pdfDoc.numPages,
      };
    }

    if (IMAGE_EXTS.has(cleanExt)) {
      const blob = new Blob([uint8Bytes.slice(0)], { type: mimeForExt(cleanExt) });
      const bitmap = await decodeImageBitmapSafe(blob);
      return {
        kind: "image",
        bitmap,
        pageCount: 1,
      };
    }

    throw new Error(`Unsupported visual comparison format: .${cleanExt}`);
  }

  async _rasterizeSinglePage(source, pageNum, targetWidth) {
    if (!source || pageNum > source.pageCount) {
      return null;
    }

    if (source.kind === "pdf") {
      const page = await source.pdfDoc.getPage(pageNum);
      const baseVp = page.getViewport({ scale: 1.0 });
      const scale = Math.min(2.6, Math.max(0.7, targetWidth / Math.max(1, baseVp.width)));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return canvas;
    }

    const bmp = source.bitmap;
    const scale = Math.min(2.0, targetWidth / Math.max(1, bmp.width));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /**
   * Renders `pageNum` (`1..totalPages`) for both Baseline and Target onto normalized
   * identical-dimension canvases and builds a crimson pixel-diff highlight canvas.
   */
  async renderPageComparison(pageNum, { targetWidth = 1080, threshold = 24 } = {}) {
    const rawLeft = await this._rasterizeSinglePage(this._leftSource, pageNum, targetWidth);
    const rawRight = await this._rasterizeSinglePage(this._rightSource, pageNum, targetWidth);

    const width = Math.max(rawLeft ? rawLeft.width : 0, rawRight ? rawRight.width : 0, 400);
    const height = Math.max(rawLeft ? rawLeft.height : 0, rawRight ? rawRight.height : 0, 300);

    const leftCanvas = createNormalizedCanvas(rawLeft, width, height, "Page not present in Baseline");
    const rightCanvas = createNormalizedCanvas(rawRight, width, height, "Page not present in Target");

    const leftCtx = leftCanvas.getContext("2d", { willReadFrequently: true });
    const rightCtx = rightCanvas.getContext("2d", { willReadFrequently: true });
    const leftData = leftCtx.getImageData(0, 0, width, height);
    const rightData = rightCtx.getImageData(0, 0, width, height);

    const diffCanvas = document.createElement("canvas");
    diffCanvas.width = width;
    diffCanvas.height = height;
    const diffCtx = diffCanvas.getContext("2d");
    const diffImg = diffCtx.createImageData(width, height);

    const lp = leftData.data;
    const rp = rightData.data;
    const dp = diffImg.data;
    const totalPixels = width * height;
    const cutoff = Math.max(6, threshold) * 3;
    let changedPixels = 0;

    for (let idx = 0; idx < lp.length; idx += 4) {
      const dr = Math.abs(lp[idx] - rp[idx]);
      const dg = Math.abs(lp[idx + 1] - rp[idx + 1]);
      const db = Math.abs(lp[idx + 2] - rp[idx + 2]);
      const deltaSum = dr + dg + db;

      if (deltaSum > cutoff) {
        changedPixels++;
        // Crisp high-contrast crimson highlight blended subtly with intensity
        const boost = Math.min(1, deltaSum / 255);
        dp[idx] = 225;
        dp[idx + 1] = Math.round(29 + (1 - boost) * 35);
        dp[idx + 2] = 72;
        dp[idx + 3] = 255;
      } else {
        // Dimmed neutral paper context from Right (Target) so changed areas pop out immediately
        const lum = Math.round(0.299 * rp[idx] + 0.587 * rp[idx + 1] + 0.114 * rp[idx + 2]);
        const washed = Math.round(255 - (255 - lum) * 0.28);
        dp[idx] = washed;
        dp[idx + 1] = washed;
        dp[idx + 2] = Math.min(255, washed + 3);
        dp[idx + 3] = 255;
      }
    }

    diffCtx.putImageData(diffImg, 0, 0);
    const changedPercent = totalPixels > 0 ? (changedPixels / totalPixels) * 100 : 0;

    return {
      pageNum,
      width,
      height,
      leftCanvas,
      rightCanvas,
      diffCanvas,
      changedPixels,
      totalPixels,
      changedPercent,
      leftMissingPage: !rawLeft,
      rightMissingPage: !rawRight,
      dimensionsChanged:
        Boolean(rawLeft && rawRight) &&
        (Math.abs(rawLeft.width - rawRight.width) > 2 || Math.abs(rawLeft.height - rawRight.height) > 2),
    };
  }

  /**
   * Lightweight thumbnail pass across up to `maxPages` pages so users immediately see
   * which pages of a multi-page PDF have visual differences.
   */
  async scanQuickPageDeltas(threshold = 24, maxPages = 20) {
    const count = Math.min(this.totalPages, maxPages);
    const summaries = [];
    for (let p = 1; p <= count; p++) {
      const res = await this.renderPageComparison(p, { targetWidth: 320, threshold });
      summaries.push({
        pageNum: p,
        changedPercent: res.changedPercent,
        hasChanges: res.changedPercent >= 0.02 || res.leftMissingPage || res.rightMissingPage,
        leftMissingPage: res.leftMissingPage,
        rightMissingPage: res.rightMissingPage,
      });
    }
    return summaries;
  }

  async dispose() {
    if (this._leftSource && this._leftSource.pdfDoc) {
      try {
        await this._leftSource.pdfDoc.destroy();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (this._rightSource && this._rightSource.pdfDoc) {
      try {
        await this._rightSource.pdfDoc.destroy();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (this._leftSource && this._leftSource.bitmap && this._leftSource.bitmap.close) {
      this._leftSource.bitmap.close();
    }
    if (this._rightSource && this._rightSource.bitmap && this._rightSource.bitmap.close) {
      this._rightSource.bitmap.close();
    }
    this._leftSource = null;
    this._rightSource = null;
  }
}

function createNormalizedCanvas(srcCanvas, width, height, missingMessage) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  if (srcCanvas) {
    ctx.drawImage(srcCanvas, 0, 0);
  } else {
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 2;
    ctx.strokeRect(24, 24, width - 48, height - 48);
    ctx.fillStyle = "#64748b";
    ctx.font = "600 16px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(missingMessage, width / 2, height / 2);
  }
  return c;
}

async function decodeImageBitmapSafe(blob) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob);
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

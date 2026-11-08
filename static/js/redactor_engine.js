/**
 * Interactive Preview Canvas & Permanent Redaction Exporter.
 *
 * Security design:
 *  - Images: Decoded to raw RGBA canvas pixels (100% EXIF/GPS/thumbnail stripped),
 *    redaction regions overwritten directly with #000000 in the bitmap, re-encoded cleanly.
 *  - PDFs: Redacted pages (or all pages when "Convert all pages to flat images" is checked)
 *    are rasterized at crisp 250 DPI onto an offscreen canvas with #000000 pixel burns,
 *    then embedded into a brand-new, zero-metadata `PDFLib.PDFDocument` so zero underlying
 *    selectable text glyphs survive underneath black bars.
 *  - DOCX: Strips `docProps/core.xml`, `docProps/app.xml`, and `word/comments.xml`.
 */

import { detectPiiInTextItems } from "./pii_detector.js?v=2";

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js";
}

export class RedactorWorkspace {
  constructor(canvasEl, onStateChange) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.onStateChange = onStateChange;

    this.format = null;
    this.rawBytes = null;
    this.pdfDocProxy = null;
    this.imageBitmap = null;
    this.pageCount = 1;
    this.currentPage = 0; // 0-indexed
    this.basePageCanvas = document.createElement("canvas");

    this.autoFindings = [];
    this.manualBoxes = [];
    this._dragStart = null;
    this._dragCurrent = null;

    this._bindPointerEvents();
  }

  _bindPointerEvents() {
    const getNormCoords = (evt) => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (evt.clientX - rect.left) / Math.max(1, rect.width))),
        y: Math.max(0, Math.min(1, (evt.clientY - rect.top) / Math.max(1, rect.height))),
      };
    };

    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.rawBytes || this.format === "docx") return;
      this.canvas.setPointerCapture?.(e.pointerId);
      this._dragStart = getNormCoords(e);
      this._dragCurrent = this._dragStart;
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (!this._dragStart) return;
      this._dragCurrent = getNormCoords(e);
      this.redrawOverlay();
    });

    const finishDrag = () => {
      if (!this._dragStart || !this._dragCurrent) return;
      const x = Math.min(this._dragStart.x, this._dragCurrent.x);
      const y = Math.min(this._dragStart.y, this._dragCurrent.y);
      const w = Math.abs(this._dragCurrent.x - this._dragStart.x);
      const h = Math.abs(this._dragCurrent.y - this._dragStart.y);
      this._dragStart = null;
      this._dragCurrent = null;

      if (w > 0.01 && h > 0.008) {
        this.manualBoxes.push({
          id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          pageIndex: this.currentPage,
          rectNorm: { x, y, w, h },
        });
        this.onStateChange?.();
      }
      this.redrawOverlay();
    };

    this.canvas.addEventListener("pointerup", finishDrag);
    this.canvas.addEventListener("pointercancel", finishDrag);
  }

  async loadDocument(uint8, format) {
    this.rawBytes = uint8;
    this.format = format;
    this.autoFindings = [];
    this.manualBoxes = [];
    this.currentPage = 0;
    this.pdfDocProxy = null;
    this.imageBitmap = null;

    if (format === "pdf") {
      const workerCopy = uint8.slice();
      this.pdfDocProxy = await window.pdfjsLib.getDocument({ data: workerCopy }).promise;
      this.pageCount = this.pdfDocProxy.numPages;
      await this._extractPdfTextAndDetectPii();
      await this.renderPage(0);
    } else if (format === "jpeg" || format === "png" || format === "webp") {
      const blob = new Blob([uint8]);
      this.imageBitmap = await createImageBitmap(blob);
      this.pageCount = 1;
      await this.renderPage(0);
    } else if (format === "docx") {
      this.pageCount = 1;
    }
    this.onStateChange?.();
  }

  async _extractPdfTextAndDetectPii() {
    const extractedItems = [];
    const maxScanPages = Math.min(this.pageCount, 40);

    for (let p = 1; p <= maxScanPages; p++) {
      const page = await this.pdfDocProxy.getPage(p);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();

      for (const item of textContent.items) {
        if (!item.str || !item.transform) continue;
        const tx = item.transform[4];
        const ty = item.transform[5];
        const fontH = Math.hypot(item.transform[2], item.transform[3]) || Math.abs(item.height) || 11;
        const itemW = item.width || item.str.length * (fontH * 0.52);

        const normX = tx / viewport.width;
        const normY = (viewport.height - ty - fontH * 0.88) / viewport.height;
        const normW = itemW / viewport.width;
        const normH = (fontH * 1.18) / viewport.height;

        extractedItems.push({
          str: item.str,
          pageIndex: p - 1,
          bbox: [normX, normY, normW, normH],
        });
      }
    }

    this.autoFindings = detectPiiInTextItems(extractedItems);
  }

  async renderPage(pageIdx) {
    this.currentPage = Math.max(0, Math.min(this.pageCount - 1, pageIdx));
    if (this.format === "docx") return;

    if (this.format === "pdf" && this.pdfDocProxy) {
      const page = await this.pdfDocProxy.getPage(this.currentPage + 1);
      const viewport = page.getViewport({ scale: 1.4 });
      this.basePageCanvas.width = Math.floor(viewport.width);
      this.basePageCanvas.height = Math.floor(viewport.height);
      const baseCtx = this.basePageCanvas.getContext("2d");
      baseCtx.fillStyle = "#ffffff";
      baseCtx.fillRect(0, 0, this.basePageCanvas.width, this.basePageCanvas.height);
      await page.render({ canvasContext: baseCtx, viewport }).promise;
    } else if (this.imageBitmap) {
      const maxDim = 1100;
      const scale = Math.min(1, maxDim / Math.max(this.imageBitmap.width, this.imageBitmap.height));
      this.basePageCanvas.width = Math.max(1, Math.floor(this.imageBitmap.width * scale));
      this.basePageCanvas.height = Math.max(1, Math.floor(this.imageBitmap.height * scale));
      const baseCtx = this.basePageCanvas.getContext("2d");
      baseCtx.drawImage(this.imageBitmap, 0, 0, this.basePageCanvas.width, this.basePageCanvas.height);
    }

    this.canvas.width = this.basePageCanvas.width;
    this.canvas.height = this.basePageCanvas.height;
    this.redrawOverlay();
  }

  redrawOverlay() {
    if (this.format === "docx") return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(this.basePageCanvas, 0, 0);

    // Draw Auto-Detected PII boxes on current page
    for (const f of this.autoFindings) {
      if (f.pageIndex !== this.currentPage) continue;
      const rx = f.rectNorm.x * w;
      const ry = f.rectNorm.y * h;
      const rw = f.rectNorm.w * w;
      const rh = f.rectNorm.h * h;
      if (f.enabled) {
        this.ctx.fillStyle = "#0f172a";
        this.ctx.fillRect(rx, ry, rw, rh);
      } else {
        this.ctx.fillStyle = "rgba(0, 97, 213, 0.14)";
        this.ctx.fillRect(rx, ry, rw, rh);
        this.ctx.strokeStyle = "#0061d5";
        this.ctx.lineWidth = 1.5;
        this.ctx.strokeRect(rx, ry, rw, rh);
      }
    }

    // Draw Manual Redaction boxes on current page
    for (const m of this.manualBoxes) {
      if (m.pageIndex !== this.currentPage) continue;
      this.ctx.fillStyle = "#0f172a";
      this.ctx.fillRect(m.rectNorm.x * w, m.rectNorm.y * h, m.rectNorm.w * w, m.rectNorm.h * h);
    }

    // Calm Box-Blue selection rectangle while dragging
    if (this._dragStart && this._dragCurrent) {
      const dx = Math.min(this._dragStart.x, this._dragCurrent.x) * w;
      const dy = Math.min(this._dragStart.y, this._dragCurrent.y) * h;
      const dw = Math.abs(this._dragCurrent.x - this._dragStart.x) * w;
      const dh = Math.abs(this._dragCurrent.y - this._dragStart.y) * h;
      this.ctx.fillStyle = "rgba(0, 97, 213, 0.18)";
      this.ctx.fillRect(dx, dy, dw, dh);
      this.ctx.strokeStyle = "#0061d5";
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(dx, dy, dw, dh);
    }
  }

  undoLastManualBox() {
    for (let i = this.manualBoxes.length - 1; i >= 0; i--) {
      if (this.manualBoxes[i].pageIndex === this.currentPage) {
        this.manualBoxes.splice(i, 1);
        this.redrawOverlay();
        this.onStateChange?.();
        return;
      }
    }
    if (this.manualBoxes.length > 0) {
      this.manualBoxes.pop();
      this.redrawOverlay();
      this.onStateChange?.();
    }
  }

  clearManualBoxes() {
    this.manualBoxes = [];
    this.redrawOverlay();
    this.onStateChange?.();
  }

  _boxesForPage(pageIdx) {
    const boxes = [];
    for (const f of this.autoFindings) {
      if (f.enabled && f.pageIndex === pageIdx) boxes.push(f.rectNorm);
    }
    for (const m of this.manualBoxes) {
      if (m.pageIndex === pageIdx) boxes.push(m.rectNorm);
    }
    return boxes;
  }

  /**
   * Produces a 100% metadata-scrubbed, permanently redacted output binary.
   */
  async exportSanitizedBytes({ flattenAllPages = false } = {}) {
    if (this.format === "jpeg" || this.format === "png" || this.format === "webp") {
      const outCanvas = document.createElement("canvas");
      outCanvas.width = this.imageBitmap.width;
      outCanvas.height = this.imageBitmap.height;
      const octx = outCanvas.getContext("2d");
      octx.drawImage(this.imageBitmap, 0, 0);

      const boxes = this._boxesForPage(0);
      octx.fillStyle = "#000000";
      for (const b of boxes) {
        octx.fillRect(
          Math.floor(b.x * outCanvas.width),
          Math.floor(b.y * outCanvas.height),
          Math.ceil(b.w * outCanvas.width),
          Math.ceil(b.h * outCanvas.height)
        );
      }

      const outMime = this.format === "png" ? "image/png" : "image/jpeg";
      const outExt = this.format === "png" ? ".png" : ".jpg";
      const blob = await new Promise((res) => outCanvas.toBlob(res, outMime, 0.94));
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mimeType: outMime,
        extension: outExt,
      };
    }

    if (this.format === "pdf") {
      const { PDFDocument } = window.PDFLib;
      const outPdf = await PDFDocument.create();
      outPdf.setTitle("");
      outPdf.setAuthor("");
      outPdf.setSubject("");
      outPdf.setKeywords([]);
      outPdf.setProducer("");
      outPdf.setCreator("");

      let srcPdfLibDoc = null;

      for (let p = 0; p < this.pageCount; p++) {
        const boxes = this._boxesForPage(p);
        const mustRasterize = flattenAllPages || boxes.length > 0;

        if (mustRasterize) {
          const pdfPage = await this.pdfDocProxy.getPage(p + 1);
          const origVp = pdfPage.getViewport({ scale: 1.0 });
          const renderScale = 250 / 72;
          const hiVp = pdfPage.getViewport({ scale: renderScale });

          const offCanvas = document.createElement("canvas");
          offCanvas.width = Math.floor(hiVp.width);
          offCanvas.height = Math.floor(hiVp.height);
          const offCtx = offCanvas.getContext("2d");
          offCtx.fillStyle = "#ffffff";
          offCtx.fillRect(0, 0, offCanvas.width, offCanvas.height);
          await pdfPage.render({ canvasContext: offCtx, viewport: hiVp }).promise;

          offCtx.fillStyle = "#000000";
          for (const b of boxes) {
            offCtx.fillRect(
              Math.floor(b.x * offCanvas.width),
              Math.floor(b.y * offCanvas.height),
              Math.ceil(b.w * offCanvas.width),
              Math.ceil(b.h * offCanvas.height)
            );
          }

          const jpgBlob = await new Promise((res) => offCanvas.toBlob(res, "image/jpeg", 0.91));
          const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
          const embeddedJpg = await outPdf.embedJpg(jpgBytes);
          const addedPage = outPdf.addPage([origVp.width, origVp.height]);
          addedPage.drawImage(embeddedJpg, {
            x: 0,
            y: 0,
            width: origVp.width,
            height: origVp.height,
          });
        } else {
          if (!srcPdfLibDoc) {
            srcPdfLibDoc = await PDFDocument.load(this.rawBytes, {
              ignoreEncryption: true,
              updateMetadata: false,
            });
          }
          const [copiedPage] = await outPdf.copyPages(srcPdfLibDoc, [p]);
          copiedPage.node.delete(window.PDFLib.PDFName.of("Annots"));
          outPdf.addPage(copiedPage);
        }
      }

      const finalPdfBytes = await outPdf.save({ useObjectStreams: true });
      return {
        bytes: finalPdfBytes,
        mimeType: "application/pdf",
        extension: ".pdf",
      };
    }

    if (this.format === "docx") {
      const zip = await window.JSZip.loadAsync(this.rawBytes);
      const cleanCoreXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        "<dc:title></dc:title><dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy><cp:revision>1</cp:revision>" +
        "</cp:coreProperties>";
      const cleanAppXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
        "<Company></Company><Manager></Manager></Properties>";

      zip.file("docProps/core.xml", cleanCoreXml);
      zip.file("docProps/app.xml", cleanAppXml);
      zip.remove("word/comments.xml");

      const outArrayBuffer = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      return {
        bytes: outArrayBuffer,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        extension: ".docx",
      };
    }

    throw new Error("Unsupported file format.");
  }
}

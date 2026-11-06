/**
 * In-Browser `Redline_Report.pdf` Generator (`BoxDiff v1` via vendored `pdf-lib`).
 * Produces a clean, zero-PII-metadata multi-page verification & redline PDF report
 * ready for 1-click upload back into the user's Box folder.
 */

function toPdfSafeText(input) {
  if (input === null || input === undefined) return "";
  return String(input)
    .replace(/→|➔|➜/g, "->")
    .replace(/←/g, "<-")
    .replace(/Δ/g, "Delta ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/•/g, "*")
    .replace(/\t/g, "  ")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

function wrapTextLines(rawText, font, fontSize, maxWidth) {
  const safe = toPdfSafeText(rawText);
  if (!safe) return [""];
  const words = safe.split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      // Hard-break super-long unbroken strings (e.g. URLs, hashes, formulas)
      if (font.widthOfTextAtSize(word, fontSize) > maxWidth) {
        let chunk = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, fontSize) > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

/**
 * Builds a `Uint8Array` PDF summarizing Text Redlines, Spreadsheet Formula/Cell Deltas,
 * and/or Visual Pixel-Diff Snapshots.
 */
export async function generateRedlineReportPdf({
  leftDescriptor,
  rightDescriptor,
  activeMode,
  textDiffResult,
  spreadsheetResult,
  visualSnapshotResult,
}) {
  if (!window.PDFLib) {
    throw new Error("PDF generator (pdf-lib) is not loaded.");
  }

  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle("BoxDiff Verification & Redline Report");
  pdfDoc.setAuthor("");
  pdfDoc.setCreator("");
  pdfDoc.setProducer("");

  const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN_X = 42;
  const CONTENT_W = PAGE_W - MARGIN_X * 2;

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 42;

  const ensureSpace = (neededHeight) => {
    if (y - neededHeight < 48) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - 44;
    }
  };

  // Top Header Banner
  page.drawRectangle({
    x: MARGIN_X,
    y: y - 54,
    width: CONTENT_W,
    height: 54,
    color: rgb(0.05, 0.09, 0.19),
  });
  page.drawText("BoxDiff — Verification & Redline Audit Report", {
    x: MARGIN_X + 16,
    y: y - 24,
    size: 14,
    font: fontBold,
    color: rgb(0.97, 0.98, 1.0),
  });
  const nowUtc = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  page.drawText(toPdfSafeText(`Generated 100% In-Browser (Zero-PII)  |  ${nowUtc}`), {
    x: MARGIN_X + 16,
    y: y - 41,
    size: 8.5,
    font: fontReg,
    color: rgb(0.62, 0.72, 0.86),
  });
  y -= 70;

  // Baseline vs Target Metadata Box
  page.drawRectangle({
    x: MARGIN_X,
    y: y - 56,
    width: CONTENT_W,
    height: 56,
    color: rgb(0.96, 0.97, 0.99),
    borderColor: rgb(0.82, 0.86, 0.92),
    borderWidth: 1,
  });
  page.drawText(toPdfSafeText(`BASELINE (LEFT):  ${leftDescriptor.label}`), {
    x: MARGIN_X + 12,
    y: y - 18,
    size: 9,
    font: fontBold,
    color: rgb(0.55, 0.12, 0.18),
  });
  page.drawText(
    toPdfSafeText(
      `SHA-1: ${leftDescriptor.sha1 || "n/a"}   |   Size: ${formatBytes(leftDescriptor.size)}`
    ),
    {
      x: MARGIN_X + 12,
      y: y - 30,
      size: 7.8,
      font: fontMono,
      color: rgb(0.35, 0.41, 0.49),
    }
  );
  page.drawText(toPdfSafeText(`TARGET (RIGHT):   ${rightDescriptor.label}`), {
    x: MARGIN_X + 12,
    y: y - 43,
    size: 9,
    font: fontBold,
    color: rgb(0.05, 0.45, 0.29),
  });
  page.drawText(
    toPdfSafeText(
      `SHA-1: ${rightDescriptor.sha1 || "n/a"}   |   Size: ${formatBytes(rightDescriptor.size)}`
    ),
    {
      x: MARGIN_X + 260,
      y: y - 43,
      size: 7.8,
      font: fontMono,
      color: rgb(0.35, 0.41, 0.49),
    }
  );
  y -= 72;

  // Section 1: Spreadsheet Diff Report (if spreadsheet mode)
  if (spreadsheetResult) {
    const st = spreadsheetResult.stats;
    ensureSpace(46);
    page.drawText("1. Executive Spreadsheet & Formula Summary", {
      x: MARGIN_X,
      y,
      size: 11.5,
      font: fontBold,
      color: rgb(0.08, 0.12, 0.2),
    });
    y -= 16;
    page.drawText(
      toPdfSafeText(
        `Total Cell Deltas: ${st.totalChanges}  |  Formula Modifications: ${st.formulaChanges}  |  Hardcoded Formula Overrides: ${st.hardcodedOverrides}  |  Value Changes: ${st.valueChanges}  |  Sheets Changed: ${st.sheetsChanged}/${st.totalSheets}`
      ),
      {
        x: MARGIN_X,
        y,
        size: 8.5,
        font: fontReg,
        color: rgb(0.22, 0.28, 0.36),
      }
    );
    y -= 20;

    for (const sh of spreadsheetResult.sheets) {
      ensureSpace(32);
      page.drawText(toPdfSafeText(`Sheet: ${sh.sheetName} (${sh.changeCount} changes — ${sh.status})`), {
        x: MARGIN_X,
        y,
        size: 10,
        font: fontBold,
        color: rgb(0.12, 0.24, 0.48),
      });
      y -= 14;

      const capped = sh.changes.slice(0, 180);
      for (const ch of capped) {
        const beforeDesc = ch.leftFormula ? `${ch.leftFormula} [=${ch.leftValue}]` : ch.leftValue || "(empty)";
        const afterDesc = ch.rightFormula ? `${ch.rightFormula} [=${ch.rightValue}]` : ch.rightValue || "(empty)";
        const lineStr = `[${ch.address}] ${ch.badge}:  ${beforeDesc}  ->  ${afterDesc}`;
        const wrapped = wrapTextLines(lineStr, fontMono, 8, CONTENT_W - 14);
        ensureSpace(wrapped.length * 11 + 6);

        const barColor =
          ch.kind === "formula_overwritten"
            ? rgb(0.88, 0.11, 0.28)
            : ch.kind === "formula_changed"
              ? rgb(0.85, 0.46, 0.02)
              : ch.kind === "cell_added"
                ? rgb(0.06, 0.58, 0.38)
                : rgb(0.23, 0.45, 0.82);

        page.drawRectangle({
          x: MARGIN_X,
          y: y - wrapped.length * 10.5 + 2,
          width: 3,
          height: wrapped.length * 10.5,
          color: barColor,
        });

        for (const wl of wrapped) {
          page.drawText(wl, {
            x: MARGIN_X + 9,
            y: y - 7,
            size: 8,
            font: fontMono,
            color: rgb(0.14, 0.18, 0.24),
          });
          y -= 10.5;
        }
        y -= 3;
      }
      y -= 8;
    }
  }

  // Section 2: Text & Contract Redline Report
  if (textDiffResult) {
    const st = textDiffResult.stats;
    ensureSpace(46);
    page.drawText("Executive Text & Clause Redline Summary", {
      x: MARGIN_X,
      y,
      size: 11.5,
      font: fontBold,
      color: rgb(0.08, 0.12, 0.2),
    });
    y -= 16;
    page.drawText(
      toPdfSafeText(
        `Total Changed Lines: ${st.totalChanges}  |  Modified: ${st.modifiedLines}  |  Added (+): ${st.addedLines}  |  Removed (-): ${st.removedLines}  |  Smart Risk Highlights: ${st.highlightCount}`
      ),
      {
        x: MARGIN_X,
        y,
        size: 8.5,
        font: fontReg,
        color: rgb(0.22, 0.28, 0.36),
      }
    );
    y -= 20;

    if (textDiffResult.highlights && textDiffResult.highlights.length > 0) {
      ensureSpace(28);
      page.drawText("High-Priority Financial, Rate, Date & Clause Highlights", {
        x: MARGIN_X,
        y,
        size: 10,
        font: fontBold,
        color: rgb(0.68, 0.22, 0.08),
      });
      y -= 14;

      for (const hl of textDiffResult.highlights.slice(0, 25)) {
        const hlLine = `[${hl.badge} | Line ${hl.lineRef}]  ${hl.before}  ->  ${hl.after}`;
        const wrapped = wrapTextLines(hlLine, fontBold, 8.2, CONTENT_W - 14);
        ensureSpace(wrapped.length * 11 + 6);
        page.drawRectangle({
          x: MARGIN_X,
          y: y - wrapped.length * 10.5 + 2,
          width: 3,
          height: wrapped.length * 10.5,
          color: rgb(0.92, 0.38, 0.05),
        });
        for (const wl of wrapped) {
          page.drawText(wl, {
            x: MARGIN_X + 9,
            y: y - 7,
            size: 8.2,
            font: fontBold,
            color: rgb(0.18, 0.14, 0.12),
          });
          y -= 10.5;
        }
        y -= 3;
      }
      y -= 8;
    }

    ensureSpace(28);
    page.drawText("Line-by-Line Redline Excerpts", {
      x: MARGIN_X,
      y,
      size: 10,
      font: fontBold,
      color: rgb(0.08, 0.12, 0.2),
    });
    y -= 14;

    const changedBlocks = textDiffResult.blocks.filter((b) => b.kind !== "eq").slice(0, 220);
    if (changedBlocks.length === 0) {
      page.drawText("No text differences detected between Baseline and Target.", {
        x: MARGIN_X,
        y: y - 6,
        size: 8.5,
        font: fontReg,
        color: rgb(0.3, 0.36, 0.44),
      });
      y -= 18;
    } else {
      for (const blk of changedBlocks) {
        if (blk.kind === "del" || blk.kind === "mod") {
          const delLines = wrapTextLines(`- [L${blk.leftLineNo}] ${blk.leftText}`, fontMono, 7.8, CONTENT_W - 14);
          ensureSpace(delLines.length * 10 + 4);
          page.drawRectangle({
            x: MARGIN_X,
            y: y - delLines.length * 10 + 2,
            width: 3,
            height: delLines.length * 10,
            color: rgb(0.84, 0.16, 0.24),
          });
          for (const dl of delLines) {
            page.drawText(dl, {
              x: MARGIN_X + 9,
              y: y - 7,
              size: 7.8,
              font: fontMono,
              color: rgb(0.58, 0.1, 0.16),
            });
            y -= 10;
          }
        }
        if (blk.kind === "add" || blk.kind === "mod") {
          const addLines = wrapTextLines(`+ [R${blk.rightLineNo}] ${blk.rightText}`, fontMono, 7.8, CONTENT_W - 14);
          ensureSpace(addLines.length * 10 + 4);
          page.drawRectangle({
            x: MARGIN_X,
            y: y - addLines.length * 10 + 2,
            width: 3,
            height: addLines.length * 10,
            color: rgb(0.06, 0.58, 0.38),
          });
          for (const al of addLines) {
            page.drawText(al, {
              x: MARGIN_X + 9,
              y: y - 7,
              size: 7.8,
              font: fontMono,
              color: rgb(0.05, 0.42, 0.25),
            });
            y -= 10;
          }
        }
        y -= 4;
      }
    }
  }

  // Section 3: Visual Pixel-Diff Snapshot (when in Visual mode or Image comparison)
  if (visualSnapshotResult && visualSnapshotResult.diffCanvas) {
    ensureSpace(310);
    page.drawText(
      toPdfSafeText(
        `Visual Pixel-Overlay Snapshot — Page ${visualSnapshotResult.pageNum} (${visualSnapshotResult.changedPercent.toFixed(2)}% pixels changed)`
      ),
      {
        x: MARGIN_X,
        y,
        size: 10.5,
        font: fontBold,
        color: rgb(0.08, 0.12, 0.2),
      }
    );
    y -= 14;

    const dataUrl = visualSnapshotResult.diffCanvas.toDataURL("image/jpeg", 0.86);
    const base64Part = dataUrl.split(",")[1];
    const jpgBytes = Uint8Array.from(atob(base64Part), (c) => c.charCodeAt(0));
    const embeddedJpg = await pdfDoc.embedJpg(jpgBytes);

    const maxImgW = CONTENT_W;
    const maxImgH = Math.max(200, y - 60);
    const scale = Math.min(maxImgW / embeddedJpg.width, maxImgH / embeddedJpg.height, 1.0);
    const drawW = embeddedJpg.width * scale;
    const drawH = embeddedJpg.height * scale;

    page.drawRectangle({
      x: MARGIN_X,
      y: y - drawH - 4,
      width: drawW + 4,
      height: drawH + 4,
      borderColor: rgb(0.78, 0.82, 0.88),
      borderWidth: 1,
      color: rgb(1, 1, 1),
    });
    page.drawImage(embeddedJpg, {
      x: MARGIN_X + 2,
      y: y - drawH - 2,
      width: drawW,
      height: drawH,
    });
    y -= drawH + 18;
  }

  const savedBytes = await pdfDoc.save();
  return new Uint8Array(savedBytes);
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

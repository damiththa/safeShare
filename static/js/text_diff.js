/**
 * Deterministic Client-Side Text & Contract Redline Engine (`BoxDiff v1`).
 * Extracts structured lines from `.pdf` (`pdf.js`), `.docx` (`JSZip` + OpenXML),
 * and `.txt` / `.md` / `.json` / `.csv` entirely inside browser RAM, computes
 * Patience-anchored LCS line + intra-line word diffs, and surfaces high-priority
 * Financial ($), Percentage (%), Date/Deadline, and Legal Clause changes.
 */

function ensurePdfWorker() {
  if (window.pdfjsLib && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js";
  }
}

/**
 * Extracts normalized readable text lines from `.pdf`, `.docx`, `.json`, `.md`, `.txt`, or `.csv`.
 * Always slices `Uint8Array` before passing to `pdf.js` so the caller's buffer is never detached.
 */
export async function extractDocumentText(uint8Bytes, ext) {
  const cleanExt = (ext || "").toLowerCase().replace(/^\./, "");

  if (cleanExt === "pdf") {
    ensurePdfWorker();
    if (!window.pdfjsLib) throw new Error("PDF engine (pdf.js) is not loaded.");
    const pdfDoc = await window.pdfjsLib.getDocument({ data: uint8Bytes.slice(0) }).promise;
    const allLines = [];
    let totalWords = 0;

    for (let p = 1; p <= pdfDoc.numPages; p++) {
      const page = await pdfDoc.getPage(p);
      const tc = await page.getTextContent();
      const rawItems = (tc.items || []).filter((it) => it && typeof it.str === "string" && it.str.trim().length > 0);

      allLines.push(`[Page ${p}]`);
      if (rawItems.length === 0) {
        allLines.push("(No selectable text on this page — switch to Visual Diff for scanned/image comparison)");
        continue;
      }

      // Group PDF spans into visual reading rows by Y baseline (`transform[5]`), top-to-bottom.
      const rows = [];
      for (const item of rawItems) {
        const tx = item.transform || [1, 0, 0, 1, 0, 0];
        const x = Number(tx[4] || 0);
        const y = Number(tx[5] || 0);
        const w = Number(item.width || 0);
        let matchedRow = null;
        for (const r of rows) {
          if (Math.abs(r.y - y) <= 3.8) {
            matchedRow = r;
            break;
          }
        }
        if (!matchedRow) {
          matchedRow = { y, spans: [] };
          rows.push(matchedRow);
        }
        matchedRow.spans.push({ x, w, str: item.str });
      }

      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.spans.sort((a, b) => a.x - b.x);
        let lineText = "";
        let prevEnd = null;
        for (const sp of r.spans) {
          if (prevEnd !== null && sp.x - prevEnd > 3.5 && !lineText.endsWith(" ") && !sp.str.startsWith(" ")) {
            lineText += " ";
          }
          lineText += sp.str;
          prevEnd = sp.x + Math.max(sp.w, sp.str.length * 3.5);
        }
        const trimmed = lineText.replace(/\s+/g, " ").trim();
        if (trimmed) {
          allLines.push(trimmed);
          totalWords += trimmed.split(/\s+/).length;
        }
      }
    }

    return {
      text: allLines.join("\n"),
      pageCount: pdfDoc.numPages,
      wordCount: totalWords,
      isScannedLikely: pdfDoc.numPages > 0 && totalWords === 0,
    };
  }

  if (cleanExt === "docx") {
    if (!window.JSZip) throw new Error("Archive engine (JSZip) is not loaded.");
    const zip = await window.JSZip.loadAsync(uint8Bytes.slice(0));
    const docEntry = zip.file("word/document.xml");
    if (!docEntry) {
      throw new Error("Invalid .docx file: missing word/document.xml.");
    }
    const xmlStr = await docEntry.async("string");
    const dom = new DOMParser().parseFromString(xmlStr, "application/xml");
    const lines = [];
    let totalWords = 0;

    const bodyNode = Array.from(dom.getElementsByTagName("*")).find((el) => el.localName === "body") || dom.documentElement;
    for (const child of Array.from(bodyNode.children || [])) {
      if (child.localName === "p") {
        const pText = extractWordParagraphText(child).trim();
        if (pText) {
          lines.push(pText);
          totalWords += pText.split(/\s+/).length;
        }
      } else if (child.localName === "tbl") {
        const trNodes = Array.from(child.getElementsByTagName("*")).filter((el) => el.localName === "tr");
        for (const tr of trNodes) {
          const cells = Array.from(tr.children || [])
            .filter((el) => el.localName === "tc")
            .map((tc) => extractWordParagraphText(tc).replace(/\s+/g, " ").trim());
          const rowStr = cells.filter(Boolean).join(" | ");
          if (rowStr) {
            lines.push(rowStr);
            totalWords += rowStr.split(/\s+/).length;
          }
        }
      }
    }

    return {
      text: lines.join("\n"),
      pageCount: null,
      wordCount: totalWords,
      isScannedLikely: false,
    };
  }

  const rawText = new TextDecoder("utf-8", { fatal: false }).decode(uint8Bytes);
  let normalizedText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (cleanExt === "json") {
    try {
      normalizedText = JSON.stringify(JSON.parse(normalizedText), null, 2);
    } catch {
      // Keep raw text if malformed JSON so user can still diff syntax errors
    }
  }
  const words = normalizedText.trim() ? normalizedText.trim().split(/\s+/).length : 0;
  return {
    text: normalizedText,
    pageCount: null,
    wordCount: words,
    isScannedLikely: false,
  };
}

function extractWordParagraphText(rootEl) {
  let out = "";
  const walker = rootEl.ownerDocument.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
  let cur = walker.nextNode();
  while (cur) {
    const ln = cur.localName;
    if (ln === "t") {
      out += cur.textContent || "";
    } else if (ln === "tab") {
      out += "\t";
    } else if (ln === "br" || ln === "cr") {
      out += "\n";
    }
    cur = walker.nextNode();
  }
  return out;
}

/**
 * Exact LCS on small/medium slices (`a.length * b.length <= 900_000`).
 */
function exactSliceLcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((v, j) => ({ type: "add", right: v, rightIdx: j }));
  if (m === 0) return a.map((v, i) => ({ type: "del", left: v, leftIdx: i }));

  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const rowOff = i * width;
    const nextRowOff = (i + 1) * width;
    const ai = a[i];
    for (let j = m - 1; j >= 0; j--) {
      if (ai === b[j]) {
        dp[rowOff + j] = dp[nextRowOff + j + 1] + 1;
      } else {
        const down = dp[nextRowOff + j];
        const right = dp[rowOff + j + 1];
        dp[rowOff + j] = down >= right ? down : right;
      }
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", left: a[i], right: b[j], leftIdx: i, rightIdx: j });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: "del", left: a[i], leftIdx: i });
      i++;
    } else {
      ops.push({ type: "add", right: b[j], rightIdx: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", left: a[i], leftIdx: i });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", right: b[j], rightIdx: j });
    j++;
  }
  return ops;
}

/**
 * Patience-anchored LCS line diff so even multi-thousand-line contracts diff rapidly in browser RAM.
 */
function anchoredLineDiff(leftLines, rightLines) {
  let start = 0;
  while (
    start < leftLines.length &&
    start < rightLines.length &&
    leftLines[start] === rightLines[start]
  ) {
    start++;
  }

  let endLeft = leftLines.length - 1;
  let endRight = rightLines.length - 1;
  while (endLeft >= start && endRight >= start && leftLines[endLeft] === rightLines[endRight]) {
    endLeft--;
    endRight--;
  }

  const prefixOps = [];
  for (let k = 0; k < start; k++) {
    prefixOps.push({ type: "eq", text: leftLines[k], leftLineNo: k + 1, rightLineNo: k + 1 });
  }

  const midLeft = leftLines.slice(start, endLeft + 1);
  const midRight = rightLines.slice(start, endRight + 1);
  const midOps = diffMiddleSlice(midLeft, midRight, start, start);

  const suffixOps = [];
  let rCursor = endRight + 1;
  for (let lCursor = endLeft + 1; lCursor < leftLines.length; lCursor++, rCursor++) {
    suffixOps.push({
      type: "eq",
      text: leftLines[lCursor],
      leftLineNo: lCursor + 1,
      rightLineNo: rCursor + 1,
    });
  }

  return [...prefixOps, ...midOps, ...suffixOps];
}

function diffMiddleSlice(a, b, aBase, bBase) {
  if (a.length === 0 && b.length === 0) return [];
  if (a.length * b.length <= 650000) {
    return exactSliceLcsOps(a, b).map((op) => {
      if (op.type === "eq") {
        return {
          type: "eq",
          text: op.left,
          leftLineNo: aBase + op.leftIdx + 1,
          rightLineNo: bBase + op.rightIdx + 1,
        };
      }
      if (op.type === "del") {
        return { type: "del", text: op.left, leftLineNo: aBase + op.leftIdx + 1, rightLineNo: null };
      }
      return { type: "add", text: op.right, leftLineNo: null, rightLineNo: bBase + op.rightIdx + 1 };
    });
  }

  // Unique-line anchor split (Patience heuristic) for huge documents
  const countA = new Map();
  const posA = new Map();
  for (let i = 0; i < a.length; i++) {
    const s = a[i].trim();
    if (s.length < 4) continue;
    countA.set(s, (countA.get(s) || 0) + 1);
    posA.set(s, i);
  }
  const countB = new Map();
  const posB = new Map();
  for (let j = 0; j < b.length; j++) {
    const s = b[j].trim();
    if (s.length < 4) continue;
    countB.set(s, (countB.get(s) || 0) + 1);
    posB.set(s, j);
  }

  let bestAnchor = null;
  let bestScore = Infinity;
  for (const [s, ca] of countA.entries()) {
    if (ca === 1 && countB.get(s) === 1) {
      const ia = posA.get(s);
      const jb = posB.get(s);
      if (a[ia] === b[jb]) {
        const dist = Math.abs(ia / a.length - jb / b.length);
        const centerBias = Math.abs(ia / a.length - 0.5);
        const score = dist * 2 + centerBias;
        if (score < bestScore) {
          bestScore = score;
          bestAnchor = { ia, jb };
        }
      }
    }
  }

  if (bestAnchor) {
    const { ia, jb } = bestAnchor;
    const before = diffMiddleSlice(a.slice(0, ia), b.slice(0, jb), aBase, bBase);
    const anchorOp = {
      type: "eq",
      text: a[ia],
      leftLineNo: aBase + ia + 1,
      rightLineNo: bBase + jb + 1,
    };
    const after = diffMiddleSlice(a.slice(ia + 1), b.slice(jb + 1), aBase + ia + 1, bBase + jb + 1);
    return [...before, anchorOp, ...after];
  }

  // Fallback linear hash match if zero unique anchors exist
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ type: "eq", text: a[i], leftLineNo: aBase + i + 1, rightLineNo: bBase + j + 1 });
      i++;
      j++;
    } else {
      if (i < a.length) {
        out.push({ type: "del", text: a[i], leftLineNo: aBase + i + 1, rightLineNo: null });
        i++;
      }
      if (j < b.length) {
        out.push({ type: "add", text: b[j], leftLineNo: null, rightLineNo: bBase + j + 1 });
        j++;
      }
    }
  }
  return out;
}

/**
 * Computes inline word-level token diff for modified line pairs.
 */
export function computeInlineWordTokens(leftLine, rightLine) {
  const leftToks = leftLine.match(/\S+|\s+/g) || [];
  const rightToks = rightLine.match(/\S+|\s+/g) || [];
  if (leftToks.length * rightToks.length > 90000) {
    return {
      leftTokens: [{ type: "del", value: leftLine }],
      rightTokens: [{ type: "add", value: rightLine }],
      unifiedTokens: [
        { type: "del", value: leftLine },
        { type: "eq", value: " " },
        { type: "add", value: rightLine },
      ],
    };
  }
  const ops = exactSliceLcsOps(leftToks, rightToks);
  const leftTokens = [];
  const rightTokens = [];
  const unifiedTokens = [];

  for (const op of ops) {
    if (op.type === "eq") {
      leftTokens.push({ type: "eq", value: op.left });
      rightTokens.push({ type: "eq", value: op.right });
      unifiedTokens.push({ type: "eq", value: op.left });
    } else if (op.type === "del") {
      leftTokens.push({ type: "del", value: op.left });
      unifiedTokens.push({ type: "del", value: op.left });
    } else {
      rightTokens.push({ type: "add", value: op.right });
      unifiedTokens.push({ type: "add", value: op.right });
    }
  }
  return { leftTokens, rightTokens, unifiedTokens };
}

/**
 * Runs full text redline comparison and extracts Smart Clause/Financial/Date highlights.
 */
export function computeTextRedline(leftText, rightText) {
  const leftLines = leftText ? leftText.split("\n") : [];
  const rightLines = rightText ? rightText.split("\n") : [];
  const rawOps = anchoredLineDiff(leftLines, rightLines);

  // Pair consecutive del + add blocks into structured rows for Unified & Side-by-Side views
  const blocks = [];
  let idx = 0;
  let addedLines = 0;
  let removedLines = 0;
  let modifiedLines = 0;
  let unchangedLines = 0;
  let changeSeq = 0;

  while (idx < rawOps.length) {
    const op = rawOps[idx];
    if (op.type === "eq") {
      unchangedLines++;
      blocks.push({
        kind: "eq",
        changeId: null,
        leftLineNo: op.leftLineNo,
        rightLineNo: op.rightLineNo,
        leftText: op.text,
        rightText: op.text,
      });
      idx++;
      continue;
    }

    const dels = [];
    while (idx < rawOps.length && rawOps[idx].type === "del") {
      dels.push(rawOps[idx]);
      idx++;
    }
    const adds = [];
    while (idx < rawOps.length && rawOps[idx].type === "add") {
      adds.push(rawOps[idx]);
      idx++;
    }

    const pairCount = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairCount; p++) {
      changeSeq++;
      modifiedLines++;
      const d = dels[p];
      const a = adds[p];
      const inline = computeInlineWordTokens(d.text, a.text);
      blocks.push({
        kind: "mod",
        changeId: `chg-${changeSeq}`,
        leftLineNo: d.leftLineNo,
        rightLineNo: a.rightLineNo,
        leftText: d.text,
        rightText: a.text,
        inline,
      });
    }
    for (let p = pairCount; p < dels.length; p++) {
      changeSeq++;
      removedLines++;
      blocks.push({
        kind: "del",
        changeId: `chg-${changeSeq}`,
        leftLineNo: dels[p].leftLineNo,
        rightLineNo: null,
        leftText: dels[p].text,
        rightText: "",
      });
    }
    for (let p = pairCount; p < adds.length; p++) {
      changeSeq++;
      addedLines++;
      blocks.push({
        kind: "add",
        changeId: `chg-${changeSeq}`,
        leftLineNo: null,
        rightLineNo: adds[p].rightLineNo,
        leftText: "",
        rightText: adds[p].text,
      });
    }
  }

  const highlights = extractSmartHighlights(blocks);

  return {
    blocks,
    highlights,
    stats: {
      totalChanges: modifiedLines + addedLines + removedLines,
      modifiedLines,
      addedLines,
      removedLines,
      unchangedLines,
      highlightCount: highlights.length,
    },
  };
}

const CURRENCY_RE = /(?:\$|USD\s*|EUR\s*|GBP\s*)\d[\d,]*(?:\.\d{1,2})?(?:\s*(?:million|billion|thousand|M|B|K))?/gi;
const PERCENT_RE = /\b\d+(?:\.\d+)?\s*(?:%|bps|basis points)\b/gi;
const DATE_TERM_RE =
  /\b(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|Net\s+\d+|\d+\s+(?:calendar\s+|business\s+)?(?:days|months|years))\b/gi;
const LEGAL_CLAUSE_RE =
  /\b(indemnif\w*|limitation of liability|governing law|termination|exclusiv\w*|auto-?renew\w*|liquidated damages|confidential\w*|force majeure|warranty|arbitration)\b/i;

function extractSmartHighlights(blocks) {
  const highlights = [];
  const seen = new Set();

  for (const b of blocks) {
    if (b.kind === "eq") continue;
    const left = b.leftText || "";
    const right = b.rightText || "";

    // 1. Financial ($) shifts
    const leftMoney = left.match(CURRENCY_RE) || [];
    const rightMoney = right.match(CURRENCY_RE) || [];
    if ((leftMoney.length || rightMoney.length) && leftMoney.join("|") !== rightMoney.join("|")) {
      const summary = `${leftMoney.join(", ") || "None"} -> ${rightMoney.join(", ") || "Removed"}`;
      const key = `money:${summary}:${b.changeId}`;
      if (!seen.has(key)) {
        seen.add(key);
        highlights.push({
          category: "Financial",
          badge: "$ Amount",
          before: leftMoney.join(", ") || "—",
          after: rightMoney.join(", ") || "Removed",
          snippet: (right || left).slice(0, 120),
          changeId: b.changeId,
          lineRef: b.rightLineNo || b.leftLineNo || 1,
        });
      }
    }

    // 2. Rate / Percentage (%) shifts
    const leftPct = left.match(PERCENT_RE) || [];
    const rightPct = right.match(PERCENT_RE) || [];
    if ((leftPct.length || rightPct.length) && leftPct.join("|") !== rightPct.join("|")) {
      const summary = `${leftPct.join(", ") || "None"} -> ${rightPct.join(", ") || "Removed"}`;
      const key = `pct:${summary}:${b.changeId}`;
      if (!seen.has(key)) {
        seen.add(key);
        highlights.push({
          category: "Rate",
          badge: "% Rate",
          before: leftPct.join(", ") || "—",
          after: rightPct.join(", ") || "Removed",
          snippet: (right || left).slice(0, 120),
          changeId: b.changeId,
          lineRef: b.rightLineNo || b.leftLineNo || 1,
        });
      }
    }

    // 3. Date / Payment Term / Duration shifts
    const leftDates = left.match(DATE_TERM_RE) || [];
    const rightDates = right.match(DATE_TERM_RE) || [];
    if ((leftDates.length || rightDates.length) && leftDates.join("|") !== rightDates.join("|")) {
      const summary = `${leftDates.join(", ") || "None"} -> ${rightDates.join(", ") || "Removed"}`;
      const key = `date:${summary}:${b.changeId}`;
      if (!seen.has(key)) {
        seen.add(key);
        highlights.push({
          category: "Date / Term",
          badge: "Term / Date",
          before: leftDates.join(", ") || "—",
          after: rightDates.join(", ") || "Removed",
          snippet: (right || left).slice(0, 120),
          changeId: b.changeId,
          lineRef: b.rightLineNo || b.leftLineNo || 1,
        });
      }
    }

    // 4. Key Legal Clause edits
    const clauseMatch = (right || left).match(LEGAL_CLAUSE_RE);
    if (clauseMatch && highlights.length < 30) {
      const term = clauseMatch[1];
      const key = `clause:${term.toLowerCase()}:${b.changeId}`;
      if (!seen.has(key)) {
        seen.add(key);
        highlights.push({
          category: "Clause",
          badge: "Legal Clause",
          before: b.kind === "add" ? "Added clause" : left.slice(0, 55),
          after: b.kind === "del" ? "Deleted clause" : right.slice(0, 55),
          snippet: `${term.toUpperCase()}: ${(right || left).slice(0, 110)}`,
          changeId: b.changeId,
          lineRef: b.rightLineNo || b.leftLineNo || 1,
        });
      }
    }

    if (highlights.length >= 36) break;
  }

  return highlights;
}

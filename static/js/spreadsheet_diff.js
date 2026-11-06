/**
 * Zero-CVE Client-Side Spreadsheet Multi-Sheet Cell & Formula Diff Engine (`BoxDiff v1`).
 * Parses `.xlsx` OpenXML archives directly via vendored `JSZip` + browser `DOMParser`
 * (`workbook.xml`, `workbook.xml.rels`, `sharedStrings.xml`, `sheet*.xml`) so BOTH
 * raw Excel formulas (`<f>`) and evaluated values (`<v>`) are audited—plus RFC-4180 `.csv`.
 */

export function supportsSpreadsheetComparison(ext) {
  const e = (ext || "").toLowerCase().replace(/^\./, "");
  return e === "xlsx" || e === "csv";
}

export async function parseSpreadsheetWorkbook(uint8Bytes, ext, fallbackLabel = "Sheet1") {
  const cleanExt = (ext || "").toLowerCase().replace(/^\./, "");
  if (cleanExt === "csv") {
    return parseCsvAsWorkbook(uint8Bytes, fallbackLabel);
  }
  if (cleanExt === "xlsx") {
    return parseXlsxWorkbook(uint8Bytes);
  }
  throw new Error(`Unsupported spreadsheet format: .${cleanExt}`);
}

function colIndexToLetters(col1Based) {
  let n = col1Based;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || "A";
}

function parseCellRef(refStr, fallbackRow, fallbackCol) {
  if (!refStr) {
    const colLetters = colIndexToLetters(fallbackCol);
    return { address: `${colLetters}${fallbackRow}`, row: fallbackRow, col: fallbackCol };
  }
  const m = /^([A-Za-z]+)(\d+)$/.exec(refStr.trim());
  if (!m) {
    return { address: refStr.toUpperCase(), row: fallbackRow, col: fallbackCol };
  }
  const letters = m[1].toUpperCase();
  const row = parseInt(m[2], 10);
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { address: `${letters}${row}`, row, col };
}

function normalizeDisplayNumber(valStr) {
  if (typeof valStr !== "string" || valStr.trim() === "") return "";
  const trimmed = valStr.trim();
  if (/^-?\d+\.\d{10,}$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return String(Number(num.toPrecision(12)));
    }
  }
  return trimmed;
}

/**
 * RFC-4180 compliant CSV state-machine parser.
 */
function parseCsvAsWorkbook(uint8Bytes, sheetName = "CSV") {
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(uint8Bytes);
  const text = raw.replace(/^\uFEFF/, "");
  const rows = [];
  let curRow = [];
  let curCell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          curCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        curCell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      curRow.push(curCell);
      curCell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      curRow.push(curCell);
      rows.push(curRow);
      curRow = [];
      curCell = "";
    } else {
      curCell += ch;
    }
  }
  if (curCell.length > 0 || curRow.length > 0) {
    curRow.push(curCell);
    rows.push(curRow);
  }

  const cells = new Map();
  let maxRow = 0;
  let maxCol = 0;
  for (let r = 0; r < rows.length; r++) {
    const rowArr = rows[r];
    for (let c = 0; c < rowArr.length; c++) {
      const val = (rowArr[c] || "").trim();
      const formula = val.startsWith("=") && val.length > 1 ? val : null;
      if (!val) continue;
      const row1 = r + 1;
      const col1 = c + 1;
      const addr = `${colIndexToLetters(col1)}${row1}`;
      cells.set(addr, {
        address: addr,
        row: row1,
        col: col1,
        value: val,
        formula,
      });
      if (row1 > maxRow) maxRow = row1;
      if (col1 > maxCol) maxCol = col1;
    }
  }

  return {
    sheets: [
      {
        name: sheetName || "CSV",
        cells,
        maxRow,
        maxCol,
      },
    ],
  };
}

/**
 * OpenXML `.xlsx` parser extracting multi-sheet cell values AND `<f>` formulas.
 */
async function parseXlsxWorkbook(uint8Bytes) {
  if (!window.JSZip) throw new Error("Archive engine (JSZip) is not loaded.");
  const zip = await window.JSZip.loadAsync(uint8Bytes.slice(0));
  const parser = new DOMParser();

  // 1. Parse `xl/sharedStrings.xml` if present
  const sharedStrings = [];
  const ssFile = zip.file("xl/sharedStrings.xml");
  if (ssFile) {
    const ssXml = await ssFile.async("string");
    const ssDom = parser.parseFromString(ssXml, "application/xml");
    const siNodes = Array.from(ssDom.getElementsByTagName("*")).filter((el) => el.localName === "si");
    for (const si of siNodes) {
      const tNodes = Array.from(si.getElementsByTagName("*")).filter((el) => el.localName === "t");
      sharedStrings.push(tNodes.map((t) => t.textContent || "").join(""));
    }
  }

  // 2. Parse `xl/_rels/workbook.xml.rels` for rId -> worksheet path mapping
  const relMap = new Map();
  const relFile = zip.file("xl/_rels/workbook.xml.rels");
  if (relFile) {
    const relXml = await relFile.async("string");
    const relDom = parser.parseFromString(relXml, "application/xml");
    const relNodes = Array.from(relDom.getElementsByTagName("*")).filter(
      (el) => el.localName === "Relationship"
    );
    for (const rn of relNodes) {
      const id = rn.getAttribute("Id");
      const target = rn.getAttribute("Target") || "";
      if (id && target) {
        const cleanPath = target.startsWith("/")
          ? target.replace(/^\/+/, "")
          : target.startsWith("xl/")
            ? target
            : `xl/${target.replace(/^\.\//, "")}`;
        relMap.set(id, cleanPath);
      }
    }
  }

  // 3. Parse `xl/workbook.xml` for ordered sheet names & r:id references
  const wbFile = zip.file("xl/workbook.xml");
  if (!wbFile) {
    throw new Error("Invalid .xlsx workbook: missing xl/workbook.xml.");
  }
  const wbXml = await wbFile.async("string");
  const wbDom = parser.parseFromString(wbXml, "application/xml");
  const sheetEntries = [];
  const sheetNodes = Array.from(wbDom.getElementsByTagName("*")).filter((el) => el.localName === "sheet");

  sheetNodes.forEach((sn, idx) => {
    const name = sn.getAttribute("name") || `Sheet${idx + 1}`;
    const rId =
      sn.getAttribute("r:id") ||
      sn.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ||
      "";
    const resolvedPath = relMap.get(rId) || `xl/worksheets/sheet${idx + 1}.xml`;
    sheetEntries.push({ name, path: resolvedPath });
  });

  // 4. Parse each worksheet XML
  const sheets = [];
  for (const entry of sheetEntries) {
    const wsFile = zip.file(entry.path);
    if (!wsFile) continue;
    const wsXml = await wsFile.async("string");
    const wsDom = parser.parseFromString(wsXml, "application/xml");
    const cells = new Map();
    let maxRow = 0;
    let maxCol = 0;

    const rowNodes = Array.from(wsDom.getElementsByTagName("*")).filter((el) => el.localName === "row");
    let autoRow = 0;
    for (const rNode of rowNodes) {
      autoRow = parseInt(rNode.getAttribute("r") || String(autoRow + 1), 10);
      let autoCol = 0;
      for (const cNode of Array.from(rNode.children || [])) {
        if (cNode.localName !== "c") continue;
        autoCol++;
        const refInfo = parseCellRef(cNode.getAttribute("r"), autoRow, autoCol);
        autoCol = refInfo.col;

        const cType = cNode.getAttribute("t") || "";
        let rawFormula = null;
        let rawVal = "";
        let inlineText = "";

        for (const sub of Array.from(cNode.children || [])) {
          if (sub.localName === "f") {
            const fTxt = (sub.textContent || "").trim();
            if (fTxt) {
              rawFormula = fTxt.startsWith("=") ? fTxt : `=${fTxt}`;
            }
          } else if (sub.localName === "v") {
            rawVal = sub.textContent || "";
          } else if (sub.localName === "is") {
            const tNodes = Array.from(sub.getElementsByTagName("*")).filter((el) => el.localName === "t");
            inlineText = tNodes.map((t) => t.textContent || "").join("");
          }
        }

        let displayVal = "";
        if (cType === "s") {
          const sIdx = parseInt(rawVal, 10);
          displayVal = Number.isFinite(sIdx) && sharedStrings[sIdx] !== undefined ? sharedStrings[sIdx] : rawVal;
        } else if (cType === "inlineStr") {
          displayVal = inlineText;
        } else if (cType === "b") {
          displayVal = rawVal === "1" ? "TRUE" : rawVal === "0" ? "FALSE" : rawVal;
        } else {
          displayVal = normalizeDisplayNumber(rawVal);
        }

        const trimmedVal = String(displayVal).trim();
        if (!trimmedVal && !rawFormula) continue;

        cells.set(refInfo.address, {
          address: refInfo.address,
          row: refInfo.row,
          col: refInfo.col,
          value: trimmedVal,
          formula: rawFormula,
        });
        if (refInfo.row > maxRow) maxRow = refInfo.row;
        if (refInfo.col > maxCol) maxCol = refInfo.col;
      }
    }

    sheets.push({
      name: entry.name,
      cells,
      maxRow,
      maxCol,
    });
  }

  return { sheets };
}

/**
 * Compares two parsed workbooks (`.xlsx` or `.csv`) across all sheets, values, and Excel formulas.
 */
export async function diffSpreadsheets(leftBytes, leftExt, rightBytes, rightExt) {
  const leftWb = await parseSpreadsheetWorkbook(leftBytes, leftExt, "Sheet1");
  const rightWb = await parseSpreadsheetWorkbook(rightBytes, rightExt, "Sheet1");

  const sheetPairs = pairWorkbookSheets(leftWb.sheets, rightWb.sheets);
  const sheetReports = [];

  let totalChanges = 0;
  let formulaChanges = 0;
  let hardcodedOverrides = 0;
  let valueChanges = 0;
  let addedCells = 0;
  let removedCells = 0;
  let sheetsChanged = 0;

  for (const pair of sheetPairs) {
    if (pair.status === "sheet_added") {
      const count = pair.right.cells.size;
      addedCells += count;
      totalChanges += Math.max(1, count);
      sheetsChanged++;
      const sampleChanges = Array.from(pair.right.cells.values())
        .sort((a, b) => a.row - b.row || a.col - b.col)
        .slice(0, 300)
        .map((rc) => ({
          address: rc.address,
          row: rc.row,
          col: rc.col,
          kind: "cell_added",
          badge: "+ Added Sheet Cell",
          leftValue: "",
          rightValue: rc.value,
          leftFormula: null,
          rightFormula: rc.formula,
          numericDelta: null,
        }));
      sheetReports.push({
        sheetName: pair.name,
        status: "sheet_added",
        changeCount: Math.max(1, count),
        changes: sampleChanges,
      });
      continue;
    }

    if (pair.status === "sheet_removed") {
      const count = pair.left.cells.size;
      removedCells += count;
      totalChanges += Math.max(1, count);
      sheetsChanged++;
      const sampleChanges = Array.from(pair.left.cells.values())
        .sort((a, b) => a.row - b.row || a.col - b.col)
        .slice(0, 300)
        .map((lc) => ({
          address: lc.address,
          row: lc.row,
          col: lc.col,
          kind: "cell_removed",
          badge: "- Removed Sheet Cell",
          leftValue: lc.value,
          rightValue: "",
          leftFormula: lc.formula,
          rightFormula: null,
          numericDelta: null,
        }));
      sheetReports.push({
        sheetName: pair.name,
        status: "sheet_removed",
        changeCount: Math.max(1, count),
        changes: sampleChanges,
      });
      continue;
    }

    // Paired sheet comparison
    const allAddresses = new Set([...pair.left.cells.keys(), ...pair.right.cells.keys()]);
    const changes = [];

    for (const addr of allAddresses) {
      const lc = pair.left.cells.get(addr) || null;
      const rc = pair.right.cells.get(addr) || null;

      if (!lc && rc) {
        addedCells++;
        totalChanges++;
        changes.push({
          address: addr,
          row: rc.row,
          col: rc.col,
          kind: "cell_added",
          badge: rc.formula ? "+ Formula Added" : "+ Cell Added",
          leftValue: "",
          rightValue: rc.value,
          leftFormula: null,
          rightFormula: rc.formula,
          numericDelta: null,
        });
        continue;
      }

      if (lc && !rc) {
        removedCells++;
        totalChanges++;
        changes.push({
          address: addr,
          row: lc.row,
          col: lc.col,
          kind: "cell_removed",
          badge: "- Cell Cleared",
          leftValue: lc.value,
          rightValue: "",
          leftFormula: lc.formula,
          rightFormula: null,
          numericDelta: null,
        });
        continue;
      }

      const lFormula = lc.formula || null;
      const rFormula = rc.formula || null;
      const lVal = lc.value || "";
      const rVal = rc.value || "";

      if (lFormula === rFormula && lVal === rVal) {
        continue;
      }

      const numDelta = computeNumericDelta(lVal, rVal);

      if (lFormula && !rFormula) {
        formulaChanges++;
        hardcodedOverrides++;
        totalChanges++;
        changes.push({
          address: addr,
          row: rc.row,
          col: rc.col,
          kind: "formula_overwritten",
          badge: "Formula -> Hardcoded!",
          leftValue: lVal,
          rightValue: rVal,
          leftFormula: lFormula,
          rightFormula: null,
          numericDelta: numDelta,
        });
      } else if (lFormula !== rFormula) {
        formulaChanges++;
        totalChanges++;
        changes.push({
          address: addr,
          row: rc.row,
          col: rc.col,
          kind: "formula_changed",
          badge: "Formula Modified",
          leftValue: lVal,
          rightValue: rVal,
          leftFormula: lFormula,
          rightFormula: rFormula,
          numericDelta: numDelta,
        });
      } else {
        valueChanges++;
        totalChanges++;
        changes.push({
          address: addr,
          row: rc.row,
          col: rc.col,
          kind: "value_changed",
          badge: numDelta ? `Value (${numDelta.formatted})` : "Value Changed",
          leftValue: lVal,
          rightValue: rVal,
          leftFormula: lFormula,
          rightFormula: rFormula,
          numericDelta: numDelta,
        });
      }
    }

    changes.sort((a, b) => a.row - b.row || a.col - b.col);
    if (changes.length > 0) sheetsChanged++;

    sheetReports.push({
      sheetName: pair.name,
      status: changes.length > 0 ? "modified" : "unchanged",
      changeCount: changes.length,
      changes,
    });
  }

  return {
    sheets: sheetReports,
    stats: {
      totalChanges,
      formulaChanges,
      hardcodedOverrides,
      valueChanges,
      addedCells,
      removedCells,
      sheetsChanged,
      totalSheets: sheetReports.length,
    },
  };
}

function pairWorkbookSheets(leftSheets, rightSheets) {
  if (leftSheets.length === 1 && rightSheets.length === 1) {
    const label =
      leftSheets[0].name === rightSheets[0].name
        ? leftSheets[0].name
        : `${leftSheets[0].name} vs ${rightSheets[0].name}`;
    return [{ name: label, status: "paired", left: leftSheets[0], right: rightSheets[0] }];
  }

  const rightByLower = new Map();
  for (const rs of rightSheets) {
    rightByLower.set(rs.name.toLowerCase(), rs);
  }

  const matchedRight = new Set();
  const pairs = [];

  for (const ls of leftSheets) {
    const match = rightByLower.get(ls.name.toLowerCase());
    if (match) {
      matchedRight.add(match);
      pairs.push({ name: match.name, status: "paired", left: ls, right: match });
    } else {
      pairs.push({ name: ls.name, status: "sheet_removed", left: ls, right: null });
    }
  }

  for (const rs of rightSheets) {
    if (!matchedRight.has(rs)) {
      pairs.push({ name: rs.name, status: "sheet_added", left: null, right: rs });
    }
  }
  return pairs;
}

function parseCleanNumber(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/[$,%\s]/g, "");
  if (!cleaned || !/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function computeNumericDelta(leftStr, rightStr) {
  const ln = parseCleanNumber(leftStr);
  const rn = parseCleanNumber(rightStr);
  if (ln === null || rn === null) return null;
  const diff = rn - ln;
  if (Math.abs(diff) < 1e-12) return null;
  const sign = diff > 0 ? "+" : "";
  const pct =
    Math.abs(ln) > 1e-9 ? ` (${diff > 0 ? "+" : ""}${((diff / Math.abs(ln)) * 100).toFixed(1)}%)` : "";
  const formattedNum = Number.isInteger(diff) ? diff.toLocaleString() : Number(diff.toFixed(4)).toLocaleString();
  return {
    diff,
    formatted: `${sign}${formattedNum}${pct}`,
  };
}

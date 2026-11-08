/**
 * Client-Side PII & HIPAA Safe Harbor PHI Engine (100% In-Browser RAM).
 *
 * Capabilities:
 *  1. Line-Stitched Coordinate Mapper: Reconstructs full reading lines from fragmented
 *     PDF (`pdf.js`) or Wasm OCR (`Tesseract.js`) text tokens while preserving exact
 *     character-level normalized bounding boxes `[x, y, w, h]`.
 *  2. 17+ Structured PII, Financial & Healthcare PHI Detectors with mathematical
 *     checksums (Luhn, NPI ISO-80840 Luhn, DEA checksum, ABA 3-7-1, IBAN Mod-97,
 *     CMS Medicare MBI positional alphabet, SSN/ITIN rules) and clinical context anchors.
 *  3. Word (`.docx`) Body Text Scanner for `<w:t>` block-character (`█`) redaction.
 *  4. Defaults `enabled: false` so candidates open as clear, readable highlights on the
 *     page—letting users toggle items 1-by-1 or click "Black Out All" in one step.
 */

export function passesLuhn(digitsOnly) {
  if (digitsOnly.length < 13 || digitsOnly.length > 19) return false;
  if (/^(\d)\1+$/.test(digitsOnly)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let digit = parseInt(digitsOnly.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * Healthcare National Provider Identifier (NPI) 10-digit Luhn checksum with ISO '80840' prefix.
 */
export function passesNpiChecksum(tenDigits) {
  const clean = tenDigits.replace(/\D/g, "");
  if (!/^[12]\d{9}$/.test(clean)) return false;
  return passesLuhn(`80840${clean}`);
}

/**
 * US DEA Prescriber Number checksum: [A-Z][A-Z9] + 7 digits where ((d1+d3+d5) + 2*(d2+d4+d6)) % 10 === d7.
 */
export function passesDeaChecksum(raw) {
  const clean = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[ABCDEFGHJKLMPRSTUX][A-Z9]\d{7}$/.test(clean)) return false;
  const d = clean
    .slice(2)
    .split("")
    .map((c) => parseInt(c, 10));
  const sum = d[0] + d[2] + d[4] + 2 * (d[1] + d[3] + d[5]);
  return sum % 10 === d[6];
}

export function passesAbaRouting(nineDigits) {
  if (!/^\d{9}$/.test(nineDigits)) return false;
  const prefix = parseInt(nineDigits.slice(0, 2), 10);
  const validPrefix =
    (prefix >= 0 && prefix <= 12) ||
    (prefix >= 21 && prefix <= 32) ||
    (prefix >= 61 && prefix <= 72) ||
    prefix === 80;
  if (!validPrefix) return false;
  const d = nineDigits.split("").map(Number);
  const checksum =
    3 * (d[0] + d[3] + d[6]) +
    7 * (d[1] + d[4] + d[7]) +
    1 * (d[2] + d[5] + d[8]);
  return checksum > 0 && checksum % 10 === 0;
}

/**
 * ISO 7064 Mod-97-10 IBAN validator.
 */
export function passesIbanMod97(raw) {
  const clean = raw.replace(/\s+/g, "").toUpperCase();
  if (clean.length < 15 || clean.length > 34) return false;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(clean)) return false;
  const rearranged = clean.slice(4) + clean.slice(0, 4);
  let numeric = "";
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    numeric += code >= 65 && code <= 90 ? String(code - 55) : ch;
  }
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = parseInt(String(remainder) + numeric.slice(i, i + 7), 10) % 97;
  }
  return remainder === 1;
}

export function passesValidSsn(ssnStr) {
  const digits = ssnStr.replace(/\D/g, "");
  if (digits.length !== 9) return false;
  const area = parseInt(digits.slice(0, 3), 10);
  const group = parseInt(digits.slice(3, 5), 10);
  const serial = parseInt(digits.slice(5, 9), 10);
  // Allow valid US SSNs plus IRS ITINs (9XX where 4th digit is 5-9 or 70-88)
  if (area >= 900) {
    return group >= 50 && group <= 99 && serial > 0;
  }
  if (area === 0 || area === 666) return false;
  if (group === 0 || serial === 0) return false;
  return true;
}

function passesValidIpv4(ipStr) {
  const parts = ipStr.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  if (nums[0] === 0 || nums[0] === 127) return false;
  return true;
}

export function maskSecret(raw) {
  const clean = String(raw).trim();
  if (clean.length <= 4) return "••••";
  if (clean.includes("@")) {
    const [user, dom] = clean.split("@");
    const head = user.slice(0, Math.min(2, user.length));
    return `${head}•••@${dom}`;
  }
  if (/^[A-Za-z.\s'-]+$/.test(clean)) {
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]} ${parts[parts.length - 1][0]}•••`;
    }
    return `${clean.slice(0, 2)}••••`;
  }
  return "•".repeat(Math.min(6, clean.length - 4)) + clean.slice(-4);
}

/**
 * Ordered high-to-low specificity.
 * Rules with capturing group 1 (`group: 1`) highlight ONLY the captured value (excluding label prefixes).
 */
const PATTERNS = [
  // ======================== PHI / HEALTHCARE (HIPAA SAFE HARBOR) ========================
  {
    category: "phi",
    priority: 100,
    type: "MEDICARE_MBI",
    label: "Medicare ID (MBI)",
    regex: /\b([1-9][AC-HJKMNP-RT-Y][0-9AC-HJKMNP-RT-Y]\d[-\s]?[AC-HJKMNP-RT-Y][0-9AC-HJKMNP-RT-Y]\d[-\s]?[AC-HJKMNP-RT-Y]{2}\d{2})\b/gi,
    group: 1,
    validate: (m) => m.replace(/[-\s]/g, "").length === 11,
  },
  {
    category: "phi",
    priority: 98,
    type: "DEA",
    label: "DEA Prescriber #",
    regex: /\b(?:DEA(?:\s*(?:#|No\.?|ID))?[:\s-]*)?([ABCDEFGHJKLMPRSTUX][A-Z9]\d{7})\b/gi,
    group: 1,
    validate: (m) => passesDeaChecksum(m),
  },
  {
    category: "phi",
    priority: 96,
    type: "NPI",
    label: "Provider NPI",
    regex: /\b(?:NPI(?:\s*(?:#|No\.?|ID))?[:\s-]*)([12]\d{9})\b/gi,
    group: 1,
    validate: (m) => passesNpiChecksum(m),
  },
  {
    category: "phi",
    priority: 95,
    type: "MRN_ID",
    label: "Medical / Patient ID",
    regex: /\b(?:MRN|Medical\s+Record(?:\s*(?:#|No\.?|Number))?|Patient\s*ID|Pt\.?\s*ID|Chart\s*(?:#|No\.?)|Member\s*ID|Subscriber\s*ID|Policy\s*(?:#|No\.?)|Claim\s*(?:#|No\.?)|Encounter\s*(?:#|No\.?))[:#\s-]+([A-Z0-9][A-Z0-9-]{3,18})\b/gi,
    group: 1,
    validate: (m) => /\d/.test(m),
  },
  {
    category: "phi",
    priority: 94,
    type: "CLINICAL_DATE",
    label: "DOB / Clinical Date",
    regex: /\b(?:DOB|D\.O\.B\.|Date\s+of\s+Birth|Birth\s*Date|Admit(?:ted|ssion)?(?:\s+Date)?|Discharg(?:e|ed)(?:\s+Date)?|DOS|Date\s+of\s+Service)[:\s-]+((?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}))/gi,
    group: 1,
    validate: () => true,
  },
  {
    category: "phi",
    priority: 88,
    type: "ICD10",
    label: "Diagnosis Code (ICD-10)",
    regex: /\b(?:ICD-?10|Dx|Diagnosis(?:\s+Code)?)[:\s-]+([A-TV-Z]\d{2}(?:\.[A-Z0-9]{1,4})?)\b/gi,
    group: 1,
    validate: () => true,
  },
  {
    category: "phi",
    priority: 86,
    type: "PATIENT_NAME",
    label: "Patient / Provider Name",
    regex: /\b(?:Patient(?:\s+Name)?|Pt\.?\s+Name|Insured(?:\s+Name)?|Subscriber(?:\s+Name)?|Attending(?:\s+Physician)?|Ordering\s+Provider|Referred\s+By|Client(?:\s+Name)?|Prepared\s+For)[:\s]+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,3})/g,
    group: 1,
    validate: (m) => m.length >= 5 && !/^(Date|Phone|Email|Address|Number|None|Unknown)/i.test(m),
  },
  {
    category: "phi",
    priority: 84,
    type: "PROVIDER_DR",
    label: "Physician Name",
    regex: /\b(Dr\.\s+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})\b/g,
    group: 1,
    validate: (m) => m.length >= 6,
  },
  {
    category: "phi",
    priority: 72,
    type: "HIPAA_DATE",
    label: "Full Calendar Date",
    regex: /\b((?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:19|20)\d{2}|(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/g,
    group: 1,
    validate: () => true,
  },

  // ======================== PERSONAL & GOVERNMENT IDs (PII) ========================
  {
    category: "pii",
    priority: 99,
    type: "SSN",
    label: "Social Security / Tax ID",
    regex: /\b(\d{3}-\d{2}-\d{4})\b/g,
    group: 1,
    validate: (m) => passesValidSsn(m),
  },
  {
    category: "pii",
    priority: 97,
    type: "LABELED_SSN_EIN",
    label: "SSN / Tax ID",
    regex: /\b(?:SSN|Social\s+Security|ITIN|Tax\s*ID|EIN|FEIN)[:#\s-]+(\d{2,3}[-\s]?\d{2,7}(?:[-\s]?\d{4})?)\b/gi,
    group: 1,
    validate: (m) => m.replace(/\D/g, "").length === 9,
  },
  {
    category: "pii",
    priority: 92,
    type: "GOV_ID",
    label: "Passport / Driver License",
    regex: /\b(?:Passport(?:\s*(?:#|No\.?))?|Driver'?s?\s+License(?:\s*(?:#|No\.?))?|DL\s*(?:#|No\.?)|State\s*ID)[:\s-]+([A-Z0-9][A-Z0-9-]{5,14})\b/gi,
    group: 1,
    validate: (m) => /\d/.test(m),
  },
  {
    category: "pii",
    priority: 91,
    type: "EMAIL",
    label: "Email Address",
    regex: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    group: 1,
    validate: () => true,
  },
  {
    category: "pii",
    priority: 90,
    type: "PHONE",
    label: "Phone / Fax Number",
    regex: /\b((?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4})\b/g,
    group: 1,
    validate: () => true,
  },
  {
    category: "pii",
    priority: 82,
    type: "STREET_ADDRESS",
    label: "Street Address",
    regex: /\b(\d{1,5}\s+[A-Z][a-zA-Z0-9.\s]{2,28}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Parkway|Pkwy|Circle|Cir)\.?(?:\s*(?:,|#)?\s*(?:Apt|Suite|Ste|Unit|Fl)\.?\s*[A-Za-z0-9-]+)?)\b/g,
    group: 1,
    validate: (m) => m.length >= 10,
  },
  {
    category: "pii",
    priority: 70,
    type: "IPV4",
    label: "IP Address",
    regex: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
    group: 1,
    validate: (m) => passesValidIpv4(m),
  },

  // ======================== FINANCIAL & BANKING ========================
  {
    category: "financial",
    priority: 96,
    type: "CREDIT_CARD",
    label: "Credit / Debit Card",
    regex: /\b((?:\d[ -]*?){13,19})\b/g,
    group: 1,
    validate: (m) => passesLuhn(m.replace(/\D/g, "")),
  },
  {
    category: "financial",
    priority: 95,
    type: "IBAN",
    label: "IBAN Bank Account",
    regex: /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?)\b/g,
    group: 1,
    validate: (m) => passesIbanMod97(m),
  },
  {
    category: "financial",
    priority: 89,
    type: "ABA_ROUTING",
    label: "Bank Routing #",
    regex: /\b(\d{9})\b/g,
    group: 1,
    validate: (m) => passesAbaRouting(m),
  },
  {
    category: "financial",
    priority: 87,
    type: "BANK_ACCT",
    label: "Bank Account #",
    regex: /\b(?:Account\s*(?:#|No\.?|Number)|Acct\s*(?:#|No\.?)|Checking\s*(?:#|No\.?)|Savings\s*(?:#|No\.?))[:\s-]+([0-9-]{6,17})\b/gi,
    group: 1,
    validate: (m) => m.replace(/\D/g, "").length >= 6,
  },
];

/**
 * Stitches fragmented PDF (`pdf.js`) or OCR (`Tesseract`) tokens on the same visual line
 * into complete reading lines with per-character normalized bounding boxes.
 */
function buildStitchedLinesByPage(items) {
  const byPage = new Map();
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const list = byPage.get(item.pageIndex) || [];
    list.push(item);
    byPage.set(item.pageIndex, list);
  }

  const stitchedLines = [];

  for (const [pageIndex, pageItems] of byPage.entries()) {
    // Sort primarily top-to-bottom by vertical center, then left-to-right
    const sorted = [...pageItems].sort((a, b) => {
      const cyA = a.bbox[1] + a.bbox[3] * 0.5;
      const cyB = b.bbox[1] + b.bbox[3] * 0.5;
      if (Math.abs(cyA - cyB) > Math.min(a.bbox[3], b.bbox[3]) * 0.55) {
        return cyA - cyB;
      }
      return a.bbox[0] - b.bbox[0];
    });

    const rawClusters = [];
    for (const tok of sorted) {
      const cy = tok.bbox[1] + tok.bbox[3] * 0.5;
      const last = rawClusters[rawClusters.length - 1];
      if (last && Math.abs(cy - last.cyAvg) <= Math.max(tok.bbox[3], last.hAvg) * 0.58) {
        last.tokens.push(tok);
        const n = last.tokens.length;
        last.cyAvg = (last.cyAvg * (n - 1) + cy) / n;
        last.hAvg = (last.hAvg * (n - 1) + tok.bbox[3]) / n;
      } else {
        rawClusters.push({ cyAvg: cy, hAvg: tok.bbox[3], tokens: [tok] });
      }
    }

    for (const cluster of rawClusters) {
      cluster.tokens.sort((a, b) => a.bbox[0] - b.bbox[0]);
      let lineText = "";
      const charBoxes = [];

      for (let i = 0; i < cluster.tokens.length; i++) {
        const tok = cluster.tokens[i];
        const [tx, ty, tw, th] = tok.bbox;
        const str = tok.str;
        if (!str) continue;

        if (i > 0 && lineText.length > 0) {
          const prev = cluster.tokens[i - 1];
          const prevRight = prev.bbox[0] + prev.bbox[2];
          const avgCharW = Math.max(0.004, tw / Math.max(1, str.length));
          const gap = tx - prevRight;
          const needsSpace =
            gap > avgCharW * 0.25 &&
            !lineText.endsWith(" ") &&
            !str.startsWith(" ") &&
            !lineText.endsWith("-");
          if (needsSpace) {
            lineText += " ";
            charBoxes.push({
              x: prevRight,
              y: ty,
              w: Math.max(0.002, gap),
              h: th,
            });
          }
        }

        const charW = tw / Math.max(1, str.length);
        for (let c = 0; c < str.length; c++) {
          lineText += str[c];
          charBoxes.push({
            x: tx + c * charW,
            y: ty,
            w: charW,
            h: th,
          });
        }
      }

      if (lineText.trim().length >= 4) {
        stitchedLines.push({ pageIndex, lineText, charBoxes });
      }
    }
  }

  return stitchedLines;
}

/**
 * Scans extracted PDF or OCR text items (`{ str, pageIndex, bbox: [x, y, w, h] }`)
 * and returns deduplicated PII & PHI candidates mapped to exact page coordinates.
 * Starts with `enabled: false` (soft readable highlight on canvas) for 1-click or Bulk blackout.
 */
export function detectPiiInTextItems(items) {
  const lines = buildStitchedLinesByPage(items);
  const rawCandidates = [];

  for (const line of lines) {
    const { pageIndex, lineText, charBoxes } = line;

    for (const rule of PATTERNS) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(lineText)) !== null) {
        const fullStr = match[0];
        const targetStr = (rule.group && match[rule.group] ? match[rule.group] : fullStr).trim();
        if (!targetStr || !rule.validate(targetStr)) continue;

        const offsetInMatch = fullStr.lastIndexOf(targetStr);
        const startChar = match.index + Math.max(0, offsetInMatch);
        const endChar = Math.min(charBoxes.length, startChar + targetStr.length);
        if (endChar <= startChar) continue;

        let minX = 1;
        let minY = 1;
        let maxR = 0;
        let maxB = 0;
        for (let idx = startChar; idx < endChar; idx++) {
          const cb = charBoxes[idx];
          if (!cb) continue;
          minX = Math.min(minX, cb.x);
          minY = Math.min(minY, cb.y);
          maxR = Math.max(maxR, cb.x + cb.w);
          maxB = Math.max(maxB, cb.y + cb.h);
        }
        if (maxR <= minX) continue;

        const padX = 0.0035;
        const padY = 0.0025;
        const rx = Math.max(0, minX - padX);
        const ry = Math.max(0, minY - padY);
        const rw = Math.min(1 - rx, maxR - minX + padX * 2);
        const rh = Math.min(1 - ry, maxB - minY + padY * 2);

        rawCandidates.push({
          priority: rule.priority,
          category: rule.category,
          type: rule.type,
          label: rule.label,
          rawValue: targetStr,
          masked: maskSecret(targetStr),
          pageIndex,
          lineRef: line,
          startChar,
          endChar,
          rectNorm: { x: rx, y: ry, w: rw, h: rh },
        });
      }
    }
  }

  // Deduplicate overlapping matches on the same line (highest priority wins)
  rawCandidates.sort((a, b) => b.priority - a.priority || a.startChar - b.startChar);
  const accepted = [];
  for (const cand of rawCandidates) {
    const overlaps = accepted.some(
      (ex) =>
        ex.lineRef === cand.lineRef &&
        Math.max(ex.startChar, cand.startChar) < Math.min(ex.endChar, cand.endChar)
    );
    if (!overlaps) {
      accepted.push(cand);
    }
  }

  accepted.sort(
    (a, b) => a.pageIndex - b.pageIndex || a.rectNorm.y - b.rectNorm.y || a.rectNorm.x - b.rectNorm.x
  );

  return accepted.map((c, idx) => ({
    id: `pii-${idx + 1}-${c.pageIndex}`,
    category: c.category,
    type: c.type,
    label: c.label,
    masked: c.masked,
    rawValue: c.rawValue,
    pageIndex: c.pageIndex,
    rectNorm: c.rectNorm,
    enabled: false, // Highlighted first so user can click 1-by-1 or "Black Out All"
  }));
}

/**
 * Scans plain text extracted from Word (`.docx`) XML paragraphs so `.docx` files
 * surface the same pre-identified PII & PHI checklist for `<w:t>` block redaction.
 */
export function detectPiiInPlainText(fullText) {
  if (!fullText || fullText.length < 4) return [];
  const rawMatches = [];

  for (const rule of PATTERNS) {
    rule.regex.lastIndex = 0;
    let match;
    while ((match = rule.regex.exec(fullText)) !== null) {
      const fullStr = match[0];
      const targetStr = (rule.group && match[rule.group] ? match[rule.group] : fullStr).trim();
      if (!targetStr || !rule.validate(targetStr)) continue;
      const offsetInMatch = fullStr.lastIndexOf(targetStr);
      const startChar = match.index + Math.max(0, offsetInMatch);
      const endChar = startChar + targetStr.length;

      rawMatches.push({
        priority: rule.priority,
        category: rule.category,
        type: rule.type,
        label: rule.label,
        rawValue: targetStr,
        masked: maskSecret(targetStr),
        startChar,
        endChar,
      });
    }
  }

  rawMatches.sort((a, b) => b.priority - a.priority || a.startChar - b.startChar);
  const nonOverlapping = [];
  for (const m of rawMatches) {
    const overlaps = nonOverlapping.some(
      (ex) => Math.max(ex.startChar, m.startChar) < Math.min(ex.endChar, m.endChar)
    );
    if (!overlaps) nonOverlapping.push(m);
  }

  // Group identical string values in .docx so toggling once covers every occurrence cleanly
  const byValue = new Map();
  for (const m of nonOverlapping) {
    const key = `${m.type}::${m.rawValue}`;
    if (!byValue.has(key)) {
      byValue.set(key, { ...m, occurrences: 1 });
    } else {
      byValue.get(key).occurrences += 1;
    }
  }

  return Array.from(byValue.values()).map((m, idx) => ({
    id: `docx-pii-${idx + 1}`,
    category: m.category,
    type: m.type,
    label: m.label,
    masked: m.masked,
    rawValue: m.rawValue,
    occurrences: m.occurrences,
    pageIndex: 0,
    isDocxText: true,
    enabled: false,
  }));
}

/**
 * Checks whether a filename itself leaks PII (SSN, phone, email, or ID keywords).
 */
export function inspectFilenameForPii(stemName) {
  const reasons = [];
  if (/\d{3}[-_\s]?\d{2}[-_\s]?\d{4}/.test(stemName) || /\b(ssn|mrn)\b/i.test(stemName)) {
    reasons.push("SSN / ID pattern");
  }
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(stemName)) {
    reasons.push("Email address");
  }
  if (/\d{3}[-_.\s]\d{3}[-_.\s]\d{4}/.test(stemName)) {
    reasons.push("Phone number");
  }
  if (/\b(passport|driver[-_\s]?license|dl[-_\s]?\d+|dob|patient)\b/i.test(stemName)) {
    reasons.push("Sensitive ID keyword");
  }
  return {
    hasRisk: reasons.length > 0,
    reasons,
  };
}

export function generateAnonymousStem() {
  const today = new Date().toISOString().slice(0, 10);
  return `Clean_Document_${today}`;
}

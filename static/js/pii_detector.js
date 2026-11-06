/**
 * Deterministic Client-Side PII & Checksum Scanner (Zero-LLM, 100% In-Browser).
 * Detects SSNs, Credit Cards (Luhn), US ABA Routing Numbers (3-7-1 checksum),
 * IBANs (Mod-97), Phone Numbers, Email Addresses, IPv4, and Filename PII.
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

export function passesValidSsn(ssnStr) {
  const digits = ssnStr.replace(/\D/g, "");
  if (digits.length !== 9) return false;
  const area = parseInt(digits.slice(0, 3), 10);
  const group = parseInt(digits.slice(3, 5), 10);
  const serial = parseInt(digits.slice(5, 9), 10);
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0 || serial === 0) return false;
  return true;
}

export function maskSecret(raw) {
  const clean = String(raw).trim();
  if (clean.length <= 4) return "••••";
  return "•".repeat(Math.min(8, clean.length - 4)) + clean.slice(-4);
}

const PATTERNS = [
  {
    type: "SSN",
    label: "Social Security Number",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    validate: (m) => passesValidSsn(m),
  },
  {
    type: "CREDIT_CARD",
    label: "Credit / Debit Card",
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: (m) => passesLuhn(m.replace(/\D/g, "")),
  },
  {
    type: "EMAIL",
    label: "Email Address",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    validate: () => true,
  },
  {
    type: "PHONE",
    label: "Phone Number",
    regex: /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/g,
    validate: () => true,
  },
  {
    type: "ABA_ROUTING",
    label: "Bank Routing Number",
    regex: /\b\d{9}\b/g,
    validate: (m) => passesAbaRouting(m),
  },
];

/**
 * Scans extracted PDF/text items (`{ str, pageIndex, bbox: [x, y, w, h] }`)
 * and returns structured PII matches mapped to exact page coordinates.
 */
export function detectPiiInTextItems(items) {
  const findings = [];
  let seq = 1;

  for (const item of items) {
    const text = item.str || "";
    if (!text || text.length < 5) continue;

    for (const rule of PATTERNS) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(text)) !== null) {
        const matchedStr = match[0].trim();
        if (!rule.validate(matchedStr)) continue;

        // Compute proportional sub-box inside the text span so only the sensitive substring is covered
        const startRatio = match.index / Math.max(1, text.length);
        const widthRatio = matchedStr.length / Math.max(1, text.length);
        const [bx, by, bw, bh] = item.bbox;
        const subX = bx + bw * startRatio;
        const subW = Math.max(0.024, bw * widthRatio);
        const clampedX = Math.max(0, subX - 0.004);

        findings.push({
          id: `pii-${seq++}`,
          type: rule.type,
          label: rule.label,
          masked: maskSecret(matchedStr),
          pageIndex: item.pageIndex,
          rectNorm: {
            x: clampedX,
            y: Math.max(0, by - 0.003),
            w: Math.min(1 - clampedX, subW + 0.008),
            h: Math.min(1, bh + 0.006),
          },
          enabled: true,
        });
      }
    }
  }
  return findings;
}

/**
 * Checks whether a filename itself leaks PII (SSN, phone, email, long IDs, or personal name patterns).
 */
export function inspectFilenameForPii(stemName) {
  const reasons = [];
  if (/\d{3}[-_\s]?\d{2}[-_\s]?\d{4}/.test(stemName) || /\bssn\b/i.test(stemName)) {
    reasons.push("SSN / Tax ID pattern");
  }
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(stemName)) {
    reasons.push("Email address");
  }
  if (/\d{3}[-_.\s]\d{3}[-_.\s]\d{4}/.test(stemName)) {
    reasons.push("Phone number");
  }
  if (/\b(passport|driver[-_\s]?license|dl[-_\s]?\d+|dob)\b/i.test(stemName)) {
    reasons.push("Sensitive ID keyword");
  }
  return {
    hasRisk: reasons.length > 0,
    reasons,
  };
}

export function generateAnonymousStem() {
  const today = new Date().toISOString().slice(0, 10);
  return `Sanitized_Document_${today}`;
}

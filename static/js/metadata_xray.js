/**
 * Client-Side Binary & XML Metadata X-Ray Inspector (Zero-LLM, 100% Browser Memory).
 * Detects magic bytes and inspects hidden EXIF/GPS/Thumbnails (images),
 * PDF /Info & XMP & Annotations (PDFs), and core.xml/app.xml/comments (DOCX).
 */

export function detectFileFormatFromBytes(uint8, fallbackName = "") {
  if (uint8.length >= 5) {
    if (
      uint8[0] === 0x25 &&
      uint8[1] === 0x50 &&
      uint8[2] === 0x44 &&
      uint8[3] === 0x46 &&
      uint8[4] === 0x2d
    ) {
      return "pdf";
    }
    if (uint8[0] === 0xff && uint8[1] === 0xd8 && uint8[2] === 0xff) {
      return "jpeg";
    }
    if (
      uint8[0] === 0x89 &&
      uint8[1] === 0x50 &&
      uint8[2] === 0x4e &&
      uint8[3] === 0x47
    ) {
      return "png";
    }
    if (
      uint8[0] === 0x52 &&
      uint8[1] === 0x49 &&
      uint8[2] === 0x46 &&
      uint8[3] === 0x46 &&
      uint8.length >= 12 &&
      uint8[8] === 0x57 &&
      uint8[9] === 0x45 &&
      uint8[10] === 0x42 &&
      uint8[11] === 0x50
    ) {
      return "webp";
    }
    // PK\x03\x04 ZIP container (.docx)
    if (uint8[0] === 0x50 && uint8[1] === 0x4b && uint8[2] === 0x03 && uint8[3] === 0x04) {
      return "docx";
    }
  }
  const lower = fallbackName.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".webp")) return "webp";
  return "jpeg";
}

export async function runMetadataXray(uint8, format) {
  const leaks = [];

  if (format === "jpeg" || format === "png" || format === "webp") {
    try {
      if (window.exifr) {
        const meta = await window.exifr.parse(uint8, {
          tiff: true,
          exif: true,
          gps: true,
          xmp: true,
          iptc: true,
          icc: false,
        });
        if (meta) {
          if (typeof meta.latitude === "number" && typeof meta.longitude === "number") {
            leaks.push({
              severity: "high",
              icon: "📍",
              title: "Exact GPS Coordinates",
              detail: `${meta.latitude.toFixed(5)}°, ${meta.longitude.toFixed(5)}°`,
            });
          }
          const deviceParts = [meta.Make, meta.Model, meta.LensModel].filter(Boolean);
          if (deviceParts.length) {
            leaks.push({
              severity: "medium",
              icon: "📱",
              title: "Camera / Device Identity",
              detail: deviceParts.join(" • "),
            });
          }
          const serial = meta.BodySerialNumber || meta.SerialNumber || meta.LensSerialNumber;
          if (serial) {
            leaks.push({
              severity: "high",
              icon: "🔢",
              title: "Hardware Serial Number",
              detail: String(serial),
            });
          }
          const author = meta.Artist || meta.XPAuthor || meta.Creator || meta.Copyright;
          if (author) {
            leaks.push({
              severity: "high",
              icon: "👤",
              title: "Embedded Author / Creator",
              detail: String(author),
            });
          }
          if (meta.Software || meta.ModifyDate || meta.DateTimeOriginal) {
            const info = [
              meta.Software ? `Software: ${meta.Software}` : null,
              meta.DateTimeOriginal ? `Captured: ${new Date(meta.DateTimeOriginal).toLocaleString()}` : null,
            ]
              .filter(Boolean)
              .join(" • ");
            if (info) {
              leaks.push({
                severity: "low",
                icon: "🕒",
                title: "Capture Timestamp & Software",
                detail: info,
              });
            }
          }
        }
        const thumb = await window.exifr.thumbnail(uint8).catch(() => null);
        if (thumb && thumb.byteLength > 0) {
          leaks.push({
            severity: "high",
            icon: "🖼️",
            title: "Hidden EXIF Preview Thumbnail",
            detail: `${(thumb.byteLength / 1024).toFixed(1)} KB embedded preview (can leak cropped content)`,
          });
        }
      }
    } catch {
      // Non-fatal metadata parse fallback
    }
  } else if (format === "pdf") {
    try {
      const { PDFDocument } = window.PDFLib;
      const pdfDoc = await PDFDocument.load(uint8, { ignoreEncryption: true, updateMetadata: false });
      const author = pdfDoc.getAuthor();
      const creator = pdfDoc.getCreator();
      const producer = pdfDoc.getProducer();
      const title = pdfDoc.getTitle();
      const subject = pdfDoc.getSubject();
      const keywords = pdfDoc.getKeywords();
      const created = pdfDoc.getCreationDate();
      const modified = pdfDoc.getModificationDate();

      if (author) {
        leaks.push({ severity: "high", icon: "👤", title: "Hidden PDF Author", detail: author });
      }
      if (title || subject || keywords) {
        leaks.push({
          severity: "medium",
          icon: "🏷️",
          title: "Document Title / Subject Tags",
          detail: [title, subject, keywords].filter(Boolean).join(" • "),
        });
      }
      if (creator || producer) {
        leaks.push({
          severity: "low",
          icon: "⚙️",
          title: "Originating App & Producer",
          detail: [creator, producer].filter(Boolean).join(" / "),
        });
      }
      if (created || modified) {
        leaks.push({
          severity: "low",
          icon: "🕒",
          title: "Internal Revision Timestamps",
          detail: [
            created ? `Created ${created.toISOString().slice(0, 10)}` : null,
            modified ? `Modified ${modified.toISOString().slice(0, 10)}` : null,
          ]
            .filter(Boolean)
            .join(" • "),
        });
      }
      // Check raw bytes for embedded XMP packet
      const rawSample = new TextDecoder("latin1").decode(uint8.subarray(0, Math.min(uint8.length, 500000)));
      if (rawSample.includes("<x:xmpmeta") || rawSample.includes("http://ns.adobe.com/xap/1.0/")) {
        leaks.push({
          severity: "medium",
          icon: "🧬",
          title: "Embedded XMP XML Stream",
          detail: "Contains raw Adobe XMP history metadata packet",
        });
      }
    } catch {
      // Encrypted or malformed PDF fallback
    }
  } else if (format === "docx") {
    try {
      const zip = await window.JSZip.loadAsync(uint8);
      const parser = new DOMParser();

      if (zip.file("docProps/core.xml")) {
        const xmlText = await zip.file("docProps/core.xml").async("string");
        const doc = parser.parseFromString(xmlText, "application/xml");
        const creator = doc.getElementsByTagName("dc:creator")[0]?.textContent;
        const lastModBy = doc.getElementsByTagName("cp:lastModifiedBy")[0]?.textContent;
        const revision = doc.getElementsByTagName("cp:revision")[0]?.textContent;
        if (creator || lastModBy) {
          leaks.push({
            severity: "high",
            icon: "👤",
            title: "Word Author & Last Editor",
            detail: [
              creator ? `Author: ${creator}` : null,
              lastModBy ? `Last edited by: ${lastModBy}` : null,
            ]
              .filter(Boolean)
              .join(" • "),
          });
        }
        if (revision) {
          leaks.push({
            severity: "low",
            icon: "📝",
            title: "Edit Revision Counter",
            detail: `${revision} saved editing sessions recorded`,
          });
        }
      }

      if (zip.file("docProps/app.xml")) {
        const appXml = await zip.file("docProps/app.xml").async("string");
        const doc = parser.parseFromString(appXml, "application/xml");
        const company = doc.getElementsByTagName("Company")[0]?.textContent;
        const manager = doc.getElementsByTagName("Manager")[0]?.textContent;
        if (company || manager) {
          leaks.push({
            severity: "medium",
            icon: "🏢",
            title: "Organization / Manager Property",
            detail: [company, manager].filter(Boolean).join(" • "),
          });
        }
      }

      if (zip.file("word/comments.xml")) {
        leaks.push({
          severity: "high",
          icon: "💬",
          title: "Reviewer Comments XML",
          detail: "Embedded Word reviewer comments present inside archive",
        });
      }

      if (zip.file("word/document.xml")) {
        const bodyXml = await zip.file("word/document.xml").async("string");
        if (bodyXml.includes("<w:del ") || bodyXml.includes("<w:ins ")) {
          leaks.push({
            severity: "high",
            icon: "🔍",
            title: "Tracked Changes / Deleted Text",
            detail: "Contains unaccepted Word Track Changes history",
          });
        }
      }
    } catch {
      // Ignore corrupt zip
    }
  }

  return leaks;
}

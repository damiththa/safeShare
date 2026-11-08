/**
 * Lazy-Loaded In-Browser Wasm OCR Engine (`Tesseract.js` v5 — 0 Bytes Sent to Servers).
 *
 * Zero Initial Bloat Design:
 *  - Normal digital PDFs and `.docx` files download 0 bytes of OCR assets.
 *  - Only when an image (`.jpg`/`.png`/`.webp`) or a scanned PDF page (0 selectable text)
 *    is opened does this module lazily load `/static/vendor/tesseract/tesseract.min.js`
 *    and spin up a singleton Web Worker using self-hosted Wasm + English traineddata.
 */

let scriptLoadPromise = null;
let workerPromise = null;

function ensureTesseractScriptLoaded() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/static/vendor/tesseract/tesseract.min.js";
    script.async = true;
    script.onload = () => {
      if (window.Tesseract) {
        resolve(window.Tesseract);
      } else {
        reject(new Error("OCR library loaded without global Tesseract object."));
      }
    };
    script.onerror = () => {
      scriptLoadPromise = null;
      reject(new Error("Unable to load browser OCR module."));
    };
    document.head.appendChild(script);
  });

  return scriptLoadPromise;
}

async function getReusableOcrWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const Tesseract = await ensureTesseractScriptLoaded();
      const worker = await Tesseract.createWorker("eng", 1, {
        workerPath: "/static/vendor/tesseract/worker.min.js",
        corePath: "/static/vendor/tesseract/core",
        langPath: "/static/vendor/tesseract/lang",
        workerBlobURL: false,
        logger: (msg) => {
          if (msg && typeof msg.progress === "number" && onProgress) {
            onProgress(msg);
          }
        },
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/**
 * Runs OCR on an HTMLCanvasElement or ImageBitmap-backed canvas and returns normalized
 * word tokens `{ str, pageIndex, bbox: [x, y, w, h] }` ready for `detectPiiInTextItems()`.
 */
export async function extractOcrTextItemsFromCanvas(sourceCanvas, pageIndex = 0, onProgress = null) {
  const width = Math.max(1, sourceCanvas.width);
  const height = Math.max(1, sourceCanvas.height);

  const worker = await getReusableOcrWorker(onProgress);
  const result = await worker.recognize(sourceCanvas);
  const data = result?.data || {};
  const extracted = [];

  const pushWord = (w) => {
    const text = (w?.text || "").trim();
    if (!text) return;
    if (typeof w.confidence === "number" && w.confidence < 32) return;
    const b = w.bbox;
    if (!b || b.x1 <= b.x0 || b.y1 <= b.y0) return;
    extracted.push({
      str: text,
      pageIndex,
      bbox: [
        Math.max(0, b.x0 / width),
        Math.max(0, b.y0 / height),
        Math.min(1, (b.x1 - b.x0) / width),
        Math.min(1, (b.y1 - b.y0) / height),
      ],
    });
  };

  if (Array.isArray(data.blocks) && data.blocks.length > 0) {
    for (const block of data.blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const word of line.words || []) {
            pushWord(word);
          }
        }
      }
    }
  } else if (Array.isArray(data.words)) {
    for (const word of data.words) {
      pushWord(word);
    }
  }

  return extracted;
}

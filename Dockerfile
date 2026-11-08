FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

# Install curl solely to fetch pinned MIT/Apache-2.0 client-side browser bundles at build time
# so zero third-party CDNs are queried from users' browsers at runtime.
# Tesseract.js Wasm OCR files live under /static/vendor/tesseract and are lazy-loaded ONLY on images/scanned PDFs.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && mkdir -p /app/static/vendor/tesseract/core /app/static/vendor/tesseract/lang \
    && curl -fsSL https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js -o /app/static/vendor/pdf-lib.min.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js -o /app/static/vendor/pdf.min.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js -o /app/static/vendor/pdf.worker.min.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.umd.js -o /app/static/vendor/exifr.full.umd.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js -o /app/static/vendor/jszip.min.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js -o /app/static/vendor/tesseract/tesseract.min.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js -o /app/static/vendor/tesseract/worker.min.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core.wasm.js -o /app/static/vendor/tesseract/core/tesseract-core.wasm.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd.wasm.js -o /app/static/vendor/tesseract/core/tesseract-core-simd.wasm.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-lstm.wasm.js -o /app/static/vendor/tesseract/core/tesseract-core-lstm.wasm.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js -o /app/static/vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz -o /app/static/vendor/tesseract/lang/eng.traineddata.gz \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static

RUN useradd --create-home --shell /sbin/nologin safeshare \
    && chown -R safeshare:safeshare /app
USER safeshare

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]

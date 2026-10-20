/**
 * Offline OCR for captured questions (Tesseract.js, all assets served locally).
 *
 * The engine (~3 MB WASM core + ~2 MB English data) lives in `public/ocr/` and is
 * loaded lazily on the first capture — it never touches the initial bundle and it
 * never uploads the photo anywhere. Sources: `tesseract.js` npm package (worker),
 * `tesseract.js-core` (WASM core), English data from tesseract-ocr/tessdata_fast.
 * Regenerate with: cp node_modules/tesseract.js/dist/worker.min.js public/ocr/ &&
 * cp node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm* public/ocr/
 *
 * Returns null on any failure. Bad light and crooked photos are facts of life;
 * the caller shows whatever text arrived in an editable box and lets the human
 * fix it — a person correcting OCR is honest, silently solving garbage is not.
 */

let workerPromise: Promise<unknown> | null = null;

const base = (): string => {
  const b = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return b.endsWith('/') ? b : `${b}/`;
};

async function worker(): Promise<{ recognize: (img: Blob) => Promise<{ data: { text: string } }> }> {
  workerPromise ??= (async () => {
    const tess = (await import('tesseract.js')) as unknown as {
      createWorker: (lang: string, oem?: number, opts?: Record<string, unknown>) => Promise<unknown>;
    };
    return tess.createWorker('eng', 1, {
      workerPath: `${base()}ocr/worker.min.js`,
      corePath: `${base()}ocr/`,
      langPath: `${base()}ocr/`,
      cacheMethod: 'none',
      gzip: true,
    });
  })();
  return workerPromise as Promise<{ recognize: (img: Blob) => Promise<{ data: { text: string } }> }>;
}

/** Read the text in a photo. Null when OCR is unavailable or fails. */
export async function readPhoto(image: Blob): Promise<string | null> {
  try {
    const w = await worker();
    const { data } = await w.recognize(image);
    const text = data.text.trim();
    return text.length > 0 ? text : null;
  } catch {
    workerPromise = null; // a poisoned worker should not fail every later attempt
    return null;
  }
}

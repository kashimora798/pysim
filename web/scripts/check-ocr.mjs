/**
 * OCR smoke check (manual, slow): Tesseract must read a synthetic textbook page
 * using the language data + WASM core we ship in public/ocr -- no CDN, no upload.
 * Run directly (not bundled; tesseract's node worker does not survive bundling):
 *   node scripts/check-ocr.mjs <image.png>
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(webRoot, 'public', 'ocr');
const imagePath = process.argv[2] ?? process.env.FF_OCR_IMAGE;
if (!imagePath) { console.error('usage: node scripts/check-ocr.mjs <image.png>'); process.exit(2); }

const worker = await createWorker('eng', 1, {
  langPath: assets,
  cacheMethod: 'none',
  gzip: true,
  logger: () => undefined,
});
const { data } = await worker.recognize(readFileSync(imagePath));
await worker.terminate();

const text = data.text;
console.log('--- OCR read ---\n' + text.trim() + '\n----------------');
// OCR of small print often drops spaces ('4ohm'); judge on squashed text.
const squash = (s) => s.toLowerCase().replace(/\s+/g, '');
const flat = squash(text);
const must = ['12v', 'battery', '4ohm', 'resistor', 'current', '9v'];
const missing = must.filter((s) => !flat.includes(s));
if (missing.length > 0) { console.error(`✗ OCR missed: ${missing.join(', ')}`); process.exit(1); }
console.log('✓ OCR reads the page with local assets only');

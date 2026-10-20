# OCR assets (loaded lazily, only for question capture)

All files here are served locally — the OCR engine never calls a CDN and never
uploads a photo. Regenerate after upgrading tesseract.js:

- `worker.min.js` — from the `tesseract.js` npm package (`dist/`)
- `tesseract-core-*.wasm(.js)` — from the `tesseract.js-core` npm package
  (SIMD-LSTM preferred, LSTM fallback)
- `eng.traineddata.gz` — English language data from
  https://github.com/tesseract-ocr/tessdata_fast (Apache-2.0)

Licences: tesseract.js / tesseract.js-core are Apache-2.0; tessdata_fast is
Apache-2.0. See docs/licences.md.

#!/usr/bin/env node
// Fail if the built bundle appears to contain an inlined secret.
// Used by .github/workflows/deploy.yml and locally after `npm run build`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dist = join(import.meta.dirname, "..", "dist");
const hits = [];
let files = 0;
try {
  for (const f of readdirSync(dist, { recursive: true })) {
    if (!String(f).endsWith(".js")) continue;
    files++;
    const text = readFileSync(join(dist, String(f)), "utf8");
    if (/sk-[A-Za-z0-9]{10,}/.test(text)) hits.push(`${f}: looks like sk- key`);
    if (/VITE_FF_AI_PROXY\s*=\s*["']https?:/.test(text) && text.includes("api.featherless.ai"))
      hits.push(`${f}: bundled proxy still references featherless origin`);
  }
} catch (e) {
  console.error(`no dist/ yet — run npm run build first: ${e.message}`);
  process.exit(1);
}
if (hits.length) {
  console.error("bundle secret scan failed:");
  for (const h of hits) console.error("  - " + h);
  process.exit(1);
}
console.log(`bundle secret scan clean (${files} js files)`);

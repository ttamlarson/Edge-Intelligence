import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(root, "dist");
const assets = [
  "index.html", "app.js", "domain.js", "au-sources.js", "autonomous-engine.js", "coinspot-strategy.js", "adaptive-regime-strategy.js", "regime-adaptive-breakout.js", "crypto-csv.js", "styles.css",
  "manifest.webmanifest", "sw.js", "icon.svg", "icon-192.png", "icon-512.png", "_headers"
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const asset of assets) {
  const source = join(root, asset);
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) throw new Error(`Required Pages asset is missing: ${asset}`);
  await cp(source, join(output, asset));
}
const html = await readFile(join(output, "index.html"), "utf8");
for (const required of ["./app.js", "./styles.css", "./manifest.webmanifest"]) {
  if (!html.includes(required)) throw new Error(`Built HTML does not reference ${required}`);
}
const app = await readFile(join(output, "app.js"), "utf8");
if (app.includes('from "./autonomous-engine.js"') && !(await stat(join(output, "autonomous-engine.js")).catch(() => null))) {
  throw new Error("The ASX paper engine import is missing from the Pages output.");
}
console.log(`Built ${assets.length} static assets into ${output}`);
console.log("Configure the Worker API URL in EDGE Settings; no secrets or Worker source are copied to Pages.");

// Client build: bundle the React app with Bun.build, compile the
// Tailwind stylesheet with @tailwindcss/cli, and copy index.html —
// everything lands in client/dist/ for the local server to serve.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(clientDir, "..");
const distDir = path.join(clientDir, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

// 1) JS bundle: src/main.tsx -> dist/main.js
const result = await Bun.build({
  entrypoints: [path.join(clientDir, "src", "main.tsx")],
  outdir: distDir,
  target: "browser",
  naming: "main.js",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// 2) CSS: src/theme.css -> dist/styles.css (Tailwind CSS v4 CLI)
const tailwindBin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tailwindcss.cmd" : "tailwindcss",
);
const css = spawnSync(
  tailwindBin,
  [
    "-i",
    path.join(clientDir, "src", "theme.css"),
    "-o",
    path.join(distDir, "styles.css"),
  ],
  { stdio: "inherit" },
);
if (css.status !== 0) {
  console.error("tailwindcss CLI failed");
  process.exit(css.status ?? 1);
}

// 3) HTML shell
fs.copyFileSync(
  path.join(clientDir, "index.html"),
  path.join(distDir, "index.html"),
);

console.log("client built -> client/dist/");

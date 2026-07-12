#!/usr/bin/env node
// Post-build step for the static SPA bundle (STATIC_BUILD=1).
//
// TanStack Start's SPA mode emits the bootable HTML as `_shell.html` (the
// "SPA mask"). Plain static hosts (Apache shared hosting, WordPress File
// Manager, etc.) need `index.html` as the entry, so we copy the shell into
// place after the Vite build finishes. The .htaccess uploaded alongside
// rewrites every client-side route (/lobby, /project/$id, …) back to
// index.html so direct loads / refreshes work.
//
// Idempotent: safe to re-run.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "dist/client");
const shell = resolve(outDir, "_shell.html");
const index = resolve(outDir, "index.html");

if (!existsSync(shell)) {
  console.error(
    `[finalize-static-build] expected ${shell} to exist after \`vite build\` with STATIC_BUILD=1. ` +
      `Did the build complete? Did you forget STATIC_BUILD=1?`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(shell, index);
console.log(`[finalize-static-build] wrote ${index} (copy of _shell.html)`);
console.log(
  `[finalize-static-build] static bundle ready in dist/client/ — upload its contents to your host.`,
);

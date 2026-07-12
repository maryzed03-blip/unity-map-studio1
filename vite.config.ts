// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// ---------------------------------------------------------------------------
// STAGE 5 — Opt-in static SPA build for plain shared/static hosting.
// Enable by running:   npm run build:static
//   e.g. VITE_BASE_PATH=/unity-map-studio/ npm run build:static
// `build:static` sets STATIC_BUILD=1 and runs scripts/finalize-static-build.mjs
// after the Vite build to materialize dist/client/index.html from _shell.html.
// When STATIC_BUILD is unset, the default Lovable-hosted SSR build is used
// (current behavior, unchanged). See DEPLOYMENT.md for the full workflow.
// ---------------------------------------------------------------------------
const STATIC_BUILD = process.env.STATIC_BUILD === "1" || process.env.STATIC_BUILD === "true";
const BASE_PATH = process.env.VITE_BASE_PATH || "/";

export default defineConfig({
  // In SPA mode there is no server entry — disable nitro entirely so the
  // build output is a plain client bundle (index.html + hashed assets) that
  // any static file server (Apache, Nginx, `python -m http.server`, etc.)
  // can serve without a Node process. In SSR mode, fall through to the
  // wrapper's default nitro behavior (Cloudflare in Lovable, Vite-only
  // outside).
  nitro: STATIC_BUILD ? false : undefined,
  tanstackStart: STATIC_BUILD
    ? {
        // SPA mode: TanStack Start emits a client-only HTML shell that
        // hydrates the router on the browser. No server functions are used
        // by this app, so this is safe (see Stage 5 prompt context).
        spa: { enabled: true },
      }
    : {
        // SSR mode (default): redirect TanStack Start's bundled server entry
        // to src/server.ts (our SSR error wrapper). nitro/vite builds from this.
        server: { entry: "server" },
      },
  vite: {
    // Allow deploying into a subfolder of an existing site (e.g. WordPress
    // under /unity-map-studio/). TanStack Router's <Link> / navigate APIs are
    // base-aware once Vite's `base` is set.
    base: BASE_PATH,
    build: {
      // Split heavy third-party vendors out of the main entry chunk so the
      // lobby/auth screens don't pay for firebase + radix on first load.
      // TanStack Router already code-splits per route file.
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks: (id: string) => {
            if (!id.includes("node_modules")) return undefined;
            if (id.includes("firebase")) return "vendor-firebase";
            if (id.includes("@radix-ui")) return "vendor-radix";
            if (id.includes("lucide-react")) return "vendor-icons";
            return undefined;
          },
        },
      },
    },
  },
});


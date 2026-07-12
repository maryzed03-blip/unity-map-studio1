# Deployment Guide — Static Hosting (Apache / WordPress subfolder)

This guide is for the **owner** uploading the app to a plain shared host
(e.g. WordPress File Manager, cPanel, Apache/Nginx static folder). It does
**not** apply when running on Lovable's own hosting — Lovable continues to
use the default SSR build automatically.

---

## 1. Build the static bundle

Run this on any machine with Node.js (or inside the Lovable sandbox shell):

```bash
STATIC_BUILD=1 \
VITE_BASE_PATH=/unity-map-studio/ \
VITE_TEACHER_SIGNUP_CODE=your-teacher-code \
VITE_BOARD_STORAGE_TOKEN=your-storage-token \
npm install
npm run build
```

Adjust `VITE_BASE_PATH` to match the **exact** subfolder on your host:
- Domain root (e.g. `https://example.gr/`)  → `VITE_BASE_PATH=/`
- Subfolder (e.g. `https://example.gr/unity-map-studio/`) → `VITE_BASE_PATH=/unity-map-studio/`

The trailing slash matters. `/unity-map-studio` (no trailing `/`) will
produce broken asset URLs.

> **Security note** — every `VITE_*` value is baked into the public JS bundle
> and is visible to anyone who views the page source. Use only credentials
> intended to be public (publishable / anon-style). This is true for the
> Firebase config, the teacher signup code, and the board storage token.
> You are responsible for setting these correctly before each build.

---

## 2. Find the build output

After `npm run build` finishes, the static output is a single self-contained
folder produced by Vite — typically `dist/` (or `dist/client/` on some
TanStack Start versions). It must contain at minimum:

- `index.html`
- An `assets/` folder (or similar) with hashed `.js` and `.css` files
- `.htaccess` (copied automatically from `public/.htaccess`)
- `404.html` (fallback for hosts that disable `.htaccess`)
- Any other public files (favicons, etc.)

There is **no** `dist/server/server.js` step required — opening `index.html`
through any plain static file server is sufficient.

You can preview locally with any static server, e.g.:

```bash
npx serve dist
```

If `dist/client/` exists instead of `dist/`, use that path.

---

## 3. Upload to the host

Upload the **contents** of the build folder **into** the target subfolder on
your shared host, preserving the folder structure (do NOT flatten):

```
public_html/
└── unity-map-studio/        ← matches VITE_BASE_PATH
    ├── index.html
    ├── .htaccess
    ├── 404.html
    └── assets/
        ├── app-<hash>.js
        ├── app-<hash>.css
        └── …
```

If you set `VITE_BASE_PATH=/`, upload the contents directly into
`public_html/` instead.

The `.htaccess` file may be hidden in some File Manager UIs — make sure
"show hidden files" is enabled before uploading, otherwise client-side
routes (`/lobby`, `/project/...`, `/live/...`) will 404 on refresh.

---

## 4. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Blank white page, console shows 404s for `/assets/...` | `VITE_BASE_PATH` doesn't match the actual upload folder | Rebuild with the correct base path and re-upload |
| Home page works but `/lobby` 404s on direct load / refresh | `.htaccess` not uploaded, or the host disables `AllowOverride` | (a) confirm `.htaccess` exists in the folder; (b) ask hosting support to enable `AllowOverride All` for the directory; (c) the `404.html` fallback will still bounce users back to the app, but the URL will briefly flash through index.html |
| Firebase Auth fails / Web Speech API does nothing / "mixed content" warnings | The site is served over plain HTTP | Enable HTTPS on the host. Firebase Auth and Web Speech require a secure context |
| Login works but data isn't loading | Wrong build-time secrets, or Firestore rules block this origin | Verify `VITE_*` values in the build, and that the host domain is allowed in Firebase Auth → Authorized domains |
| App loaded once, but updates from Lovable don't show up | Static builds are **snapshots** | See section 5 |

---

## 5. Updates are NOT automatic

This static build is a **snapshot** of the app at the time you built it.
Future changes made in Lovable will **not** automatically appear on the
WordPress-hosted copy. To update:

1. Pull / re-export the latest code.
2. Re-run the build command from section 1.
3. Re-upload the contents of the build folder, replacing the old files.

---

## 6. SSR build still works on Lovable

We kept the existing SSR build path as the default. Running plain
`npm run build` (without `STATIC_BUILD=1`) still produces the SSR-capable
bundle that Lovable's hosting uses. This means you can keep iterating on
Lovable normally and only opt into the static build when you specifically
want to publish a snapshot to your own shared host.

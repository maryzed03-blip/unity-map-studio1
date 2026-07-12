# Unity Map Studio

TanStack Start app for collaborative concept-mapping (solo + live classroom
sessions). Built on Lovable.

## Develop

```bash
npm install
npm run dev
```

## Build (default — SSR, used by Lovable hosting)

```bash
npm run build
```

This is the build that ships from Lovable's hosting and is also what runs in
preview. No extra configuration is required.

## Build for static hosting (Apache / WordPress subfolder)

Use this when you want to host the app on your own plain shared hosting
(e.g. a WordPress install with File Manager / cPanel) without any Node.js
server. It produces a single self-contained folder of static files.

```bash
STATIC_BUILD=1 \
VITE_BASE_PATH=/unity-map-studio/ \
VITE_TEACHER_SIGNUP_CODE=your-teacher-code \
VITE_BOARD_STORAGE_TOKEN=your-storage-token \
npm run build
```

- `STATIC_BUILD=1` switches TanStack Start into SPA mode and disables the
  nitro server bundle. Without it, the default SSR build above is used.
- `VITE_BASE_PATH` must match the **exact** subfolder on the host
  (trailing slash included). Use `/` for the domain root.
- All `VITE_*` values are baked into the **public** JS bundle at build time
  and are visible to anyone who views the page source. Use only credentials
  intended to be public. The owner is responsible for setting these
  correctly before each build, since there is no server to set them at
  runtime.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full upload workflow,
`.htaccess` notes, and troubleshooting.

## Test

```bash
npm run test
```

See [TESTING.md](./TESTING.md) for the test layout and what's covered.

## Security

See [SECURITY.md](./SECURITY.md) for the threat model, Firestore rules
notes, and the build-time-secret caveat for `VITE_*` values.

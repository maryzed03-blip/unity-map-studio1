# Testing

Run all tests:

```
npm run test
```

The suite uses [Vitest](https://vitest.dev/) with `happy-dom`. Every test
runs **offline** — Firebase, OpenAI, and Realtime Database calls are
mocked at the module/function boundary. The suite **MUST NOT** make any
real network request, ever (it would burn Firebase quota and OpenAI
credits during CI).

## What's covered

- `src/lib/canvas/__tests__/schema.test.ts` — `hashCanvasState` determinism.
- `src/lib/canvas/__tests__/templates.test.ts` — every template factory
  produces a valid `CanvasState` with finite coordinates.
- `src/lib/canvas/__tests__/export.test.ts` — `exportJSON` payload shape
  (PNG/SVG rasterisation needs a real DOM and is verified manually).
- `src/lib/canvas/__tests__/live-merge.test.ts` — the per-object live
  sync merge policy from `live-merge.ts`, including new-vs-deleted
  disambiguation via `seenRemoteIds`.
- `src/lib/__tests__/ai.test.ts` — `summarizeCanvas`, `maskKey`, and the
  `sanitize` / `clamp` path of `aiGenerate` (via a mocked `fetch`).
- `src/lib/__tests__/quota-guard.test.ts` — read/write counter increments
  and WARN/CRITICAL threshold transitions (Firestore is mocked).

## What's NOT covered

- Firebase Auth flows (sign in / sign up / role gate).
- Live Firestore reads/writes, invitations, presence, live sessions.
- Real OpenAI calls.
- Canvas pointer interactions / rendered SVG layout.

Verify those manually against a real Firebase project. See `SECURITY.md`
for the deployment checklist.

# Security

## Firebase rules

This repo ships two rules files that the Lovable build **does not** publish
to your live Firebase project automatically:

- `firestore.rules` — Cloud Firestore access control for `users` (+ `private`
  subcollection), `projects` (+ `members`, `snapshots`), `liveSessions`
  (+ `groupRooms`), and `invitations`.
- `database.rules.json` — Realtime Database rules for the `/presence/{uid}`
  node used by `src/lib/presence.ts`.

Publish via Firebase Console (Rules → Publish) or:

```bash
firebase deploy --only firestore:rules,database
```

## Role integrity (current stop-gap)

User roles (`student | teacher | therapist`) are stored on
`users/{uid}.role`. At signup the client **must** present a shared
`TEACHER_SIGNUP_CODE` (see `VITE_TEACHER_SIGNUP_CODE`) before `teacher` or
`therapist` is accepted; otherwise the account is silently downgraded to
`student`. The Firestore rules make `role` **immutable after creation**.

Proper enforcement requires a server-side path (Cloud Function / custom
claim). Until then, treat any non-`student` role as advisory and re-verify
server-side before granting privileged actions.

## OpenAI integration (teacher / therapist only)

The OpenAI API key is stored at `users/{uid}/private/settings.openaiApiKey`.
The `private` subcollection is locked down to the owning user only — it is
**not** covered by the broader profile-read rule.

The OpenAI call itself is made **directly from the teacher's browser** to
`https://api.openai.com`. There is no backend proxy in this stage. Implications:

- The key is only as safe as the teacher's own browser/session.
- The key is visible in that teacher's own DevTools network tab.
- The key is **never** readable by other users via Firestore rules.
- Calls are billed to the teacher's own OpenAI account, not to the app.
- These calls do **not** touch Firestore — zero quota impact beyond the
  one-time key fetch when the AI panel opens.

A future iteration should proxy through a Cloud Function so the key never
leaves the server.

## Firestore quota safety

The app runs on the Spark (free) plan: **50,000 reads / 20,000 writes per
day**. Every Firestore access in the app goes through wrappers in
`src/lib/quota-guard.ts` so reads and writes are counted approximately
per browser session.

### Soft thresholds (tunable in `quota-guard.ts`)

Per-session budget = `daily_limit / sessions_per_day / users_per_session`.
With defaults (4 sessions/day, 15 users/session):

- Reads budget ≈ **833 / session / user**
- Writes budget ≈ **333 / session / user**
- **WARN** at 60 % → single dismissible toast.
- **CRITICAL** at 85 % → persistent banner; polling features pause until reload.

### Worst-case estimate per live session

- Live board sync: `15 users × (60 / 8s) × 40 min ≈ 4,500 reads / session`.
- Live session subscription (onSnapshot): 1 read / change / connected client —
  the **single biggest risk**; we keep this scope narrow and rely on polling
  for the canvas itself.
- Saves: debounced @ 600 ms while editing; in practice ≤ 1 write / second
  per active editor.

### Caveats

The counters reset on every page reload and only see traffic from the
current browser session. They are **not** the authoritative Firebase
billing number — they cannot observe Console browsing, other devices, or
other projects on the same account. A persistent shared daily counter
would itself cost reads/writes to maintain, defeating the purpose.

The only `onSnapshot` outside Firestore is the presence system
(`src/lib/presence.ts`, Realtime Database), which is on a separate quota
and is intentionally kept lightweight.

## External board payload storage

To stay under the Firebase Spark plan's **1GB Firestore storage cap**,
solo/draft canvas boards (`Project.mode === "solo"`) offload their bulky
JSON payload to an external HTTP API
(`https://demo.unityenergetics.org/unity-map-api`). Firestore keeps only
lightweight metadata: `{ payloadRef, payloadUrl, payloadSize, ... }`.
Live session boards are NOT affected — they continue to use a single
inline Firestore snapshot (see `src/lib/canvas/storage.ts` comment).

The API is authenticated with a single Bearer token configured via
`VITE_BOARD_STORAGE_TOKEN`. Implications:

- The token is embedded in the client bundle and is **visible** in any
  user's DevTools network tab.
- The token is **shared across all users** of the app (not per-user).
  Anyone who extracts it can save / load / delete **any** board payload
  on the external server.
- A leaked token does **NOT** grant access to Firestore data, Firebase
  Auth, or any teacher's OpenAI key — those live on separate,
  properly-scoped credentials.
- Server-side never logs the token; client-side scrubs `Authorization`
  headers and `Bearer ...` substrings from any error surfaced to toast
  or console.

This is an accepted tradeoff to avoid requiring Firebase Blaze (Cloud
Functions) for a server-side proxy. A future iteration should put the
external API behind a proxy that mints short-lived, per-user tokens.


## Reporting a security issue

Please open a private report rather than a public GitHub issue.

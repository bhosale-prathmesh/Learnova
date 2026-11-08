# Learnova - Database Access Module

Implements the **Revised Blueprint** (numeric data-type registry, single gateway, services, Firestore Rules as the security authority).

```
database/
├── access-control.js            single frontend gateway (handleAppRequest)
├── access-datatype.js           numeric IDs <-> backend keys + frontend/backend mapper
├── confirmation-manager.js      normalized UI feedback states
├── errors.js                    shared error contract (the only file beyond the blueprint tree)
├── authentication/              authentication-manager.js, session-manager.js
├── cache/runtime-cache.js       TTL + per-UID cache
├── firebase/firebase-config.js  SDK init (config left BLANK), pinned SDK 12.19.0
└── services/                    levels-, progress-, users-service.js
firestore.rules                  deployed to Firebase (not bundled into the browser)
tests/                           unit + integration (fake Firebase) + rules (emulator)
```

## 1. Fill in the config (when you have it)

Either edit the blank object in `database/firebase/firebase-config.js`
(`apiKey, authDomain, projectId, appId` are required; others optional), **or** call once at app start,
before any request:

```js
import { configureFirebase } from "./database/firebase/firebase-config.js";
configureFirebase({ apiKey: "...", authDomain: "...", projectId: "...", appId: "..." });
```

Until it is filled, every call returns a normal `{ ok:false, error:{ code:"CONFIG_MISSING" } }` (nothing crashes on import).
Using a bundler instead of the CDN? Change only the three `import ... from "https://www.gstatic.com/..."` lines in
`firebase-config.js` to `"firebase/app" | "firebase/auth" | "firebase/firestore"`.

## 2. Use it from the UI

```js
import { handleAppRequest, ACTION } from "./database/access-control.js";
import { confirmationManager } from "./database/confirmation-manager.js";
import { signInWithEmail, signOutUser } from "./database/authentication/authentication-manager.js";

confirmationManager.subscribe(({ action, state, message, retryable }) => { /* render toast/spinner */ });

const r = await handleAppRequest(ACTION.UPDATE_PROGRESS, {
  progressData: { completedLevels: [1], currentScore: 20, dayStreak: 1 },   // no userId, no role
});
// r = { ok:true, data } | { ok:false, error:{ code, message, retryable } }   (never throws)
```

| Action | Payload | Result `data` |
|---|---|---|
| `FETCH_LEVELS` | `{ courseId }` | `{ course:{id,title}, levels:[{id,order,title,content}] }` |
| `GET_PROGRESS` | none | `{ userId, completedLevels, currentScore, dayStreak, updatedAt }` |
| `UPDATE_PROGRESS` | `{ progressData }` | merged progress model |
| `GET_PROFILE` | none | `{ id, fullName, emailAddress, createdAt, updatedAt }` or `null` |
| `ENSURE_PROFILE` | none | profile (creates a minimal one on first sign-in) |
| `UPDATE_PROFILE` | `{ profileData:{ fullName } }` | profile |

Error codes: `UNAUTHENTICATED, INVALID_ARGUMENT, INVALID_ACTION, UNKNOWN_DATA_TYPE, PERMISSION_DENIED, NOT_FOUND, NETWORK, AUTH_CANCELLED, AUTH_FAILED, CONFIG_MISSING, INTERNAL`.

## 3. Backend schema this build assumes  (CHECK against your real Firestore)

The blueprint says to use your exact existing keys but does not list them, so I used the schema from the original blueprint.
**If your real names differ, change only the strings in `BACKEND_KEY_BY_ID` (`access-datatype.js`) and the matching names in `firestore.rules`.**

```
users/{uid}                          uid, display_name, email_id?, created_at, updated_at
user_progress/{uid}                  user_id, levels_passed[], total_score, streak_count, updated_at
courses/{courseId}                   title, published
courses/{courseId}/levels/{levelId}  title, order, content{}
```

Registry IDs 0-17 are locked by `tests/unit/registry.test.js`; add new types by appending IDs only.

## 4. Decisions I made where the blueprint left things open (all easy to change)

- Content (courses/levels) is readable by **signed-in users only**; never writable from the client.
- `levels` live in a subcollection; a course is visible only when `published == true`.
- Progress merge policy: `completedLevels` = union, `currentScore` = max(stored, new), `dayStreak` = new value. Rules enforce the same "no regression" transitions.
- Payloads carry **no identity**: an unexpected field (`userId`, `role`, ...) is rejected with `INVALID_ARGUMENT`, not silently dropped.
- `ENSURE_PROFILE` was added as a 6th action (original blueprint's "first sign-in creates a profile").
- No stale-on-error cache fallback: network failure returns a retryable `NETWORK` error.
- Limits (mirrored in `PROGRESS_LIMITS` and `firestore.rules`): score <= 10,000,000, streak <= 36,500, <= 500 completed levels, display name 1-80 chars.

## 5. Tests and what was actually verified

```
npm install
npm test            # 169 tests, no network/emulator needed  -> PASSED when this was built
npm run test:rules  # 57 Firestore-rules tests against the emulator (needs Java 11+)
firebase deploy --only firestore:rules   # when you are ready
```

- `npm test` runs the **real module code** against an in-memory fake of the Firebase SDK: gateway, mapper, registry, cache TTL/isolation, sign-out/account-switch, error normalization, tampered payloads, permission/network failures, idempotent retries, plus source-level guards for the "definition of done" (no `access-rules.js`, no role/admin code, no backend-key literals outside the registry, SDK imported only in `firebase-config.js`). Mutation-checked: deliberately injected bugs (no TTL, accepted `userId`, hardcoded key, no cache clear on sign-out) were all caught.
- **NOT executed in the build environment:** `npm run test:rules`. The Firestore emulator could not be downloaded there, so `firestore.rules` has been reviewed but **never run**. Run `npm run test:rules` once before deploying. The fake Firestore does not evaluate rules; a "rules-mirror" check in the integration tests only confirms the module's writes have the shape the rules expect.
- Not exercised against real Firebase: the CDN URLs (`firebasejs/12.19.0/...` - check they load, or use npm imports), real Auth flows, and concurrent-write behavior (transactions are used, but Firestore's retry logic was not simulated).

## 6. Known limitations

- Rules cannot iterate a list, so the **element types** of `levels_passed` are validated by the mapper but not by the rules (it only affects the owner's own document).
- A client can still self-report a score within bounds; the rules only stop regressions and out-of-range values. Real anti-cheat needs a trusted backend (Cloud Function) - outside this module by design.
- Content authoring and any privileged operation must run server-side (Admin SDK); there is intentionally no admin path in this module.<img width="1901" height="902" alt="image" src="https://github.com/user-attachments/assets/2db26a6e-5b5a-4580-aedb-3b5122005efe" />

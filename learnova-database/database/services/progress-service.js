// database/services/progress-service.js
// Read/write learning progress for the CURRENTLY AUTHENTICATED user only.
//
// - No userId parameter exists: the UID comes from the session (Firebase Auth).
// - First write creates the document; later writes patch it. Both happen inside one
//   transaction, so a concurrent write from another tab cannot be silently lost.
// - Merge policy (matches the "no regression" transitions enforced by firestore.rules):
//     completedLevels -> union with what is stored
//     currentScore    -> max(stored, submitted)
//     dayStreak       -> submitted value
// - updated_at is a server timestamp. Retrying the same patch is idempotent (no increments).
// - Cache: invalidated after every write attempt (success or failure); nothing is cached
//   as "saved" before Firestore confirms.

import { getFirebaseDb, sdk } from "../firebase/firebase-config.js";
import { requireUid, isStillCurrent } from "../authentication/session-manager.js";
import { runtimeCache, CACHE_TTL_MS } from "../cache/runtime-cache.js";
import {
  DATA_TYPE,
  PROGRESS_LIMITS,
  getProgressKeys,
  toBackendProgressPatch,
  fromBackendProgress,
  initialProgressModel,
} from "../access-datatype.js";
import { AppError, ERROR_CODE, normalizeError } from "../errors.js";

const scopeFor = (uid) => ({ uid, typeId: DATA_TYPE.USER_PROGRESS, scope: "self" });

function progressRef(db, uid) {
  return sdk.doc(db, getProgressKeys().collection, uid);
}

export async function getProgress() {
  const uid = requireUid();
  const scope = scopeFor(uid);
  const cached = runtimeCache.get(scope);
  if (cached.hit) return cached.value;

  try {
    const snap = await sdk.getDoc(progressRef(getFirebaseDb(), uid));
    const model = snap.exists() ? fromBackendProgress(uid, snap.data()) : initialProgressModel(uid);
    if (isStillCurrent(uid)) runtimeCache.set(scope, model, CACHE_TTL_MS.PROGRESS);
    return model;
  } catch (err) {
    throw normalizeError(err);
  }
}

function mergeIntoExisting(raw, patch, K) {
  const update = {};
  if (Object.hasOwn(patch, K.levels)) {
    const stored = Array.isArray(raw[K.levels]) ? raw[K.levels].filter(Number.isInteger) : [];
    const merged = [...new Set([...stored, ...patch[K.levels]])].sort((a, b) => a - b);
    if (merged.length > PROGRESS_LIMITS.MAX_LEVELS_PASSED) {
      throw new AppError(ERROR_CODE.INVALID_ARGUMENT, "Too many completed levels.");
    }
    update[K.levels] = merged;
  }
  if (Object.hasOwn(patch, K.score)) {
    const stored = Number.isInteger(raw[K.score]) ? raw[K.score] : 0;
    update[K.score] = Math.max(stored, patch[K.score]);
  }
  if (Object.hasOwn(patch, K.streak)) update[K.streak] = patch[K.streak];
  return update;
}

/** @param {{completedLevels?:number[], currentScore?:number, dayStreak?:number}} frontendPatch */
export async function updateProgress(frontendPatch) {
  const uid = requireUid();
  const K = getProgressKeys();
  const patch = toBackendProgressPatch(frontendPatch); // validates + whitelists; throws on bad input
  const scope = scopeFor(uid);

  try {
    const db = getFirebaseDb();
    const ref = progressRef(db, uid);
    let resultRaw;

    await sdk.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        resultRaw = {
          [K.levels]: [],
          [K.score]: 0,
          [K.streak]: 0,
          ...patch,
        };
        tx.set(ref, { [K.userId]: uid, ...resultRaw, [K.updatedAt]: sdk.serverTimestamp() });
      } else {
        const raw = snap.data();
        const update = mergeIntoExisting(raw, patch, K);
        resultRaw = { ...raw, ...update };
        tx.update(ref, { ...update, [K.updatedAt]: sdk.serverTimestamp() });
      }
    });

    runtimeCache.invalidate(scope);
    return { ...fromBackendProgress(uid, { ...resultRaw, [K.updatedAt]: null }) };
  } catch (err) {
    runtimeCache.invalidate(scope); // never leave a possibly stale value after a failed write
    throw normalizeError(err);
  }
}

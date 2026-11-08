// database/services/users-service.js
// Profile lifecycle for the CURRENTLY AUTHENTICATED user only (users/{uid}).
//
// - The client may only ever change the display name (frontend field: fullName).
// - uid / email / timestamps are written only at creation (uid from Auth, email from the Auth
//   token) and are never accepted from the caller. Privilege fields are not part of this module.
// - Firestore Rules independently enforce ownership and the allowed field set.

import { getFirebaseDb, sdk } from "../firebase/firebase-config.js";
import { requireUid, isStillCurrent, getAuthHints } from "../authentication/session-manager.js";
import { runtimeCache, CACHE_TTL_MS } from "../cache/runtime-cache.js";
import {
  DATA_TYPE,
  PROFILE_LIMITS,
  getProfileKeys,
  toBackendProfilePatch,
  fromBackendProfile,
} from "../access-datatype.js";
import { normalizeError } from "../errors.js";

const DEFAULT_DISPLAY_NAME = "Learner";
const scopeFor = (uid) => ({ uid, typeId: DATA_TYPE.USER_PROFILE, scope: "self" });
const profileRef = (db, uid) => sdk.doc(db, getProfileKeys().collection, uid);

function seedName() {
  const { displayName, email } = getAuthHints();
  const candidate = (displayName || (email ? email.split("@")[0] : "") || "").trim();
  const name = candidate.slice(0, PROFILE_LIMITS.NAME_MAX);
  return name.length >= PROFILE_LIMITS.NAME_MIN ? name : DEFAULT_DISPLAY_NAME;
}

function buildCreateDoc(uid, name) {
  const K = getProfileKeys();
  const { email } = getAuthHints();
  const doc = {
    [K.uid]: uid,
    [K.name]: name,
    [K.createdAt]: sdk.serverTimestamp(),
    [K.updatedAt]: sdk.serverTimestamp(),
  };
  if (email) doc[K.email] = email;
  return doc;
}

/** Returns the profile model, or null if the user has no profile document yet. */
export async function getProfile() {
  const uid = requireUid();
  const scope = scopeFor(uid);
  const cached = runtimeCache.get(scope);
  if (cached.hit) return cached.value;

  try {
    const snap = await sdk.getDoc(profileRef(getFirebaseDb(), uid));
    const model = snap.exists() ? fromBackendProfile(uid, snap.data()) : null;
    if (isStillCurrent(uid)) runtimeCache.set(scope, model, CACHE_TTL_MS.PROFILE);
    return model;
  } catch (err) {
    throw normalizeError(err);
  }
}

/** First sign-in: create a minimal profile if missing. Idempotent; never overwrites. */
export async function ensureProfile() {
  const uid = requireUid();
  const K = getProfileKeys();
  const scope = scopeFor(uid);
  try {
    const db = getFirebaseDb();
    const ref = profileRef(db, uid);
    let raw;
    let created = false;
    await sdk.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists()) {
        raw = snap.data();
        created = false;
      } else {
        const name = seedName();
        tx.set(ref, buildCreateDoc(uid, name));
        raw = { [K.uid]: uid, [K.name]: name, [K.email]: getAuthHints().email ?? undefined };
        created = true;
      }
    });
    if (created) runtimeCache.invalidate(scope);
    return fromBackendProfile(uid, raw);
  } catch (err) {
    runtimeCache.invalidate(scope);
    throw normalizeError(err);
  }
}

/** @param {{fullName: string}} frontendPatch */
export async function updateProfile(frontendPatch) {
  const uid = requireUid();
  const K = getProfileKeys();
  const patch = toBackendProfilePatch(frontendPatch); // only the display name survives
  const scope = scopeFor(uid);
  try {
    const db = getFirebaseDb();
    const ref = profileRef(db, uid);
    let raw;
    await sdk.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        raw = { [K.uid]: uid, ...patch, [K.email]: getAuthHints().email ?? undefined };
        tx.set(ref, buildCreateDoc(uid, patch[K.name]));
      } else {
        raw = { ...snap.data(), ...patch };
        tx.update(ref, { ...patch, [K.updatedAt]: sdk.serverTimestamp() });
      }
    });
    runtimeCache.invalidate(scope);
    return fromBackendProfile(uid, raw);
  } catch (err) {
    runtimeCache.invalidate(scope);
    throw normalizeError(err);
  }
}

// database/authentication/session-manager.js
// Exposes the current authenticated identity + readiness to the gateway/services.
//
// - UID always comes from Firebase Auth's currentUser, never from a UI payload.
// - NOT an authorization authority: Firestore Rules verify every request independently.
// - When the signed-in UID changes (sign-out, account switch, token revoked in another
//   tab), the previous user's cache entries are dropped.

import { onAuthChange, getCurrentFirebaseUser } from "./authentication-manager.js";
import { runtimeCache } from "../cache/runtime-cache.js";
import { AppError, ERROR_CODE, normalizeError } from "../errors.js";

export const SESSION_STATUS = Object.freeze({
  LOADING: "loading",
  AUTHENTICATED: "authenticated",
  UNAUTHENTICATED: "unauthenticated",
});

const READY_TIMEOUT_MS = 10000;

let state = { status: SESSION_STATUS.LOADING, uid: null };
let started = false;
let stopListening = null;
let readyPromise = null;
const listeners = new Set();

function start() {
  if (started) return readyPromise;
  let resolveReady;
  const pending = new Promise((resolve) => (resolveReady = resolve));
  try {
    stopListening = onAuthChange((user) => {
      const previousUid = state.uid;
      const uid = user?.uid ?? null;
      if (previousUid && previousUid !== uid) runtimeCache.invalidateUser(previousUid);
      state = { status: uid ? SESSION_STATUS.AUTHENTICATED : SESSION_STATUS.UNAUTHENTICATED, uid };
      resolveReady();
      for (const fn of [...listeners]) {
        try {
          fn({ ...state });
        } catch {
          /* a listener must never break the session */
        }
      }
    });
  } catch (err) {
    throw normalizeError(err); // e.g. CONFIG_MISSING; `started` stays false so a later call can retry
  }
  started = true;
  readyPromise = pending;
  return readyPromise;
}

/** Resolves once Firebase Auth has reported its first state. Rejects NETWORK on timeout. */
export async function whenReady({ timeoutMs = READY_TIMEOUT_MS } = {}) {
  const ready = start();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new AppError(ERROR_CODE.NETWORK, "Could not confirm your sign-in state.", { retryable: true })),
      timeoutMs
    );
  });
  try {
    await Promise.race([ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
  return getSession();
}

export function getSession() {
  return { ...state };
}

export function isAuthenticated() {
  return state.status === SESSION_STATUS.AUTHENTICATED && getCurrentFirebaseUser() !== null;
}

/** The authenticated UID, taken from Firebase Auth at call time. Throws UNAUTHENTICATED otherwise. */
export function requireUid() {
  const user = getCurrentFirebaseUser();
  if (!user || typeof user.uid !== "string" || user.uid === "") {
    throw new AppError(ERROR_CODE.UNAUTHENTICATED);
  }
  return user.uid;
}

/** True if `uid` is still the signed-in user (guards cache writes after a sign-out mid-request). */
export function isStillCurrent(uid) {
  return getCurrentFirebaseUser()?.uid === uid;
}

/** Non-authoritative hints from the Auth profile, used only to seed a first profile document. */
export function getAuthHints() {
  const user = getCurrentFirebaseUser();
  return { displayName: user?.displayName ?? null, email: user?.email ?? null };
}

export function subscribeSession(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Stop listening and reset (hot reload / tests). */
export function destroySession() {
  if (stopListening) stopListening();
  stopListening = null;
  started = false;
  readyPromise = null;
  listeners.clear();
  state = { status: SESSION_STATUS.LOADING, uid: null };
}

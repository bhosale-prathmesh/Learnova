// database/authentication/authentication-manager.js
// Thin wrapper over Firebase Auth: sign-in, sign-out, auth-state listener, current user.
// The Firebase SDK refreshes ID tokens by itself. This file never grants privileges
// and never reads a role from client-editable data.

import { getFirebaseAuth, sdk } from "../firebase/firebase-config.js";
import { runtimeCache } from "../cache/runtime-cache.js";
import { AppError, ERROR_CODE, normalizeError } from "../errors.js";

const publicUser = (u) => (u ? { uid: u.uid, email: u.email ?? null, displayName: u.displayName ?? null } : null);

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(ERROR_CODE.INVALID_ARGUMENT, `${label} is required.`);
  }
  return value;
}

export async function signInWithEmail(email, password) {
  try {
    requireText(email, "Email");
    requireText(password, "Password");
    const cred = await sdk.signInWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
    return publicUser(cred.user);
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function registerWithEmail(email, password) {
  try {
    requireText(email, "Email");
    requireText(password, "Password");
    const cred = await sdk.createUserWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
    return publicUser(cred.user);
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function signInWithGoogle() {
  try {
    const cred = await sdk.signInWithPopup(getFirebaseAuth(), new sdk.GoogleAuthProvider());
    return publicUser(cred.user);
  } catch (err) {
    throw normalizeError(err); // popup closed -> AUTH_CANCELLED, not a raw SDK exception
  }
}

/** Sign out, then drop everything cached for that user. */
export async function signOutUser() {
  try {
    const auth = getFirebaseAuth();
    const uid = auth.currentUser?.uid ?? null;
    await sdk.signOut(auth);
    if (uid) runtimeCache.invalidateUser(uid);
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Subscribe to auth changes. Callback receives {uid,email,displayName} | null. Returns unsubscribe. */
export function onAuthChange(callback) {
  return sdk.onAuthStateChanged(getFirebaseAuth(), (user) => callback(publicUser(user)));
}

/** Current Firebase user (raw SDK user, or null). Used by the session manager only. */
export function getCurrentFirebaseUser() {
  return getFirebaseAuth().currentUser ?? null;
}

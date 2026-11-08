// Test double for firebase-auth.js: in-memory users + auth state listeners.
let currentUser = null;
const listeners = new Set();
const accounts = new Map(); // email -> { uid, password, displayName }
let holdInitial = false;
let popupResult = null;     // set by tests: user object or { code } to throw

const authInstance = { get currentUser() { return currentUser; } };

function emit() { for (const l of [...listeners]) l(currentUser); }
const toUser = (email, a) => ({ uid: a.uid, email, displayName: a.displayName ?? null });

export const getAuth = () => authInstance;
export function onAuthStateChanged(_auth, cb) {
  listeners.add(cb);
  if (!holdInitial) queueMicrotask(() => { if (listeners.has(cb)) cb(currentUser); }); // SDK reports initial state once
  return () => listeners.delete(cb);
}
export async function signInWithEmailAndPassword(_auth, email, password) {
  const a = accounts.get(email);
  if (!a || a.password !== password) throw Object.assign(new Error("bad creds"), { code: "auth/invalid-credential" });
  currentUser = toUser(email, a); emit();
  return { user: currentUser };
}
export async function createUserWithEmailAndPassword(_auth, email, password) {
  if (accounts.has(email)) throw Object.assign(new Error("dup"), { code: "auth/email-already-in-use" });
  if (password.length < 6) throw Object.assign(new Error("weak"), { code: "auth/weak-password" });
  const a = { uid: `uid_${accounts.size + 1}`, password };
  accounts.set(email, a);
  currentUser = toUser(email, a); emit();
  return { user: currentUser };
}
export class GoogleAuthProvider {}
export async function signInWithPopup() {
  if (popupResult && popupResult.code) throw Object.assign(new Error("popup"), { code: popupResult.code });
  currentUser = popupResult; emit();
  return { user: currentUser };
}
export async function signOut() { currentUser = null; emit(); }

// ---- test helpers ----
export const __addAccount = (email, password, uid, displayName) => accounts.set(email, { uid, password, displayName });
export const __setUser = (u) => { currentUser = u; emit(); };      // simulate login/logout/switch
export const __setPopupResult = (r) => { popupResult = r; };
export const __holdInitial = (v) => { holdInitial = v; };
export const __listenerCount = () => listeners.size;
export const __reset = () => { currentUser = null; listeners.clear(); accounts.clear(); popupResult = null; holdInitial = false; };

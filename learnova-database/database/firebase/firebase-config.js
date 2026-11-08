// database/firebase/firebase-config.js
// Initializes the Firebase app ONCE and exposes shared Auth / Firestore instances.
//
// This is the ONLY file in the module that imports the Firebase SDK.
// Everything else uses `sdk` (re-exported functions) and the getters below.
//
// SDK version is pinned (12.19.0). The three import URLs MUST use the same
// version - tests/unit/firebase-config.test.js enforces this.
// Using a bundler (Vite/webpack) instead of the CDN? Replace only these three
// import lines with: import {...} from "firebase/app" | "firebase/auth" | "firebase/firestore".
//
// Web config values are public identifiers (not secrets). NEVER put a service-account
// key or Admin SDK credential in browser code.

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import { AppError, ERROR_CODE } from "../errors.js";

export const FIREBASE_SDK_VERSION = "12.19.0";

// ---- FILL THESE IN LATER (left blank on purpose) ---------------------------
export const firebaseConfig = Object.freeze({
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
  measurementId: "", // optional
});
// ---------------------------------------------------------------------------

const REQUIRED_CONFIG_KEYS = Object.freeze(["apiKey", "authDomain", "projectId", "appId"]);

let activeConfig = firebaseConfig;
let authInstance = null;
let dbInstance = null;

/**
 * Optional alternative to editing the object above: supply the web config at app
 * start (e.g. injected at build time). Must be called before the first Firebase use.
 */
export function configureFirebase(config) {
  if (authInstance || dbInstance) {
    throw new AppError(ERROR_CODE.INTERNAL, "Firebase is already initialized.", { retryable: false });
  }
  activeConfig = Object.freeze({ ...firebaseConfig, ...config });
}

/** True when every required web-config value has been filled in. */
export function isFirebaseConfigured() {
  return REQUIRED_CONFIG_KEYS.every(
    (k) => typeof activeConfig[k] === "string" && activeConfig[k].trim() !== ""
  );
}

// Thin, explicit surface of the SDK that the module is allowed to use.
export const sdk = Object.freeze({
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  doc,
  collection,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
});

/** Lazy init: importing this file never throws, even with a blank config. */
export function getFirebaseApp() {
  if (!isFirebaseConfigured()) {
    throw new AppError(ERROR_CODE.CONFIG_MISSING, undefined, { retryable: false });
  }
  // getApps()/getApp() avoids duplicate-app errors if two modules initialize.
  return getApps().length ? getApp() : initializeApp({ ...activeConfig });
}

export function getFirebaseAuth() {
  if (!authInstance) authInstance = getAuth(getFirebaseApp());
  return authInstance;
}

export function getFirebaseDb() {
  if (!dbInstance) dbInstance = getFirestore(getFirebaseApp());
  return dbInstance;
}

// database/access-datatype.js
// Single frontend registry: stable numeric IDs  <->  actual backend keys,
// plus the frontend <-> backend model mapper.
//
// This file is NOT a permission system and provides NO security.
// Firestore Security Rules (firestore.rules) are the authority.
//
// Registry rules
//  - IDs are unique, stable, and never reassigned to a different meaning.
//  - New data types are APPENDED with a new ID. Never renumber.
//  - Code elsewhere uses the named constants (DATA_TYPE.X), never raw numbers.
//  - Unknown ID -> fail closed with UNKNOWN_DATA_TYPE.
//  - The key strings below are the Learnova backend keys (see README "Backend schema").
//    If a backend key is renamed, change ONLY its string here (+ firestore.rules).

import { AppError, ERROR_CODE } from "./errors.js";

export const DATA_TYPE = Object.freeze({
  USER_NAME: 0,
  USER_PROGRESS: 1,
  LEVEL_DATA: 2,
  USER_PROFILE: 3,
  COURSE_DATA: 4,
  USER_EMAIL: 5,
  USER_UID: 6,
  PROGRESS_USER_ID: 7,
  PROGRESS_LEVELS_PASSED: 8,
  PROGRESS_TOTAL_SCORE: 9,
  PROGRESS_STREAK: 10,
  UPDATED_AT: 11,
  CREATED_AT: 12,
  LEVEL_TITLE: 13,
  LEVEL_ORDER: 14,
  LEVEL_CONTENT: 15,
  COURSE_TITLE: 16,
  COURSE_PUBLISHED: 17,
});

const BACKEND_KEY_BY_ID = Object.freeze({
  [DATA_TYPE.USER_NAME]: "display_name", // field in users/{uid}
  [DATA_TYPE.USER_PROGRESS]: "user_progress", // collection: user_progress/{uid}
  [DATA_TYPE.LEVEL_DATA]: "levels", // subcollection: courses/{courseId}/levels/{levelId}
  [DATA_TYPE.USER_PROFILE]: "users", // collection: users/{uid}
  [DATA_TYPE.COURSE_DATA]: "courses", // collection: courses/{courseId}
  [DATA_TYPE.USER_EMAIL]: "email_id",
  [DATA_TYPE.USER_UID]: "uid",
  [DATA_TYPE.PROGRESS_USER_ID]: "user_id",
  [DATA_TYPE.PROGRESS_LEVELS_PASSED]: "levels_passed",
  [DATA_TYPE.PROGRESS_TOTAL_SCORE]: "total_score",
  [DATA_TYPE.PROGRESS_STREAK]: "streak_count",
  [DATA_TYPE.UPDATED_AT]: "updated_at",
  [DATA_TYPE.CREATED_AT]: "created_at",
  [DATA_TYPE.LEVEL_TITLE]: "title",
  [DATA_TYPE.LEVEL_ORDER]: "order",
  [DATA_TYPE.LEVEL_CONTENT]: "content",
  [DATA_TYPE.COURSE_TITLE]: "title",
  [DATA_TYPE.COURSE_PUBLISHED]: "published",
});

// Fail fast at load time if the two tables ever drift apart or IDs collide.
(function assertRegistryIntegrity() {
  const ids = Object.values(DATA_TYPE);
  if (new Set(ids).size !== ids.length) throw new Error("DATA_TYPE has duplicate IDs");
  for (const id of ids) {
    if (typeof BACKEND_KEY_BY_ID[id] !== "string" || BACKEND_KEY_BY_ID[id] === "") {
      throw new Error(`DATA_TYPE ${id} has no backend key`);
    }
  }
  if (Object.keys(BACKEND_KEY_BY_ID).length !== ids.length) {
    throw new Error("Registry has keys without a DATA_TYPE constant");
  }
})();

/** Resolve a numeric type ID to the exact backend key. Unknown ID -> UNKNOWN_DATA_TYPE. */
export function getBackendKey(typeId) {
  if (
    typeof typeId !== "number" ||
    !Number.isInteger(typeId) ||
    !Object.hasOwn(BACKEND_KEY_BY_ID, typeId)
  ) {
    throw new AppError(ERROR_CODE.UNKNOWN_DATA_TYPE);
  }
  return BACKEND_KEY_BY_ID[typeId];
}

/** Read-only listing (id, constant name, backend key) - used by registry tests/docs. */
export function listDataTypes() {
  return Object.entries(DATA_TYPE).map(([name, id]) => ({ id, name, key: BACKEND_KEY_BY_ID[id] }));
}

// ---------------------------------------------------------------------------
// Limits. These MUST match the validation constants in firestore.rules.
// ---------------------------------------------------------------------------
export const PROGRESS_LIMITS = Object.freeze({
  MAX_LEVELS_PASSED: 500,
  MAX_LEVEL_ID: 100000,
  MAX_SCORE: 10000000,
  MAX_STREAK: 36500,
});
export const PROFILE_LIMITS = Object.freeze({ NAME_MIN: 1, NAME_MAX: 80 });

// ---------------------------------------------------------------------------
// Resolved key groups (so services never write a backend key literal)
// ---------------------------------------------------------------------------
export function getProfileKeys() {
  return Object.freeze({
    collection: getBackendKey(DATA_TYPE.USER_PROFILE),
    uid: getBackendKey(DATA_TYPE.USER_UID),
    name: getBackendKey(DATA_TYPE.USER_NAME),
    email: getBackendKey(DATA_TYPE.USER_EMAIL),
    createdAt: getBackendKey(DATA_TYPE.CREATED_AT),
    updatedAt: getBackendKey(DATA_TYPE.UPDATED_AT),
  });
}

export function getProgressKeys() {
  return Object.freeze({
    collection: getBackendKey(DATA_TYPE.USER_PROGRESS),
    userId: getBackendKey(DATA_TYPE.PROGRESS_USER_ID),
    levels: getBackendKey(DATA_TYPE.PROGRESS_LEVELS_PASSED),
    score: getBackendKey(DATA_TYPE.PROGRESS_TOTAL_SCORE),
    streak: getBackendKey(DATA_TYPE.PROGRESS_STREAK),
    updatedAt: getBackendKey(DATA_TYPE.UPDATED_AT),
  });
}

export function getContentKeys() {
  return Object.freeze({
    courses: getBackendKey(DATA_TYPE.COURSE_DATA),
    levels: getBackendKey(DATA_TYPE.LEVEL_DATA),
    courseTitle: getBackendKey(DATA_TYPE.COURSE_TITLE),
    published: getBackendKey(DATA_TYPE.COURSE_PUBLISHED),
    levelTitle: getBackendKey(DATA_TYPE.LEVEL_TITLE),
    levelOrder: getBackendKey(DATA_TYPE.LEVEL_ORDER),
    levelContent: getBackendKey(DATA_TYPE.LEVEL_CONTENT),
  });
}

// ---------------------------------------------------------------------------
// Validation helpers (explicit rejection, never silent pass-through)
// ---------------------------------------------------------------------------
const invalid = (message) => new AppError(ERROR_CODE.INVALID_ARGUMENT, message);
const corrupt = () => new AppError(ERROR_CODE.INTERNAL, "Stored data has an unexpected format.");

export function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function assertAllowedKeys(obj, allowed, label) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw invalid(`${label}: field "${k}" is not allowed.`);
  }
}

function assertIntInRange(v, min, max, label) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw invalid(`${label} must be a whole number between ${min} and ${max}.`);
  }
}

const DOC_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
export function normalizeDocId(value, label = "id") {
  if (typeof value !== "string" || !DOC_ID_RE.test(value)) {
    throw invalid(`${label} is not valid.`);
  }
  return value;
}

/** Firestore Timestamp | number | null  ->  epoch millis | null */
export function timestampToMillis(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object" && typeof v.toMillis === "function") return v.toMillis();
  throw corrupt();
}

// ---------------------------------------------------------------------------
// Progress mapper
// frontend: { completedLevels:number[], currentScore:number, dayStreak:number }
// backend : { levels_passed, total_score, streak_count } (+ user_id, updated_at set by service)
// ---------------------------------------------------------------------------
const PROGRESS_PATCH_FIELDS = ["completedLevels", "currentScore", "dayStreak"];

/** Validate + translate a frontend progress patch into backend keys. Returns ONLY provided fields. */
export function toBackendProgressPatch(patch) {
  if (!isPlainObject(patch)) throw invalid("Progress data must be an object.");
  assertAllowedKeys(patch, PROGRESS_PATCH_FIELDS, "Progress");
  const L = PROGRESS_LIMITS;
  const K = getProgressKeys();
  const out = {};

  if (Object.hasOwn(patch, "completedLevels")) {
    const lv = patch.completedLevels;
    if (!Array.isArray(lv) || lv.length > L.MAX_LEVELS_PASSED) {
      throw invalid(`completedLevels must be a list of at most ${L.MAX_LEVELS_PASSED} level numbers.`);
    }
    lv.forEach((n) => assertIntInRange(n, 0, L.MAX_LEVEL_ID, "Each completed level"));
    out[K.levels] = [...new Set(lv)].sort((a, b) => a - b);
  }
  if (Object.hasOwn(patch, "currentScore")) {
    assertIntInRange(patch.currentScore, 0, L.MAX_SCORE, "currentScore");
    out[K.score] = patch.currentScore;
  }
  if (Object.hasOwn(patch, "dayStreak")) {
    assertIntInRange(patch.dayStreak, 0, L.MAX_STREAK, "dayStreak");
    out[K.streak] = patch.dayStreak;
  }
  if (Object.keys(out).length === 0) throw invalid("Progress data is empty.");
  return out;
}

export function initialProgressModel(uid) {
  return { userId: uid, completedLevels: [], currentScore: 0, dayStreak: 0, updatedAt: null };
}

/** Backend progress doc -> frontend model. Absent fields get defaults; wrong types are rejected. */
export function fromBackendProgress(uid, data) {
  if (!isPlainObject(data)) throw corrupt();
  const K = getProgressKeys();
  const readInt = (key, fallback) => {
    if (data[key] === undefined) return fallback;
    if (typeof data[key] !== "number" || !Number.isInteger(data[key])) throw corrupt();
    return data[key];
  };
  let levels = [];
  if (data[K.levels] !== undefined) {
    if (!Array.isArray(data[K.levels]) || !data[K.levels].every(Number.isInteger)) throw corrupt();
    levels = [...data[K.levels]];
  }
  return {
    userId: uid, // identity comes from the document path / auth, never from stored payload
    completedLevels: levels,
    currentScore: readInt(K.score, 0),
    dayStreak: readInt(K.streak, 0),
    updatedAt: timestampToMillis(data[K.updatedAt]),
  };
}

// ---------------------------------------------------------------------------
// Profile mapper
// frontend: { id, fullName, emailAddress, createdAt, updatedAt }
// Client may only submit { fullName }.
// ---------------------------------------------------------------------------
export function normalizeDisplayName(value) {
  if (typeof value !== "string") throw invalid("fullName must be text.");
  const name = value.trim();
  if (name.length < PROFILE_LIMITS.NAME_MIN || name.length > PROFILE_LIMITS.NAME_MAX) {
    throw invalid(`fullName must be ${PROFILE_LIMITS.NAME_MIN}-${PROFILE_LIMITS.NAME_MAX} characters.`);
  }
  return name;
}

export function toBackendProfilePatch(patch) {
  if (!isPlainObject(patch)) throw invalid("Profile data must be an object.");
  assertAllowedKeys(patch, ["fullName"], "Profile");
  if (!Object.hasOwn(patch, "fullName")) throw invalid("Profile data is empty.");
  return { [getProfileKeys().name]: normalizeDisplayName(patch.fullName) };
}

export function fromBackendProfile(uid, data) {
  if (!isPlainObject(data)) throw corrupt();
  const K = getProfileKeys();
  if (typeof data[K.name] !== "string") throw corrupt();
  const email = data[K.email];
  if (email !== undefined && email !== null && typeof email !== "string") throw corrupt();
  return {
    id: uid,
    fullName: data[K.name],
    emailAddress: email ?? null,
    createdAt: timestampToMillis(data[K.createdAt]),
    updatedAt: timestampToMillis(data[K.updatedAt]),
  };
}

// ---------------------------------------------------------------------------
// Content mappers (read-only)
// ---------------------------------------------------------------------------
export function fromBackendCourse(id, data) {
  if (!isPlainObject(data)) throw corrupt();
  const K = getContentKeys();
  if (typeof data[K.courseTitle] !== "string") throw corrupt();
  return { id, title: data[K.courseTitle], published: data[K.published] === true };
}

export function fromBackendLevel(id, data) {
  if (!isPlainObject(data)) throw corrupt();
  const K = getContentKeys();
  if (typeof data[K.levelTitle] !== "string") throw corrupt();
  const order = data[K.levelOrder] ?? 0;
  if (typeof order !== "number" || !Number.isFinite(order)) throw corrupt();
  const content = data[K.levelContent] ?? {};
  if (!isPlainObject(content)) throw corrupt();
  return { id, order, title: data[K.levelTitle], content };
}

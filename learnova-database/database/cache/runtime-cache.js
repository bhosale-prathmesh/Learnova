// database/cache/runtime-cache.js
// Short-lived in-memory read cache. A performance layer ONLY:
// never the source of truth, never a security boundary.
//
// - Entries are scoped by (uid | null for public content) + data-type ID + scope string.
// - TTL is enforced on read: an expired entry is a miss and is deleted.
// - get() returns { hit, value } so falsy values (false, 0, "", null) are valid hits.
// - Invalidation is exact-key or per-user (strict UID equality), never substring matching.
// - Values are cloned on set/get so callers cannot mutate cached state by accident.

import { AppError, ERROR_CODE } from "../errors.js";

export const CACHE_TTL_MS = Object.freeze({
  LEVELS: 5 * 60 * 1000, // published learning content changes rarely
  PROGRESS: 30 * 1000,
  PROFILE: 60 * 1000,
});

const MAX_ENTRIES = 200;

export function createRuntimeCache({ now = () => Date.now() } = {}) {
  /** @type {Map<string, {value:any, createdAt:number, expiresAt:number, uid:string|null}>} */
  const entries = new Map();

  // JSON of a tuple => exact, collision-free key (no delimiter ambiguity).
  const keyOf = ({ uid = null, typeId, scope = "" }) => JSON.stringify([uid, typeId, scope]);

  function get(scopeDef) {
    const key = keyOf(scopeDef);
    const entry = entries.get(key);
    if (!entry) return { hit: false };
    if (now() >= entry.expiresAt) {
      entries.delete(key);
      return { hit: false };
    }
    return { hit: true, value: structuredClone(entry.value) };
  }

  function set(scopeDef, value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new AppError(ERROR_CODE.INTERNAL, "Cache TTL must be a positive number.");
    }
    const key = keyOf(scopeDef);
    const createdAt = now();
    entries.delete(key); // refresh insertion order
    entries.set(key, {
      value: structuredClone(value),
      createdAt,
      expiresAt: createdAt + ttlMs,
      uid: scopeDef.uid ?? null,
    });
    while (entries.size > MAX_ENTRIES) {
      entries.delete(entries.keys().next().value); // evict oldest
    }
  }

  /** Remove exactly one entry. */
  function invalidate(scopeDef) {
    entries.delete(keyOf(scopeDef));
  }

  /** Remove every entry that belongs to this UID (sign-out / account switch). */
  function invalidateUser(uid) {
    if (typeof uid !== "string" || uid === "") return;
    for (const [key, entry] of entries) {
      if (entry.uid === uid) entries.delete(key);
    }
  }

  function clear() {
    entries.clear();
  }

  function size() {
    return entries.size;
  }

  return Object.freeze({ get, set, invalidate, invalidateUser, clear, size });
}

export const runtimeCache = createRuntimeCache();

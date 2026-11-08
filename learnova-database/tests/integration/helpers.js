import { vi } from "vitest";

/**
 * Fresh module graph per test: new session/cache/confirmation singletons + fresh Firebase fakes.
 * The module under test is the REAL code; only the Firebase SDK (CDN URLs) is faked.
 */
export async function boot({ configured = true } = {}) {
  vi.resetModules();
  const fakes = {
    auth: await import("../fakes/firebase-auth.js"),
    fs: await import("../fakes/firebase-firestore.js"),
  };
  const config = await import("../../database/firebase/firebase-config.js");
  if (configured) config.configureFirebase({ apiKey: "k", authDomain: "d.example", projectId: "p", appId: "a" });
  const gateway = await import("../../database/access-control.js");
  const { runtimeCache } = await import("../../database/cache/runtime-cache.js");
  const { confirmationManager } = await import("../../database/confirmation-manager.js");
  const authManager = await import("../../database/authentication/authentication-manager.js");
  const session = await import("../../database/authentication/session-manager.js");
  const registry = await import("../../database/access-datatype.js");

  const states = [];
  confirmationManager.subscribe((f) => states.push(f));

  return {
    ...gateway, ...fakes, runtimeCache, confirmationManager, authManager, session, registry, config, states,
    login: (uid, extra = {}) => fakes.auth.__setUser({ uid, email: `${uid}@example.com`, displayName: null, ...extra }),
    logout: () => fakes.auth.__setUser(null),
    call: (action, payload) => gateway.handleAppRequest(action, payload),
    storeOps: () => fakes.fs.__log(),
  };
}

export const ts = (ms) => ({ toMillis: () => ms });

// Mirror of the field allowlists in firestore.rules. It checks that every write the SERVICES produce is
// shaped so the real rules can accept it (right keys, owner id, server timestamps, no protected fields).
// It is a drift alarm, NOT a substitute for tests/rules (which run the actual rules in the emulator).
export function installRulesMirror(fs, currentUid) {
  const isTs = (v) => v && typeof v === "object" && v.__sentinel === "serverTimestamp";
  const isInt = (v) => Number.isInteger(v);
  const only = (obj, allowed) => Object.keys(obj).every((k) => allowed.includes(k));
  const all = (obj, required) => required.every((k) => Object.hasOwn(obj, k));
  fs.__onWrite(({ op, path, data }) => {
    const [col, id] = path.split("/");
    if (id !== currentUid()) throw new Error(`write outside own document: ${path}`);
    if (col === "users") {
      const all5 = ["uid", "display_name", "email_id", "created_at", "updated_at"];
      if (op === "create") {
        if (!only(data, all5) || !all(data, ["uid", "display_name", "created_at", "updated_at"])) throw new Error("users create keys");
        if (data.uid !== id || !isTs(data.created_at) || !isTs(data.updated_at)) throw new Error("users create values");
        if (typeof data.display_name !== "string" || !data.display_name.length || data.display_name.length > 80) throw new Error("name");
      } else {
        if (!only(data, ["display_name", "updated_at"]) || !isTs(data.updated_at)) throw new Error("users update keys");
      }
    } else if (col === "user_progress") {
      const keys = ["user_id", "levels_passed", "total_score", "streak_count", "updated_at"];
      if (op === "create") {
        if (!only(data, keys) || !all(data, keys) || data.user_id !== id) throw new Error("progress create keys");
      } else if (!only(data, keys.slice(1)) || Object.hasOwn(data, "user_id")) {
        throw new Error("progress update keys");
      }
      if (Object.hasOwn(data, "total_score") && (!isInt(data.total_score) || data.total_score < 0 || data.total_score > 10000000)) throw new Error("score");
      if (Object.hasOwn(data, "streak_count") && (!isInt(data.streak_count) || data.streak_count < 0 || data.streak_count > 36500)) throw new Error("streak");
      if (Object.hasOwn(data, "levels_passed") && (!Array.isArray(data.levels_passed) || data.levels_passed.length > 500)) throw new Error("levels");
      if (!isTs(data.updated_at)) throw new Error("progress updated_at");
    } else {
      throw new Error(`client wrote to unexpected collection: ${path}`);
    }
  });
}

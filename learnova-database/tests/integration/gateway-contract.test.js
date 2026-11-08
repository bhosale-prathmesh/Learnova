import { describe, it, expect } from "vitest";
import { boot } from "./helpers.js";

describe("gateway: contract, validation, auth gating", () => {
  it("blank config -> normalized CONFIG_MISSING, never throws", async () => {
    const t = await boot({ configured: false });
    const r = await t.call(t.ACTION.GET_PROGRESS);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "CONFIG_MISSING", retryable: false }) });
    expect(t.config.isFirebaseConfigured()).toBe(false);
  });

  it.each([["NOPE"], ["constructor"], ["__proto__"], ["toString"], [""], [undefined], [null], [42], [{}]])(
    "unsupported action %j -> INVALID_ACTION",
    async (action) => {
      const t = await boot();
      t.login("u1");
      const r = await t.call(action);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("INVALID_ACTION");
      expect(t.storeOps()).toEqual([]);
    }
  );

  it("a client content-write action does not exist (levels are read-only)", async () => {
    const t = await boot();
    t.login("u1");
    for (const a of ["UPDATE_LEVELS", "MANAGE_LEVELS", "DELETE_LEVEL", "SET_ROLE"]) {
      expect((await t.call(a, {})).error.code).toBe("INVALID_ACTION");
    }
  });

  it.each([
    ["GET_PROGRESS", { userId: "u2" }],
    ["GET_PROFILE", { role: "x" }],
    ["UPDATE_PROGRESS", { progressData: { currentScore: 1 }, userId: "u2" }],
    ["UPDATE_PROGRESS", {}],
    ["UPDATE_PROGRESS", { progressData: null }],
    ["UPDATE_PROFILE", {}],
    ["FETCH_LEVELS", {}],
    ["FETCH_LEVELS", { courseId: "c1", extra: 1 }],
    ["GET_PROGRESS", [1]],
    ["GET_PROGRESS", "x"],
    ["GET_PROGRESS", null],
  ])("bad payload %s %j -> INVALID_ARGUMENT, no DB access", async (action, payload) => {
    const t = await boot();
    t.login("u1");
    const r = await t.call(action, payload);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_ARGUMENT");
    expect(t.storeOps()).toEqual([]);
  });

  it("every action returns UNAUTHENTICATED when signed out, with zero DB access", async () => {
    const t = await boot();
    const calls = [
      ["FETCH_LEVELS", { courseId: "c1" }], ["GET_PROGRESS", {}], ["UPDATE_PROGRESS", { progressData: { currentScore: 1 } }],
      ["GET_PROFILE", {}], ["ENSURE_PROFILE", {}], ["UPDATE_PROFILE", { profileData: { fullName: "A" } }],
    ];
    for (const [a, p] of calls) {
      const r = await t.call(a, p);
      expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "UNAUTHENTICATED" }) });
    }
    expect(t.storeOps()).toEqual([]);
    expect(t.states.at(-1).state).toBe("auth_required");
  });

  it("waits for auth readiness: a request issued before Firebase reports state still succeeds", async () => {
    const t = await boot();
    t.login("u1"); // user restored from persistence, listener not yet started
    const r = await t.call("GET_PROGRESS");
    expect(r.ok).toBe(true);
    expect(r.data.userId).toBe("u1");
  });

  it("auth never becoming ready -> retryable NETWORK (timeout), not a hang", async () => {
    const t = await boot();
    t.auth.__holdInitial(true);
    await expect(t.session.whenReady({ timeoutMs: 20 })).rejects.toMatchObject({ code: "NETWORK", retryable: true });
  });

  it("loading state is emitted before the outcome, and results never leak raw errors", async () => {
    const t = await boot();
    t.login("u1");
    t.fs.__failNext("read", "permission-denied");
    const r = await t.call("GET_PROGRESS");
    expect(t.states.map((s) => s.state)).toEqual(["loading", "permission_denied"]);
    expect(Object.keys(r.error).sort()).toEqual(["code", "message", "retryable"]);
    expect(JSON.stringify(r)).not.toMatch(/user_progress|u1|fake/);
  });
});

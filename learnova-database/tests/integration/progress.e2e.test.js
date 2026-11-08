import { describe, it, expect } from "vitest";
import { boot, installRulesMirror } from "./helpers.js";

const FIRST = { progressData: { completedLevels: [1], currentScore: 20, dayStreak: 1 } };

async function setup(uid = "u1") {
  const t = await boot();
  installRulesMirror(t.fs, () => t.session.getSession().uid ?? uid);
  t.login(uid);
  return t;
}
const gets = (t, path) => t.storeOps().filter((o) => o.op === "get" && o.path === path).length;

describe("progress: end to end through the gateway", () => {
  it("GET_PROGRESS with no document returns the initial model and does not create anything", async () => {
    const t = await setup();
    const r = await t.call("GET_PROGRESS");
    expect(r).toEqual({ ok: true, data: { userId: "u1", completedLevels: [], currentScore: 0, dayStreak: 0, updatedAt: null } });
    expect(t.fs.__peek("user_progress/u1")).toBeUndefined();
    expect(t.states.at(-1).state).toBe("success");
  });

  it("first-time UPDATE_PROGRESS creates the document with the exact backend shape", async () => {
    const t = await setup();
    const r = await t.call("UPDATE_PROGRESS", FIRST);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ userId: "u1", completedLevels: [1], currentScore: 20, dayStreak: 1 });
    const stored = t.fs.__peek("user_progress/u1");
    expect(Object.keys(stored).sort()).toEqual(["levels_passed", "streak_count", "total_score", "updated_at", "user_id"]);
    expect(stored).toMatchObject({ user_id: "u1", levels_passed: [1], total_score: 20, streak_count: 1 });
    expect(typeof stored.updated_at.toMillis()).toBe("number");
    expect(t.storeOps().some((o) => o.op === "write:create")).toBe(true);
    expect(t.states.at(-1)).toMatchObject({ state: "success", message: "Progress saved." });
  });

  it("later updates patch the same document: levels union, score never regresses, streak replaced", async () => {
    const t = await setup();
    await t.call("UPDATE_PROGRESS", FIRST);
    const r = await t.call("UPDATE_PROGRESS", { progressData: { completedLevels: [2, 1], currentScore: 5, dayStreak: 0 } });
    expect(r.ok).toBe(true);
    expect(t.fs.__peek("user_progress/u1")).toMatchObject({ levels_passed: [1, 2], total_score: 20, streak_count: 0 });
    expect(t.storeOps().filter((o) => o.op === "write:update")).toHaveLength(1);
    const r2 = await t.call("UPDATE_PROGRESS", { progressData: { currentScore: 50 } });
    expect(r2.data.currentScore).toBe(50);
    expect(t.fs.__peek("user_progress/u1").levels_passed).toEqual([1, 2]); // untouched field kept
  });

  it("reads are cached; any write invalidates; the next read sees fresh data", async () => {
    const t = await setup();
    await t.call("GET_PROGRESS");
    await t.call("GET_PROGRESS");
    expect(gets(t, "user_progress/u1")).toBe(1);
    await t.call("UPDATE_PROGRESS", FIRST);
    const r = await t.call("GET_PROGRESS");
    expect(gets(t, "user_progress/u1")).toBe(2);
    expect(r.data).toMatchObject({ completedLevels: [1], currentScore: 20 });
    expect(r.data.updatedAt).toEqual(expect.any(Number));
  });

  it("cache entries expire by TTL", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = await setup();
      await t.call("GET_PROGRESS");
      vi.setSystemTime(Date.now() + 29_000);
      await t.call("GET_PROGRESS");
      expect(gets(t, "user_progress/u1")).toBe(1);
      vi.setSystemTime(Date.now() + 2_000);
      await t.call("GET_PROGRESS");
      expect(gets(t, "user_progress/u1")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("another user's UID can never be addressed: identity in payload is rejected, DB paths always use the signed-in UID", async () => {
    const t = await setup("A");
    t.fs.__seed("user_progress/B", { user_id: "B", levels_passed: [9], total_score: 999, streak_count: 9 });
    expect((await t.call("GET_PROGRESS", { userId: "B" })).error.code).toBe("INVALID_ARGUMENT");
    expect((await t.call("UPDATE_PROGRESS", { userId: "B", ...FIRST })).error.code).toBe("INVALID_ARGUMENT");
    expect((await t.call("UPDATE_PROGRESS", { progressData: { userId: "B", currentScore: 1 } })).error.code).toBe("INVALID_ARGUMENT");
    expect(t.storeOps()).toEqual([]);

    const r = await t.call("GET_PROGRESS");
    expect(r.data.currentScore).toBe(0); // A sees A's (empty) data, not B's 999
    await t.call("UPDATE_PROGRESS", FIRST);
    for (const op of t.storeOps()) expect(op.path.endsWith("/A")).toBe(true);
    expect(t.fs.__peek("user_progress/B")).toMatchObject({ total_score: 999, levels_passed: [9] });
  });

  it.each([
    ["role injection", { role: "admin", currentScore: 1 }],
    ["owner uid override", { user_id: "B", currentScore: 1 }],
    ["negative score", { currentScore: -5 }],
    ["wrong type", { currentScore: "100" }],
    ["unknown backend-style field", { total_score: 1 }],
    ["empty patch", {}],
  ])("rejects %s before any write", async (_n, progressData) => {
    const t = await setup();
    const r = await t.call("UPDATE_PROGRESS", { progressData });
    expect(r.error.code).toBe("INVALID_ARGUMENT");
    expect(t.storeOps()).toEqual([]);
    expect(t.states.at(-1).state).toBe("validation_error");
  });

  it("Firestore permission denial: normalized error, no success feedback, no write, cache invalidated", async () => {
    const t = await setup();
    await t.call("GET_PROGRESS"); // warm cache
    t.states.length = 0;
    t.fs.__failNext("write", "permission-denied");
    const r = await t.call("UPDATE_PROGRESS", FIRST);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "PERMISSION_DENIED", retryable: false }) });
    expect(t.states.map((s) => s.state)).toEqual(["loading", "permission_denied"]);
    expect(t.states.some((s) => s.state === "success")).toBe(false);
    expect(t.fs.__peek("user_progress/u1")).toBeUndefined();
    await t.call("GET_PROGRESS");
    expect(gets(t, "user_progress/u1")).toBe(2); // stale entry was dropped, not trusted
  });

  it("network failure is retryable, shows no success, and a retry is idempotent (no double reward)", async () => {
    const t = await setup();
    t.fs.__failNext("write", "unavailable");
    const r = await t.call("UPDATE_PROGRESS", FIRST);
    expect(r.error).toMatchObject({ code: "NETWORK", retryable: true });
    expect(t.states.some((s) => s.state === "success")).toBe(false);
    expect(t.states.at(-1).state).toBe("network_error");
    await t.call("UPDATE_PROGRESS", FIRST);
    await t.call("UPDATE_PROGRESS", FIRST);
    expect(t.fs.__peek("user_progress/u1")).toMatchObject({ levels_passed: [1], total_score: 20, streak_count: 1 });
  });

  it("failed read is not cached", async () => {
    const t = await setup();
    t.fs.__failNext("read", "unavailable");
    expect((await t.call("GET_PROGRESS")).error.code).toBe("NETWORK");
    expect((await t.call("GET_PROGRESS")).ok).toBe(true);
    expect(gets(t, "user_progress/u1")).toBe(2);
  });

  it("corrupt stored data -> INTERNAL, never raw passthrough", async () => {
    const t = await setup();
    t.fs.__seed("user_progress/u1", { total_score: "lots", levels_passed: "all" });
    const r = await t.call("GET_PROGRESS");
    expect(r.error.code).toBe("INTERNAL");
  });

  it("existing documents with missing fields are handled (absent fields default)", async () => {
    const t = await setup();
    t.fs.__seed("user_progress/u1", { user_id: "u1", total_score: 7 });
    const r = await t.call("UPDATE_PROGRESS", { progressData: { completedLevels: [4] } });
    expect(r.ok).toBe(true);
    expect(t.fs.__peek("user_progress/u1")).toMatchObject({ levels_passed: [4], total_score: 7 });
  });

  it("merge that would exceed the level cap is rejected before writing", async () => {
    const t = await setup();
    t.fs.__seed("user_progress/u1", { user_id: "u1", levels_passed: Array.from({ length: 500 }, (_, i) => i), total_score: 0, streak_count: 0 });
    const r = await t.call("UPDATE_PROGRESS", { progressData: { completedLevels: [9999] } });
    expect(r.error.code).toBe("INVALID_ARGUMENT");
    expect(t.storeOps().some((o) => o.op.startsWith("write"))).toBe(false);
  });
});

describe("cache isolation across sign-out and account switch", () => {
  it("sign-out drops the user's cache; the next user never sees it", async () => {
    const t = await setup("A");
    t.fs.__seed("user_progress/A", { user_id: "A", levels_passed: [1, 2, 3], total_score: 300, streak_count: 3 });
    t.fs.__seed("user_progress/B", { user_id: "B", levels_passed: [], total_score: 1, streak_count: 0 });
    expect((await t.call("GET_PROGRESS")).data.currentScore).toBe(300);
    expect(t.runtimeCache.get({ uid: "A", typeId: t.registry.DATA_TYPE.USER_PROGRESS, scope: "self" }).hit).toBe(true);

    t.logout();
    expect(t.runtimeCache.get({ uid: "A", typeId: t.registry.DATA_TYPE.USER_PROGRESS, scope: "self" }).hit).toBe(false);
    expect((await t.call("GET_PROGRESS")).error.code).toBe("UNAUTHENTICATED");

    t.login("B");
    expect((await t.call("GET_PROGRESS")).data.currentScore).toBe(1);
  });

  it("direct account switch (A -> B without a signed-out gap) also clears A's entries", async () => {
    const t = await setup("A");
    await t.call("GET_PROGRESS");
    t.login("B");
    expect(t.runtimeCache.get({ uid: "A", typeId: t.registry.DATA_TYPE.USER_PROGRESS, scope: "self" }).hit).toBe(false);
    const r = await t.call("GET_PROGRESS");
    expect(r.data.userId).toBe("B");
  });

  it("authManager.signOutUser clears the cache and the session", async () => {
    const t = await setup("A");
    await t.call("GET_PROGRESS");
    await t.authManager.signOutUser();
    expect(t.runtimeCache.size()).toBe(0);
    expect((await t.call("GET_PROGRESS")).error.code).toBe("UNAUTHENTICATED");
  });

  it("a read that finishes after sign-out does not repopulate the cache", async () => {
    const t = await setup("A");
    t.fs.__onRead(() => t.logout()); // user signs out while the request is in flight
    await t.call("GET_PROGRESS");
    expect(t.runtimeCache.size()).toBe(0);
  });
});

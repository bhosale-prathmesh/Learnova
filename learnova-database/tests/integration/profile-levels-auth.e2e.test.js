import { describe, it, expect, vi } from "vitest";
import { boot, installRulesMirror } from "./helpers.js";

const setup = async (uid = "u1", extra = {}) => {
  const t = await boot();
  installRulesMirror(t.fs, () => t.session.getSession().uid ?? uid);
  t.login(uid, extra);
  return t;
};

describe("profile", () => {
  it("GET_PROFILE with no document -> ok:null and EMPTY feedback", async () => {
    const t = await setup();
    const r = await t.call("GET_PROFILE");
    expect(r).toEqual({ ok: true, data: null });
    expect(t.states.at(-1).state).toBe("empty");
  });

  it("ENSURE_PROFILE creates a minimal profile from Auth data, and is idempotent", async () => {
    const t = await setup("u1", { displayName: "Alex", email: "alex@example.com" });
    const r = await t.call("ENSURE_PROFILE");
    expect(r.data).toMatchObject({ id: "u1", fullName: "Alex", emailAddress: "alex@example.com" });
    const stored = t.fs.__peek("users/u1");
    expect(Object.keys(stored).sort()).toEqual(["created_at", "display_name", "email_id", "uid", "updated_at"]);
    expect(stored.uid).toBe("u1");
    const writesBefore = t.storeOps().filter((o) => o.op.startsWith("write")).length;
    const again = await t.call("ENSURE_PROFILE");
    expect(again.data.fullName).toBe("Alex");
    expect(t.storeOps().filter((o) => o.op.startsWith("write")).length).toBe(writesBefore);
  });

  it("name falls back to the email prefix, then to a default; no email -> no email_id", async () => {
    let t = await setup("u1", { displayName: null, email: "sam.k@example.com" });
    expect((await t.call("ENSURE_PROFILE")).data.fullName).toBe("sam.k");
    t = await setup("u2", { displayName: null, email: null });
    expect((await t.call("ENSURE_PROFILE")).data.fullName).toBe("Learner");
    expect(Object.hasOwn(t.fs.__peek("users/u2"), "email_id")).toBe(false);
  });

  it("UPDATE_PROFILE changes only display_name + updated_at; protected/server fields are untouched", async () => {
    const t = await setup("u1", { email: "a@example.com" });
    const created = { uid: "u1", display_name: "Old", email_id: "a@example.com", role_type: "student", created_at: new t.fs.__FakeTimestamp(5), updated_at: new t.fs.__FakeTimestamp(5) };
    t.fs.__seed("users/u1", created);
    const r = await t.call("UPDATE_PROFILE", { profileData: { fullName: "  New Name " } });
    expect(r.ok).toBe(true);
    expect(r.data.fullName).toBe("New Name");
    const stored = t.fs.__peek("users/u1");
    expect(stored).toMatchObject({ uid: "u1", display_name: "New Name", email_id: "a@example.com", role_type: "student" });
    expect(stored.created_at.toMillis()).toBe(5);
    expect(t.states.at(-1)).toMatchObject({ state: "success", message: "Profile updated." });
    expect((await t.call("GET_PROFILE")).data.fullName).toBe("New Name"); // cache invalidated by the write
  });

  it("UPDATE_PROFILE with no existing profile creates one", async () => {
    const t = await setup("u1", { email: "a@example.com" });
    const r = await t.call("UPDATE_PROFILE", { profileData: { fullName: "First" } });
    expect(r.ok).toBe(true);
    expect(t.fs.__peek("users/u1")).toMatchObject({ uid: "u1", display_name: "First", email_id: "a@example.com" });
  });

  it.each([
    [{ fullName: "A", role: "admin" }], [{ fullName: "A", uid: "u2" }], [{ fullName: "A", emailAddress: "x@y.z" }],
    [{ role: "admin" }], [{ fullName: "" }], [{ fullName: "x".repeat(200) }],
  ])("rejects forbidden/invalid profile patch %j with no write", async (profileData) => {
    const t = await setup();
    const r = await t.call("UPDATE_PROFILE", { profileData });
    expect(r.error.code).toBe("INVALID_ARGUMENT");
    expect(t.storeOps()).toEqual([]);
  });

  it("only ever touches users/<own uid>", async () => {
    const t = await setup("A");
    t.fs.__seed("users/B", { uid: "B", display_name: "Bee" });
    await t.call("ENSURE_PROFILE");
    await t.call("UPDATE_PROFILE", { profileData: { fullName: "Aye" } });
    await t.call("GET_PROFILE");
    for (const op of t.storeOps()) expect(op.path).toBe("users/A");
    expect(t.fs.__peek("users/B").display_name).toBe("Bee");
  });

  it("permission denial on profile write is normalized and not reported as success", async () => {
    const t = await setup();
    t.fs.__failNext("write", "permission-denied");
    const r = await t.call("UPDATE_PROFILE", { profileData: { fullName: "Zed" } });
    expect(r.error.code).toBe("PERMISSION_DENIED");
    expect(t.states.some((s) => s.state === "success")).toBe(false);
  });
});

describe("levels (read-only content)", () => {
  const seed = (t, published = true) => {
    t.fs.__seed("courses/py", { title: "Python", published });
    t.fs.__seed("courses/py/levels/l3", { title: "Loops", order: 3, content: { q: 1 } });
    t.fs.__seed("courses/py/levels/l1", { title: "Intro", order: 1, content: {} });
    t.fs.__seed("courses/py/levels/l2", { title: "Vars", order: 2 });
    t.fs.__seed("courses/py/levels/l2b", { title: "Vars 2", order: 2 });
    t.fs.__seed("courses/other/levels/zzz", { title: "not mine", order: 1 });
  };
  const reads = (t) => t.storeOps().filter((o) => o.op === "get" || o.op === "list").length;

  it("returns the course and its levels sorted by order, then id", async () => {
    const t = await setup();
    seed(t);
    const r = await t.call("FETCH_LEVELS", { courseId: "py" });
    expect(r.ok).toBe(true);
    expect(r.data.course).toEqual({ id: "py", title: "Python" });
    expect(r.data.levels.map((l) => l.id)).toEqual(["l1", "l2", "l2b", "l3"]);
    expect(r.data.levels[2].content).toEqual({});
  });

  it("is cached for the TTL, then refetched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = await setup();
      seed(t);
      await t.call("FETCH_LEVELS", { courseId: "py" });
      const first = reads(t);
      await t.call("FETCH_LEVELS", { courseId: "py" });
      expect(reads(t)).toBe(first);
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
      await t.call("FETCH_LEVELS", { courseId: "py" });
      expect(reads(t)).toBe(first * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unpublished and missing courses -> NOT_FOUND (empty feedback), nothing cached", async () => {
    const t = await setup();
    seed(t, false);
    expect((await t.call("FETCH_LEVELS", { courseId: "py" })).error.code).toBe("NOT_FOUND");
    expect((await t.call("FETCH_LEVELS", { courseId: "nope" })).error.code).toBe("NOT_FOUND");
    expect(t.states.at(-1).state).toBe("empty");
    expect(t.runtimeCache.size()).toBe(0);
  });

  it.each([["../users/u1"], ["a/b"], [""], ["x".repeat(101)], [5], [{}]])("invalid courseId %j -> INVALID_ARGUMENT, no DB access", async (courseId) => {
    const t = await setup();
    const r = await t.call("FETCH_LEVELS", { courseId });
    expect(r.error.code).toBe("INVALID_ARGUMENT");
    expect(t.storeOps()).toEqual([]);
  });

  it("shared content cache is NOT reachable without a signed-in session", async () => {
    const t = await setup("A");
    seed(t);
    expect((await t.call("FETCH_LEVELS", { courseId: "py" })).ok).toBe(true);
    t.logout();
    const r = await t.call("FETCH_LEVELS", { courseId: "py" });
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "UNAUTHENTICATED" }) });
  });

  it("network error -> retryable, no stale fallback; malformed level -> INTERNAL and not cached", async () => {
    const t = await setup();
    seed(t);
    t.fs.__failNext("read", "unavailable");
    expect((await t.call("FETCH_LEVELS", { courseId: "py" })).error).toMatchObject({ code: "NETWORK", retryable: true });
    t.fs.__seed("courses/py/levels/bad", { order: 1 }); // no title
    expect((await t.call("FETCH_LEVELS", { courseId: "py" })).error.code).toBe("INTERNAL");
    expect(t.runtimeCache.size()).toBe(0);
  });
});

describe("authentication-manager", () => {
  it("sign-in / register / popup flows return a minimal user and normalized errors", async () => {
    const t = await boot();
    t.auth.__addAccount("a@x.com", "secret1", "uidA", "Ann");
    expect(await t.authManager.signInWithEmail(" a@x.com ", "secret1")).toEqual({ uid: "uidA", email: "a@x.com", displayName: "Ann" });
    await expect(t.authManager.signInWithEmail("a@x.com", "wrong")).rejects.toMatchObject({ code: "AUTH_FAILED", retryable: true });
    await expect(t.authManager.registerWithEmail("a@x.com", "secret1")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(t.authManager.registerWithEmail("n@x.com", "123")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(t.authManager.signInWithEmail("", "x")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    t.auth.__setPopupResult({ code: "auth/popup-closed-by-user" });
    await expect(t.authManager.signInWithGoogle()).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    t.auth.__setPopupResult({ uid: "g1", email: "g@x.com", displayName: "Gee" });
    expect((await t.authManager.signInWithGoogle()).uid).toBe("g1");
  });

  it("sign-in with blank config fails with CONFIG_MISSING, not a raw SDK exception", async () => {
    const t = await boot({ configured: false });
    await expect(t.authManager.signInWithEmail("a@x.com", "pw")).rejects.toMatchObject({ code: "CONFIG_MISSING" });
  });

  it("onAuthChange delivers a minimal user object and an unsubscribe", async () => {
    const t = await boot();
    const seen = [];
    const off = t.authManager.onAuthChange((u) => seen.push(u));
    t.login("u9");
    off();
    t.logout();
    expect(seen.at(-1)).toEqual({ uid: "u9", email: "u9@example.com", displayName: null });
    expect(seen).not.toContain(null);
  });
});

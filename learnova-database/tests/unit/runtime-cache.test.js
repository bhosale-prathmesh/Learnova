import { describe, it, expect } from "vitest";
import { createRuntimeCache } from "../../database/cache/runtime-cache.js";

const make = () => {
  let t = 1000;
  const cache = createRuntimeCache({ now: () => t });
  return { cache, tick: (ms) => { t += ms; } };
};
const S = (uid, typeId = 1, scope = "self") => ({ uid, typeId, scope });

describe("runtime-cache", () => {
  it("returns a hit before TTL and a miss (and deletes) at/after TTL", () => {
    const { cache, tick } = make();
    cache.set(S("u1"), { a: 1 }, 100);
    tick(99);
    expect(cache.get(S("u1"))).toEqual({ hit: true, value: { a: 1 } });
    tick(1);
    expect(cache.get(S("u1"))).toEqual({ hit: false });
    expect(cache.size()).toBe(0);
  });

  it.each([[false], [0], [""], [null]])("falsy value %j is a real hit, not a miss", (v) => {
    const { cache } = make();
    cache.set(S("u1"), v, 100);
    expect(cache.get(S("u1"))).toEqual({ hit: true, value: v });
  });

  it("scopes by UID: user B never sees user A's entry", () => {
    const { cache } = make();
    cache.set(S("A"), "secret-A", 100);
    expect(cache.get(S("B")).hit).toBe(false);
    expect(cache.get(S(null)).hit).toBe(false);
  });

  it("invalidateUser removes only that exact UID (no substring matching)", () => {
    const { cache } = make();
    cache.set(S("u1"), 1, 100);
    cache.set(S("u10"), 2, 100);
    cache.set(S(null, 2, "course:u1"), 3, 100);
    cache.invalidateUser("u1");
    expect(cache.get(S("u1")).hit).toBe(false);
    expect(cache.get(S("u10")).hit).toBe(true);
    expect(cache.get(S(null, 2, "course:u1")).hit).toBe(true);
  });

  it("invalidateUser ignores empty / non-string UIDs", () => {
    const { cache } = make();
    cache.set(S(null, 2), 1, 100);
    cache.invalidateUser("");
    cache.invalidateUser(null);
    cache.invalidateUser(undefined);
    expect(cache.size()).toBe(1);
  });

  it("exact invalidate removes only one entry", () => {
    const { cache } = make();
    cache.set(S("u1", 1), 1, 100);
    cache.set(S("u1", 3), 2, 100);
    cache.invalidate(S("u1", 1));
    expect(cache.get(S("u1", 1)).hit).toBe(false);
    expect(cache.get(S("u1", 3)).hit).toBe(true);
  });

  it("stores and returns clones (callers cannot corrupt the cache)", () => {
    const { cache } = make();
    const original = { levels: [1] };
    cache.set(S("u1"), original, 100);
    original.levels.push(2);
    const got = cache.get(S("u1")).value;
    got.levels.push(3);
    expect(cache.get(S("u1")).value).toEqual({ levels: [1] });
  });

  it.each([[0], [-5], [NaN], [Infinity], [undefined], ["10"]])("rejects invalid TTL %j", (ttl) => {
    const { cache } = make();
    expect(() => cache.set(S("u1"), 1, ttl)).toThrow();
  });

  it("is bounded (oldest entries evicted)", () => {
    const { cache } = make();
    for (let i = 0; i < 250; i++) cache.set(S("u", 1, `s${i}`), i, 1000);
    expect(cache.size()).toBe(200);
    expect(cache.get(S("u", 1, "s0")).hit).toBe(false);
    expect(cache.get(S("u", 1, "s249")).hit).toBe(true);
  });
});

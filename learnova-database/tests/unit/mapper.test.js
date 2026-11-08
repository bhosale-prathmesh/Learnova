import { describe, it, expect } from "vitest";
import {
  toBackendProgressPatch, fromBackendProgress, initialProgressModel,
  toBackendProfilePatch, fromBackendProfile,
  fromBackendCourse, fromBackendLevel, normalizeDocId, timestampToMillis, PROGRESS_LIMITS,
} from "../../database/access-datatype.js";
import { ERROR_CODE } from "../../database/errors.js";

const code = (c) => expect.objectContaining({ code: c });

describe("progress mapper: frontend -> backend", () => {
  it("translates field names and returns only provided fields", () => {
    expect(toBackendProgressPatch({ currentScore: 20 })).toEqual({ total_score: 20 });
    expect(toBackendProgressPatch({ completedLevels: [3, 1, 3], currentScore: 20, dayStreak: 1 })).toEqual({
      levels_passed: [1, 3], total_score: 20, streak_count: 1,
    });
  });

  it.each([
    ["userId (identity not accepted)", { userId: "someone", currentScore: 1 }],
    ["role / privilege field", { role: "admin", currentScore: 1 }],
    ["backend-named field", { total_score: 1 }],
    ["updatedAt", { updatedAt: 1, currentScore: 1 }],
  ])("rejects unexpected field: %s", (_n, input) => {
    expect(() => toBackendProgressPatch(input)).toThrowError(code(ERROR_CODE.INVALID_ARGUMENT));
  });

  it.each([
    ["negative score", { currentScore: -1 }],
    ["string score", { currentScore: "20" }],
    ["fractional score", { currentScore: 1.5 }],
    ["NaN score", { currentScore: NaN }],
    ["score over max", { currentScore: PROGRESS_LIMITS.MAX_SCORE + 1 }],
    ["negative streak", { dayStreak: -2 }],
    ["levels not array", { completedLevels: "1,2" }],
    ["levels with string", { completedLevels: [1, "2"] }],
    ["levels with negative", { completedLevels: [-1] }],
    ["too many levels", { completedLevels: Array.from({ length: PROGRESS_LIMITS.MAX_LEVELS_PASSED + 1 }, (_, i) => i) }],
    ["empty patch", {}],
    ["not an object", "x"],
    ["null", null],
    ["array", [1]],
  ])("rejects malformed value: %s", (_n, input) => {
    expect(() => toBackendProgressPatch(input)).toThrowError(code(ERROR_CODE.INVALID_ARGUMENT));
  });
});

describe("progress mapper: backend -> frontend", () => {
  it("maps keys, takes identity from the argument, converts timestamps", () => {
    const m = fromBackendProgress("u1", {
      user_id: "SOMEONE_ELSE", levels_passed: [1, 2], total_score: 9, streak_count: 3,
      updated_at: { toMillis: () => 1234 },
    });
    expect(m).toEqual({ userId: "u1", completedLevels: [1, 2], currentScore: 9, dayStreak: 3, updatedAt: 1234 });
  });
  it("absent fields get defaults", () => {
    expect(fromBackendProgress("u1", {})).toEqual(initialProgressModel("u1"));
  });
  it("wrong stored types are rejected, not passed through", () => {
    expect(() => fromBackendProgress("u1", { total_score: "9" })).toThrowError(code(ERROR_CODE.INTERNAL));
    expect(() => fromBackendProgress("u1", { levels_passed: "x" })).toThrowError(code(ERROR_CODE.INTERNAL));
    expect(() => fromBackendProgress("u1", null)).toThrowError(code(ERROR_CODE.INTERNAL));
  });
});

describe("profile mapper", () => {
  it("only fullName is accepted, trimmed, mapped to display_name", () => {
    expect(toBackendProfilePatch({ fullName: "  Alex  " })).toEqual({ display_name: "Alex" });
  });
  it.each([
    [{ fullName: "A", role: "x" }], [{ fullName: "A", uid: "u" }], [{ emailAddress: "a@b.c" }],
    [{ fullName: "   " }], [{ fullName: 5 }], [{ fullName: "x".repeat(81) }], [{}], [null],
  ])("rejects %j", (input) => {
    expect(() => toBackendProfilePatch(input)).toThrowError(code(ERROR_CODE.INVALID_ARGUMENT));
  });
  it("backend -> frontend", () => {
    expect(fromBackendProfile("u1", { uid: "zzz", display_name: "Alex", email_id: "a@x.com", created_at: 5 })).toEqual({
      id: "u1", fullName: "Alex", emailAddress: "a@x.com", createdAt: 5, updatedAt: null,
    });
    expect(() => fromBackendProfile("u1", { email_id: "a@x.com" })).toThrowError(code(ERROR_CODE.INTERNAL));
  });
});

describe("content mappers + helpers", () => {
  it("course and level mapping, strict about shape", () => {
    expect(fromBackendCourse("c1", { title: "Python", published: true })).toEqual({ id: "c1", title: "Python", published: true });
    expect(fromBackendCourse("c1", { title: "Python" }).published).toBe(false);
    expect(fromBackendLevel("l1", { title: "Intro", order: 2, content: { q: [] } })).toEqual({ id: "l1", order: 2, title: "Intro", content: { q: [] } });
    expect(fromBackendLevel("l1", { title: "Intro" })).toEqual({ id: "l1", order: 0, title: "Intro", content: {} });
    expect(() => fromBackendLevel("l1", { order: 1 })).toThrowError(code(ERROR_CODE.INTERNAL));
    expect(() => fromBackendLevel("l1", { title: "x", content: "str" })).toThrowError(code(ERROR_CODE.INTERNAL));
  });
  it("normalizeDocId blocks path tricks", () => {
    expect(normalizeDocId("course_1-A")).toBe("course_1-A");
    for (const bad of ["", "a/b", "../x", "a b", ".", "x".repeat(101), 5, null, undefined]) {
      expect(() => normalizeDocId(bad)).toThrowError(code(ERROR_CODE.INVALID_ARGUMENT));
    }
  });
  it("timestampToMillis", () => {
    expect(timestampToMillis(null)).toBeNull();
    expect(timestampToMillis(7)).toBe(7);
    expect(timestampToMillis({ toMillis: () => 9 })).toBe(9);
    expect(() => timestampToMillis("yesterday")).toThrowError(code(ERROR_CODE.INTERNAL));
  });
});

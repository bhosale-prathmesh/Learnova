import { describe, it, expect } from "vitest";
import { DATA_TYPE, getBackendKey, listDataTypes } from "../../database/access-datatype.js";
import { ERROR_CODE } from "../../database/errors.js";

// Frozen snapshot: this IS the "locked ID meaning" contract. Never edit an existing row;
// only append. If this test fails after a change, an ID was renumbered or re-pointed.
const LOCKED = [
  [0, "USER_NAME", "display_name"],
  [1, "USER_PROGRESS", "user_progress"],
  [2, "LEVEL_DATA", "levels"],
  [3, "USER_PROFILE", "users"],
  [4, "COURSE_DATA", "courses"],
  [5, "USER_EMAIL", "email_id"],
  [6, "USER_UID", "uid"],
  [7, "PROGRESS_USER_ID", "user_id"],
  [8, "PROGRESS_LEVELS_PASSED", "levels_passed"],
  [9, "PROGRESS_TOTAL_SCORE", "total_score"],
  [10, "PROGRESS_STREAK", "streak_count"],
  [11, "UPDATED_AT", "updated_at"],
  [12, "CREATED_AT", "created_at"],
  [13, "LEVEL_TITLE", "title"],
  [14, "LEVEL_ORDER", "order"],
  [15, "LEVEL_CONTENT", "content"],
  [16, "COURSE_TITLE", "title"],
  [17, "COURSE_PUBLISHED", "published"],
];

describe("access-datatype registry", () => {
  it("IDs are unique", () => {
    const ids = Object.values(DATA_TYPE);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("locked IDs keep their meaning (append-only)", () => {
    const actual = listDataTypes().map((t) => [t.id, t.name, t.key]);
    for (const row of LOCKED) expect(actual).toContainEqual(row);
    expect(actual.length).toBeGreaterThanOrEqual(LOCKED.length);
  });

  it("every constant resolves to a non-empty backend key", () => {
    for (const id of Object.values(DATA_TYPE)) expect(getBackendKey(id)).toMatch(/^[a-z_]+$/);
  });

  it.each([[999], [-1], [1.5], [NaN], [Infinity], ["1"], [null], [undefined], ["constructor"], ["__proto__"], [{}], [[1]]])(
    "unknown/malformed ID %s fails closed with UNKNOWN_DATA_TYPE",
    (bad) => {
      expect(() => getBackendKey(bad)).toThrowError(expect.objectContaining({ code: ERROR_CODE.UNKNOWN_DATA_TYPE }));
    }
  );

  it("registry is immutable", () => {
    expect(Object.isFrozen(DATA_TYPE)).toBe(true);
    expect(() => { DATA_TYPE.USER_PROGRESS = 99; }).toThrow(TypeError);
    expect(getBackendKey(DATA_TYPE.USER_PROGRESS)).toBe("user_progress");
  });
});

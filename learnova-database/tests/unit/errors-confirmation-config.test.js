import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeError, toErrorResult, AppError, ERROR_CODE } from "../../database/errors.js";
import { createConfirmationManager, UI_STATE } from "../../database/confirmation-manager.js";

describe("error normalization", () => {
  it.each([
    ["permission-denied", ERROR_CODE.PERMISSION_DENIED, false],
    ["unauthenticated", ERROR_CODE.UNAUTHENTICATED, false],
    ["not-found", ERROR_CODE.NOT_FOUND, false],
    ["unavailable", ERROR_CODE.NETWORK, true],
    ["deadline-exceeded", ERROR_CODE.NETWORK, true],
    ["auth/popup-closed-by-user", ERROR_CODE.AUTH_CANCELLED, true],
    ["auth/network-request-failed", ERROR_CODE.NETWORK, true],
    ["auth/invalid-credential", ERROR_CODE.AUTH_FAILED, true],
    ["auth/weak-password", ERROR_CODE.INVALID_ARGUMENT, false],
    ["aborted", ERROR_CODE.INTERNAL, true],
    ["something-new", ERROR_CODE.INTERNAL, false],
  ])("%s -> %s (retryable=%s)", (raw, code, retryable) => {
    const r = toErrorResult(Object.assign(new Error("RAW SECRET users/abc123 token xyz"), { code: raw }));
    expect(r.code).toBe(code);
    expect(r.retryable).toBe(retryable);
    expect(JSON.stringify(r)).not.toMatch(/RAW SECRET|abc123|token/);
    expect(Object.keys(r).sort()).toEqual(["code", "message", "retryable"]);
  });
  it("plain Error / non-error values become INTERNAL with a safe message", () => {
    for (const v of [new Error("boom path=/users/u1"), "str", null, undefined, 42]) {
      const r = toErrorResult(v);
      expect(r.code).toBe(ERROR_CODE.INTERNAL);
      expect(r.message).not.toMatch(/boom|u1/);
    }
  });
  it("AppError passes through; unknown codes collapse to INTERNAL", () => {
    const e = new AppError(ERROR_CODE.NOT_FOUND);
    expect(normalizeError(e)).toBe(e);
    expect(new AppError("MADE_UP").code).toBe(ERROR_CODE.INTERNAL);
  });
});

describe("confirmation manager", () => {
  it("maps error codes to UI states and never leaks details", () => {
    const cm = createConfirmationManager();
    const seen = [];
    cm.subscribe((f) => seen.push(f.state));
    const expectState = (code, state) => expect(cm.failure("A", { code, message: "m", retryable: false }).state).toBe(state);
    expectState(ERROR_CODE.UNAUTHENTICATED, UI_STATE.AUTH_REQUIRED);
    expectState(ERROR_CODE.PERMISSION_DENIED, UI_STATE.PERMISSION_DENIED);
    expectState(ERROR_CODE.NETWORK, UI_STATE.NETWORK_ERROR);
    expectState(ERROR_CODE.NOT_FOUND, UI_STATE.EMPTY);
    expectState(ERROR_CODE.INVALID_ARGUMENT, UI_STATE.VALIDATION_ERROR);
    expectState(ERROR_CODE.INTERNAL, UI_STATE.ERROR);
    expect(seen).toHaveLength(6);
  });
  it("success message only for writes; idle by default; listener errors are contained", () => {
    const cm = createConfirmationManager();
    expect(cm.getState("X").state).toBe(UI_STATE.IDLE);
    expect(cm.success("UPDATE_PROGRESS", true).message).toBe("Progress saved.");
    expect(cm.success("GET_PROGRESS", false).message).toBeNull();
    cm.subscribe(() => { throw new Error("ui bug"); });
    expect(() => cm.loading("X")).not.toThrow();
  });
});

describe("firebase-config file", () => {
  const src = readFileSync(new URL("../../database/firebase/firebase-config.js", import.meta.url), "utf8");
  it("all SDK import URLs use one identical pinned version (no placeholders)", () => {
    const versions = [...src.matchAll(/firebasejs\/([^/]+)\/firebase-(app|auth|firestore)\.js/g)].map((m) => m[1]);
    expect(versions).toHaveLength(3);
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(src).toContain(`FIREBASE_SDK_VERSION = "${versions[0]}"`);
  });
  it("contains no service-account / admin credential material", () => {
    expect(src).not.toMatch(/private_key|BEGIN PRIVATE KEY|client_email|firebase-admin/i);
  });
});

// database/access-control.js
// The ONLY frontend entry point into the database module.
//
//   const result = await handleAppRequest(ACTION.GET_PROGRESS);
//   // { ok: true, data } | { ok: false, error: { code, message, retryable } }
//
// The gateway validates the action and payload shape, waits for Firebase Auth, dispatches to a
// service, normalizes the outcome and reports UI feedback through confirmation-manager.
// It never throws and never trusts a caller-supplied identity: services read the UID from the session.
//
// IMPORTANT: nothing here is database security. Firestore Rules authorize every request,
// including ones that never pass through this file.

import { whenReady, isAuthenticated } from "./authentication/session-manager.js";
import { fetchCourseLevels } from "./services/levels-service.js";
import { getProgress, updateProgress } from "./services/progress-service.js";
import { getProfile, ensureProfile, updateProfile } from "./services/users-service.js";
import { confirmationManager } from "./confirmation-manager.js";
import { isPlainObject } from "./access-datatype.js";
import { AppError, ERROR_CODE, toErrorResult } from "./errors.js";

export const ACTION = Object.freeze({
  FETCH_LEVELS: "FETCH_LEVELS",
  GET_PROGRESS: "GET_PROGRESS",
  UPDATE_PROGRESS: "UPDATE_PROGRESS",
  GET_PROFILE: "GET_PROFILE",
  ENSURE_PROFILE: "ENSURE_PROFILE",
  UPDATE_PROFILE: "UPDATE_PROFILE",
});

// One row per action: payload contract + handler. Payload carries NO identity (no userId, no role).
const ACTIONS = Object.freeze({
  [ACTION.FETCH_LEVELS]: { write: false, required: ["courseId"], allowed: ["courseId"], run: (p) => fetchCourseLevels(p.courseId) },
  [ACTION.GET_PROGRESS]: { write: false, required: [], allowed: [], run: () => getProgress() },
  [ACTION.UPDATE_PROGRESS]: { write: true, required: ["progressData"], allowed: ["progressData"], run: (p) => updateProgress(p.progressData) },
  [ACTION.GET_PROFILE]: { write: false, required: [], allowed: [], run: () => getProfile() },
  [ACTION.ENSURE_PROFILE]: { write: true, required: [], allowed: [], run: () => ensureProfile() },
  [ACTION.UPDATE_PROFILE]: { write: true, required: ["profileData"], allowed: ["profileData"], run: (p) => updateProfile(p.profileData) },
});

function validateRequest(action, payload) {
  if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) {
    throw new AppError(ERROR_CODE.INVALID_ACTION);
  }
  const spec = ACTIONS[action];
  if (!isPlainObject(payload)) {
    throw new AppError(ERROR_CODE.INVALID_ARGUMENT, "The request is not valid.");
  }
  for (const key of Object.keys(payload)) {
    if (!spec.allowed.includes(key)) {
      throw new AppError(ERROR_CODE.INVALID_ARGUMENT, `Field "${key}" is not accepted for this action.`);
    }
  }
  for (const key of spec.required) {
    if (!Object.hasOwn(payload, key) || payload[key] === undefined || payload[key] === null) {
      throw new AppError(ERROR_CODE.INVALID_ARGUMENT, `Field "${key}" is required.`);
    }
  }
  return spec;
}

const isEmptyData = (data) => data === null || data === undefined || (Array.isArray(data) && data.length === 0);

/**
 * @param {string} action one of ACTION
 * @param {object} [payload]
 * @returns {Promise<{ok:true,data:any}|{ok:false,error:{code:string,message:string,retryable:boolean}}>}
 */
export async function handleAppRequest(action, payload = {}) {
  let spec;
  try {
    spec = validateRequest(action, payload);
  } catch (err) {
    const error = toErrorResult(err);
    confirmationManager.failure(typeof action === "string" ? action : "UNKNOWN", error);
    return { ok: false, error };
  }

  confirmationManager.loading(action);
  try {
    await whenReady();
    if (!isAuthenticated()) throw new AppError(ERROR_CODE.UNAUTHENTICATED);

    const data = await spec.run(payload);

    // Reached only after the service (and Firestore) confirmed the operation.
    if (!spec.write && isEmptyData(data)) confirmationManager.empty(action);
    else confirmationManager.success(action, spec.write);
    return { ok: true, data };
  } catch (err) {
    const error = toErrorResult(err);
    confirmationManager.failure(action, error);
    return { ok: false, error };
  }
}

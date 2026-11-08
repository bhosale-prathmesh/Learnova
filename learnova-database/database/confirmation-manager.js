// database/confirmation-manager.js
// UI feedback adapter. Translates normalized results/errors into consistent UI states and
// messages. Framework-agnostic: the UI subscribes and renders however it likes.
//
// It does NOT authorize or write anything. It never claims a write succeeded: `success()` is only
// called by the gateway after the service (and therefore Firestore) confirmed.
// It never receives or shows raw tokens, UIDs, document paths or SDK exceptions.

import { ERROR_CODE } from "./errors.js";

export const UI_STATE = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  SUCCESS: "success",
  EMPTY: "empty",
  VALIDATION_ERROR: "validation_error",
  PERMISSION_DENIED: "permission_denied",
  NETWORK_ERROR: "network_error",
  AUTH_REQUIRED: "auth_required",
  ERROR: "error",
});

const STATE_BY_ERROR_CODE = Object.freeze({
  [ERROR_CODE.UNAUTHENTICATED]: UI_STATE.AUTH_REQUIRED,
  [ERROR_CODE.PERMISSION_DENIED]: UI_STATE.PERMISSION_DENIED,
  [ERROR_CODE.NETWORK]: UI_STATE.NETWORK_ERROR,
  [ERROR_CODE.NOT_FOUND]: UI_STATE.EMPTY,
  [ERROR_CODE.INVALID_ARGUMENT]: UI_STATE.VALIDATION_ERROR,
  [ERROR_CODE.INVALID_ACTION]: UI_STATE.VALIDATION_ERROR,
});

// Shown only for WRITE actions, only after confirmed success. Edit/translate freely.
export const SUCCESS_MESSAGES = Object.freeze({
  UPDATE_PROGRESS: "Progress saved.",
  UPDATE_PROFILE: "Profile updated.",
});
const EMPTY_MESSAGE = "Nothing to show yet.";

export function createConfirmationManager() {
  const states = new Map();
  const listeners = new Set();

  function emit(action, feedback) {
    const full = Object.freeze({ action, ...feedback });
    states.set(action, full);
    for (const fn of [...listeners]) {
      try {
        fn(full);
      } catch {
        /* a UI listener must never break the data flow */
      }
    }
    return full;
  }

  return Object.freeze({
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getState(action) {
      return states.get(action) ?? Object.freeze({ action, state: UI_STATE.IDLE, message: null, retryable: false });
    },
    loading(action) {
      return emit(action, { state: UI_STATE.LOADING, message: null, retryable: false });
    },
    /** @param {boolean} isWrite only writes get a visible success message */
    success(action, isWrite) {
      const message = isWrite ? SUCCESS_MESSAGES[action] ?? null : null;
      return emit(action, { state: UI_STATE.SUCCESS, message, retryable: false });
    },
    empty(action) {
      return emit(action, { state: UI_STATE.EMPTY, message: EMPTY_MESSAGE, retryable: false });
    },
    /** @param {{code:string, message:string, retryable:boolean}} error normalized error result */
    failure(action, error) {
      const state = STATE_BY_ERROR_CODE[error.code] ?? UI_STATE.ERROR;
      return emit(action, { state, message: error.message, retryable: Boolean(error.retryable), code: error.code });
    },
  });
}

export const confirmationManager = createConfirmationManager();

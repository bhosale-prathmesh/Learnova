// database/errors.js
// Shared, normalized error contract for the whole module.
//
// Every failure that leaves the gateway looks like:
//   { code, message (user-safe), retryable }
// Raw SDK errors, tokens, UIDs and document paths never reach the UI.

export const ERROR_CODE = Object.freeze({
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  INVALID_ACTION: "INVALID_ACTION",
  UNKNOWN_DATA_TYPE: "UNKNOWN_DATA_TYPE",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  NOT_FOUND: "NOT_FOUND",
  NETWORK: "NETWORK",
  AUTH_CANCELLED: "AUTH_CANCELLED",
  AUTH_FAILED: "AUTH_FAILED",
  CONFIG_MISSING: "CONFIG_MISSING",
  INTERNAL: "INTERNAL",
});

const DEFAULTS = Object.freeze({
  [ERROR_CODE.UNAUTHENTICATED]: { message: "Please sign in to continue.", retryable: false },
  [ERROR_CODE.INVALID_ARGUMENT]: { message: "Some of the information provided is not valid.", retryable: false },
  [ERROR_CODE.INVALID_ACTION]: { message: "This action is not supported.", retryable: false },
  [ERROR_CODE.UNKNOWN_DATA_TYPE]: { message: "Something went wrong. Please try again later.", retryable: false },
  [ERROR_CODE.PERMISSION_DENIED]: { message: "You do not have permission to do that.", retryable: false },
  [ERROR_CODE.NOT_FOUND]: { message: "We could not find what you were looking for.", retryable: false },
  [ERROR_CODE.NETWORK]: { message: "Network problem. Please check your connection and try again.", retryable: true },
  [ERROR_CODE.AUTH_CANCELLED]: { message: "Sign-in was cancelled.", retryable: true },
  [ERROR_CODE.AUTH_FAILED]: { message: "Sign-in failed. Please check your details and try again.", retryable: true },
  [ERROR_CODE.CONFIG_MISSING]: { message: "The app is not configured yet.", retryable: false },
  [ERROR_CODE.INTERNAL]: { message: "Something went wrong. Please try again.", retryable: false },
});

export class AppError extends Error {
  /**
   * @param {string} code one of ERROR_CODE
   * @param {string} [message] user-safe message (defaults per code)
   * @param {{retryable?: boolean, cause?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    const base = DEFAULTS[code] ?? DEFAULTS[ERROR_CODE.INTERNAL];
    super(message ?? base.message);
    this.name = "AppError";
    this.code = DEFAULTS[code] ? code : ERROR_CODE.INTERNAL;
    this.retryable = opts.retryable ?? base.retryable;
    // Kept for developer logging only; never copied into the result contract.
    Object.defineProperty(this, "cause", { value: opts.cause, enumerable: false });
  }
}

// Firestore SDK error codes -> normalized
const FIRESTORE_CODE_MAP = Object.freeze({
  "permission-denied": ERROR_CODE.PERMISSION_DENIED,
  unauthenticated: ERROR_CODE.UNAUTHENTICATED,
  "not-found": ERROR_CODE.NOT_FOUND,
  unavailable: ERROR_CODE.NETWORK,
  "deadline-exceeded": ERROR_CODE.NETWORK,
  cancelled: ERROR_CODE.NETWORK,
  "invalid-argument": ERROR_CODE.INVALID_ARGUMENT,
  "out-of-range": ERROR_CODE.INVALID_ARGUMENT,
});

// Firebase Auth error codes -> normalized
const AUTH_CODE_MAP = Object.freeze({
  "auth/popup-closed-by-user": ERROR_CODE.AUTH_CANCELLED,
  "auth/cancelled-popup-request": ERROR_CODE.AUTH_CANCELLED,
  "auth/user-cancelled": ERROR_CODE.AUTH_CANCELLED,
  "auth/network-request-failed": ERROR_CODE.NETWORK,
  "auth/invalid-credential": ERROR_CODE.AUTH_FAILED,
  "auth/wrong-password": ERROR_CODE.AUTH_FAILED,
  "auth/user-not-found": ERROR_CODE.AUTH_FAILED,
  "auth/user-disabled": ERROR_CODE.AUTH_FAILED,
  "auth/too-many-requests": ERROR_CODE.AUTH_FAILED,
  "auth/invalid-email": ERROR_CODE.INVALID_ARGUMENT,
  "auth/missing-password": ERROR_CODE.INVALID_ARGUMENT,
  "auth/weak-password": ERROR_CODE.INVALID_ARGUMENT,
  "auth/email-already-in-use": ERROR_CODE.INVALID_ARGUMENT,
});

/** Convert anything thrown into an AppError. Unknown errors become INTERNAL. */
export function normalizeError(err) {
  if (err instanceof AppError) return err;
  const raw = err && typeof err === "object" ? err.code : undefined;
  if (typeof raw === "string") {
    const code = AUTH_CODE_MAP[raw] ?? FIRESTORE_CODE_MAP[raw];
    if (code) {
      let message;
      if (raw === "auth/weak-password") message = "Please choose a stronger password.";
      if (raw === "auth/email-already-in-use") message = "An account with this email already exists.";
      if (raw === "auth/invalid-email") message = "Please enter a valid email address.";
      return new AppError(code, message, { cause: err });
    }
    // Transient backend conditions worth a retry.
    if (raw === "aborted" || raw === "resource-exhausted") {
      return new AppError(ERROR_CODE.INTERNAL, undefined, { retryable: true, cause: err });
    }
  }
  return new AppError(ERROR_CODE.INTERNAL, undefined, { cause: err });
}

/** The only error shape that crosses the gateway boundary. */
export function toErrorResult(err) {
  const e = normalizeError(err);
  return { code: e.code, message: e.message, retryable: e.retryable };
}

/** Typed error model shared by every Edge Function and the frontend. */

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'REGISTRATION_CLOSED'
  | 'NOT_CONFIGURED'
  | 'RATE_LIMITED'
  | 'UPLOAD_MISSING'
  | 'UPLOAD_INVALID'
  | 'UPLOAD_SESSION_INVALID'
  | 'UPLOAD_SESSION_EXPIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'STATUS_CONFLICT'
  | 'NO_CHANGE'
  | 'NOT_READY'
  | 'UNAVAILABLE'
  | 'INTERNAL';

export const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  REGISTRATION_CLOSED: 409,
  NOT_CONFIGURED: 503,
  RATE_LIMITED: 429,
  UPLOAD_MISSING: 409,
  UPLOAD_INVALID: 422,
  UPLOAD_SESSION_INVALID: 409,
  UPLOAD_SESSION_EXPIRED: 410,
  IDEMPOTENCY_KEY_REUSED: 409,
  STATUS_CONFLICT: 409,
  NO_CHANGE: 409,
  NOT_READY: 409,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** Safe, user-facing default messages. Never include internals here. */
export const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  INVALID_REQUEST: 'The request was not understood. Please refresh the page and try again.',
  VALIDATION_FAILED: 'Please correct the highlighted fields and try again.',
  UNAUTHENTICATED: 'Your session has expired or is missing. Please sign in again.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  NOT_FOUND: 'The requested record was not found.',
  METHOD_NOT_ALLOWED: 'This method is not allowed.',
  REGISTRATION_CLOSED: 'Registration is currently closed.',
  NOT_CONFIGURED: 'Registration is not ready yet. The organisers have not finished setting it up.',
  RATE_LIMITED: 'Too many requests from your network. Please wait a few minutes and try again.',
  UPLOAD_MISSING: 'The payment screenshot was not received. Please select the file and try again.',
  UPLOAD_INVALID: 'The payment screenshot is not a valid JPG, PNG or WEBP image under 5 MB.',
  UPLOAD_SESSION_INVALID: 'This upload can no longer be used. Please select the screenshot again.',
  UPLOAD_SESSION_EXPIRED: 'The upload window expired. Please select the screenshot again.',
  IDEMPOTENCY_KEY_REUSED:
    'A registration was already saved from this form session with different details. Please contact the organisers if you need to change it.',
  STATUS_CONFLICT: 'This record was changed by someone else. The latest data has been loaded; please review and retry.',
  NO_CHANGE: 'The record is already in that state.',
  NOT_READY: 'Complete the required payment details before opening registration.',
  UNAVAILABLE: 'The service is temporarily unavailable. Your details are safe in the form; please try again in a moment.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
};

/** Codes the client may safely retry without changing anything. */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['UNAVAILABLE', 'INTERNAL', 'RATE_LIMITED']);

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  /** Field-specific messages, keyed by form field name. */
  fields?: Record<string, string>;
  retryable: boolean;
  /** Extra non-sensitive machine-readable context (e.g. current status on conflict). */
  details?: Record<string, unknown>;
}

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = { ok: false; error: ApiErrorBody; requestId?: string };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly fields?: Record<string, string>;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message?: string,
    opts: { fields?: Record<string, string>; details?: Record<string, unknown>; retryAfterSeconds?: number } = {},
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    if (opts.fields) this.fields = opts.fields;
    if (opts.details) this.details = opts.details;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
  }

  toBody(): ApiErrorBody {
    const body: ApiErrorBody = {
      code: this.code,
      message: this.message,
      retryable: RETRYABLE.has(this.code),
    };
    if (this.fields) body.fields = this.fields;
    if (this.details) body.details = this.details;
    return body;
  }
}

/** Raised by the data layer when the database or storage is unreachable or errors out. */
export class DependencyError extends Error {
  readonly dependency: 'database' | 'storage' | 'auth';
  /** PostgreSQL SQLSTATE when the failure came from the database. */
  readonly sqlstate: string | undefined;
  constructor(dependency: 'database' | 'storage' | 'auth', message: string, sqlstate?: string) {
    super(message);
    this.name = 'DependencyError';
    this.dependency = dependency;
    this.sqlstate = sqlstate;
  }
}

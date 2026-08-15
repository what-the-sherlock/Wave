export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "TOKEN_EXPIRED"
  | "TOKEN_INVALID"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL";

/**
 * Base of the error hierarchy every service throws. Controllers never
 * try/catch — they let rejections bubble to `errorMiddleware`
 * (docs/target-architecture.md §7, D15).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) {
    super("VALIDATION_ERROR", message, 400, details);
    this.name = "ValidationError";
  }
}

/** Generic 401. Prefer `TokenExpiredError`/`TokenInvalidError` for auth-token failures. */
export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super("UNAUTHORIZED", message, 401);
    this.name = "UnauthorizedError";
  }
}

/**
 * `jwt.verify`-style libraries throw on failure rather than returning
 * falsy — the original app's dead `if (!decoded)` guard (D6) came from
 * missing this distinction. Callers must discriminate expired-vs-invalid so
 * the frontend can attempt a silent refresh only for the former.
 * docs/security-model.md §3.
 */
export class TokenExpiredError extends AppError {
  constructor(message = "Session expired") {
    super("TOKEN_EXPIRED", message, 401);
    this.name = "TokenExpiredError";
  }
}

export class TokenInvalidError extends AppError {
  constructor(message = "Invalid session") {
    super("TOKEN_INVALID", message, 401);
    this.name = "TokenInvalidError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
  }
}

/**
 * Used for both "genuinely doesn't exist" and "you don't have access" — a
 * 403 would confirm the resource exists, which leaks information an
 * unauthorized caller shouldn't have (docs/security-model.md §4).
 */
export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("NOT_FOUND", message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super("CONFLICT", message, 409);
    this.name = "ConflictError";
  }
}

export class RateLimitedError extends AppError {
  constructor(message = "Too many requests, please try again later") {
    super("RATE_LIMITED", message, 429);
    this.name = "RateLimitedError";
  }
}

/** An upstream dependency (Supabase Auth, Groq, ...) is down or timed out. */
export class ServiceUnavailableError extends AppError {
  constructor(message = "This service is temporarily unavailable") {
    super("SERVICE_UNAVAILABLE", message, 503);
    this.name = "ServiceUnavailableError";
  }
}

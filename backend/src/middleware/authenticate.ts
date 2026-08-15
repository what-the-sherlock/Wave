import type { NextFunction, Request, Response } from "express";
import { readAccessToken } from "../auth/cookies.js";
import { verifyAccessToken, type AccessTokenClaims } from "../auth/jwt.js";
import { asyncHandler } from "../errors/asyncHandler.js";
import { UnauthorizedError } from "../errors/AppError.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- this is the standard Express augmentation pattern
  namespace Express {
    interface Request {
      claims?: AccessTokenClaims;
    }
  }
}

/**
 * Requires a valid `sb-access` cookie and attaches its verified claims to
 * `req.claims`. Throws `TokenExpiredError`/`TokenInvalidError` (via
 * `verifyAccessToken`), which the error middleware turns into a 401 — never
 * a 500, unlike the original app's dead `if (!decoded)` guard (D6).
 */
export const authenticate = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const token = readAccessToken(req);
    if (!token) {
      throw new UnauthorizedError("No session found");
    }
    req.claims = await verifyAccessToken(token);
    next();
  },
);

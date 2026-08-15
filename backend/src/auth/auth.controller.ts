import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import { UnauthorizedError } from "../errors/AppError.js";
import * as authService from "./auth.service.js";
import {
  clearSessionCookies,
  readAccessToken,
  readRefreshToken,
  setSessionCookies,
} from "./cookies.js";
import type { LoginInput, SignUpInput } from "./auth.schemas.js";

export const signUp = asyncHandler(async (req: Request, res: Response) => {
  const { email, password, fullName } = req.body as SignUpInput;
  const { session, user } = await authService.signUp(email, password, fullName);
  setSessionCookies(res, session);
  res.status(201).json({ id: user.id, email: user.email });
});

export const logIn = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body as LoginInput;
  const { session, user } = await authService.logIn(email, password);
  setSessionCookies(res, session);
  res.status(200).json({ id: user.id, email: user.email });
});

/**
 * Deliberately not gated behind `authenticate`: requiring a still-valid
 * access token to log out means a user whose token already expired could
 * not use this endpoint to clear a stale session. `sameSite: strict`
 * already prevents this from being a cross-site (CSRF) vector — the cookie
 * is never attached to a cross-origin request in the first place — so
 * there is nothing an auth gate would add here.
 */
export const logOut = asyncHandler(async (req: Request, res: Response) => {
  const accessToken = readAccessToken(req);
  if (accessToken) {
    await authService.logOut(accessToken);
  }
  clearSessionCookies(res);
  res.status(200).json({ message: "Logged out successfully" });
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const refreshToken = readRefreshToken(req);
  if (!refreshToken) {
    throw new UnauthorizedError("No session to refresh");
  }
  const { session, user } = await authService.refresh(refreshToken);
  setSessionCookies(res, session);
  res.status(200).json({ id: user.id, email: user.email });
});

/** `authenticate` has already verified the token and attached claims. */
export const check = asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json({ id: req.claims!.sub, email: req.claims!.email });
});

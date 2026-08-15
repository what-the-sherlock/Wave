import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  loginEmailLimiter,
  loginIpLimiter,
  refreshIpLimiter,
  signupIpLimiter,
} from "../middleware/rateLimit.js";
import * as authController from "./auth.controller.js";
import { loginSchema, signUpSchema } from "./auth.schemas.js";

export const authRouter = Router();

authRouter.post(
  "/signup",
  signupIpLimiter,
  validate({ body: signUpSchema }),
  authController.signUp,
);

authRouter.post(
  "/login",
  loginIpLimiter,
  loginEmailLimiter,
  validate({ body: loginSchema }),
  authController.logIn,
);

authRouter.post("/logout", authController.logOut);

authRouter.post("/refresh", refreshIpLimiter, authController.refresh);

authRouter.get("/check", authenticate, authController.check);

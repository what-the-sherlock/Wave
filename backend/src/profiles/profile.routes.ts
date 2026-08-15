import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as profileController from "./profile.controller.js";
import { updateProfileSchema } from "./profile.schemas.js";

export const profileRouter = Router();

profileRouter.use(authenticate);

profileRouter.get("/me", profileController.getMe);
profileRouter.put("/me", validate({ body: updateProfileSchema }), profileController.updateMe);

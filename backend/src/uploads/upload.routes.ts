import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { presignLimiter } from "../middleware/rateLimit.js";
import * as uploadController from "./upload.controller.js";
import { presignSchema } from "./upload.schemas.js";

/**
 * Standalone router, not nested under `workspaceRouter` —
 * `channelId` arrives in the body, not the URL, so there is no
 * `:workspaceId`/`:channelId` route param for `resolveWorkspace`/
 * `resolveChannel` to key off; `upload.service.ts` resolves membership
 * itself (docs/security-model.md §9).
 */
export const uploadRouter = Router();

uploadRouter.use(authenticate);

uploadRouter.post("/presign", presignLimiter, validate({ body: presignSchema }), uploadController.presign);
uploadRouter.get("/:attachmentId/download-url", uploadController.getDownload);

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import * as inviteController from "../workspaces/invite.controller.js";

/**
 * Token-scoped, not workspace-scoped — the caller is not yet a member, so
 * this deliberately lives on its own router rather than under
 * `workspaceRouter`, and is therefore correctly excluded from
 * `collectWorkspaceScopedRoutes`'s adversarial suite (docs/security-model.md
 * §7.2 only applies once membership is the thing being tested).
 */
export const inviteRouter = Router();

inviteRouter.use(authenticate);

inviteRouter.get("/:token", inviteController.preview);
inviteRouter.post("/:token/accept", inviteController.accept);

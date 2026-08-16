import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as notificationController from "./notification.controller.js";
import { listNotificationsQuerySchema } from "./notification.schemas.js";

/**
 * Top-level router, not nested under `workspaceRouter` — a notification
 * belongs to one workspace, but the bell/list the user sees is global across
 * every workspace they're in, and RLS's `notif_rw` policy (user_id =
 * auth.uid()) already scopes correctly without a :workspaceId in the URL.
 */
export const notificationRouter = Router();

notificationRouter.use(authenticate);

notificationRouter.get("/", validate({ query: listNotificationsQuerySchema }), notificationController.list);
notificationRouter.get("/unread-count", notificationController.unreadCount);
notificationRouter.post("/:notificationId/read", notificationController.markRead);
notificationRouter.post("/read-all", notificationController.markAllRead);

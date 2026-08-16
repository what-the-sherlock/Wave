import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { resolveWorkspace } from "../middleware/resolveWorkspace.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import * as workspaceController from "./workspace.controller.js";
import * as memberController from "./member.controller.js";
import * as inviteController from "./invite.controller.js";
import * as channelController from "../channels/channel.controller.js";
import * as searchController from "../search/search.controller.js";
import * as queueStatusController from "../queue/queueStatus.controller.js";
import { searchQuerySchema } from "../search/search.schemas.js";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  updateMemberRoleSchema,
  createInviteSchema,
} from "./workspace.schemas.js";
import { createChannelSchema, openDmSchema } from "../channels/channel.schemas.js";

/**
 * Every workspace-, member-, and invite-management route lives on this one
 * `Router` so `test/helpers/routeIntrospection.ts`'s
 * `collectWorkspaceScopedRoutes` can enumerate them all in a single pass —
 * a newly added endpoint is covered by the isolation suite automatically
 * (docs/security-model.md §7.2).
 *
 * Middleware order follows docs/target-architecture.md §7:
 * authenticate → resolveWorkspace → authorize(permission) → validate(zod).
 */
export const workspaceRouter = Router();

workspaceRouter.use(authenticate);

workspaceRouter.post("/", validate({ body: createWorkspaceSchema }), workspaceController.create);
workspaceRouter.get("/", workspaceController.listMine);
workspaceRouter.get("/by-slug/:slug", workspaceController.getBySlug);

workspaceRouter.get(
  "/:workspaceId",
  resolveWorkspace,
  authorize("workspace:read"),
  workspaceController.getById,
);
workspaceRouter.patch(
  "/:workspaceId",
  resolveWorkspace,
  authorize("workspace:update"),
  validate({ body: updateWorkspaceSchema }),
  workspaceController.update,
);

workspaceRouter.get(
  "/:workspaceId/members",
  resolveWorkspace,
  authorize("workspace:read"),
  memberController.list,
);
workspaceRouter.patch(
  "/:workspaceId/members/:userId",
  resolveWorkspace,
  authorize("member:update_role:below_admin"),
  validate({ body: updateMemberRoleSchema }),
  memberController.updateRole,
);
workspaceRouter.delete(
  "/:workspaceId/members/me",
  resolveWorkspace,
  memberController.leaveWorkspace,
);
workspaceRouter.delete(
  "/:workspaceId/members/:userId",
  resolveWorkspace,
  authorize("member:remove"),
  memberController.remove,
);

workspaceRouter.post(
  "/:workspaceId/invites",
  resolveWorkspace,
  authorize("member:invite"),
  validate({ body: createInviteSchema }),
  inviteController.create,
);
workspaceRouter.get(
  "/:workspaceId/invites",
  resolveWorkspace,
  authorize("member:invite"),
  inviteController.list,
);
workspaceRouter.delete(
  "/:workspaceId/invites/:inviteId",
  resolveWorkspace,
  authorize("member:invite"),
  inviteController.revoke,
);

workspaceRouter.post(
  "/:workspaceId/channels",
  resolveWorkspace,
  authorize("channel:create"),
  validate({ body: createChannelSchema }),
  channelController.create,
);
workspaceRouter.get(
  "/:workspaceId/channels",
  resolveWorkspace,
  authorize("channel:read"),
  channelController.list,
);

// Any confirmed workspace member may open a DM with another member — no
// finer-grained permission beyond membership itself (docs/security-model.md
// §4's PERMISSIONS table has no distinct dm:* entry).
workspaceRouter.post(
  "/:workspaceId/dms",
  resolveWorkspace,
  validate({ body: openDmSchema }),
  channelController.openDm,
);

// Phase 6: message search. No channel filter in the query itself — RLS's
// existing msg_select policy (is_channel_member) already scopes visible
// rows (docs/database-design.md §10).
workspaceRouter.get(
  "/:workspaceId/search",
  resolveWorkspace,
  authorize("workspace:read"),
  validate({ query: searchQuerySchema }),
  searchController.search,
);

// Phase 5: minimal admin-only queue-status endpoint. Reuses the existing
// OWNER/ADMIN-only permission rather than inventing a platform-superadmin
// concept the app otherwise has no use for.
workspaceRouter.get(
  "/:workspaceId/queue-status",
  resolveWorkspace,
  authorize("workspace:update"),
  queueStatusController.getStatus,
);

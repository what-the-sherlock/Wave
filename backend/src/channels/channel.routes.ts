import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { resolveChannel, requireChannelMembership } from "../middleware/resolveChannel.js";
import { validate } from "../middleware/validate.js";
import * as channelController from "./channel.controller.js";
import * as messageController from "./message.controller.js";
import {
  inviteToChannelSchema,
  listMessagesQuerySchema,
  markReadSchema,
  muteChannelSchema,
  reactionSchema,
  sendMessageSchema,
  updateChannelSchema,
  updateMessageSchema,
} from "./channel.schemas.js";

/**
 * Channel- and message-scoped routes, addressed by `:channelId` rather than
 * `:workspaceId` (docs/realtime-architecture.md §5's documented REST path),
 * so `resolveWorkspace`/`req.workspace` are not available here — permission
 * checks that need the actor's workspace role resolve it themselves inside
 * `channel.service.ts`/`message.service.ts` (see `getWorkspaceRoleInTx`).
 *
 * Every route here lives on this one `Router` so
 * `test/helpers/routeIntrospection.ts`'s `collectScopedRoutes` can enumerate
 * them all in one pass for the channel-isolation adversarial suite.
 */
export const channelRouter = Router();

channelRouter.use(authenticate);

channelRouter.get("/:channelId", resolveChannel, channelController.getById);
channelRouter.patch(
  "/:channelId",
  resolveChannel,
  requireChannelMembership,
  validate({ body: updateChannelSchema }),
  channelController.update,
);
channelRouter.delete("/:channelId", resolveChannel, requireChannelMembership, channelController.archive);

channelRouter.post("/:channelId/join", resolveChannel, channelController.join);
channelRouter.patch(
  "/:channelId/members/me",
  resolveChannel,
  requireChannelMembership,
  validate({ body: muteChannelSchema }),
  channelController.updateMyMembership,
);
channelRouter.delete(
  "/:channelId/members/me",
  resolveChannel,
  requireChannelMembership,
  channelController.leave,
);
channelRouter.get(
  "/:channelId/members",
  resolveChannel,
  requireChannelMembership,
  channelController.listMembers,
);
channelRouter.post(
  "/:channelId/members",
  resolveChannel,
  requireChannelMembership,
  validate({ body: inviteToChannelSchema }),
  channelController.inviteMember,
);
channelRouter.delete(
  "/:channelId/members/:userId",
  resolveChannel,
  requireChannelMembership,
  channelController.removeMember,
);

channelRouter.get(
  "/:channelId/messages",
  resolveChannel,
  requireChannelMembership,
  validate({ query: listMessagesQuerySchema }),
  messageController.list,
);
channelRouter.post(
  "/:channelId/messages",
  resolveChannel,
  requireChannelMembership,
  validate({ body: sendMessageSchema }),
  messageController.send,
);
channelRouter.patch(
  "/:channelId/messages/:messageId",
  resolveChannel,
  requireChannelMembership,
  validate({ body: updateMessageSchema }),
  messageController.update,
);
channelRouter.delete(
  "/:channelId/messages/:messageId",
  resolveChannel,
  requireChannelMembership,
  messageController.remove,
);
channelRouter.get(
  "/:channelId/messages/:messageId/thread",
  resolveChannel,
  requireChannelMembership,
  messageController.listThread,
);
channelRouter.post(
  "/:channelId/messages/:messageId/reactions",
  resolveChannel,
  requireChannelMembership,
  validate({ body: reactionSchema }),
  messageController.addReaction,
);

channelRouter.post(
  "/:channelId/read",
  resolveChannel,
  requireChannelMembership,
  validate({ body: markReadSchema }),
  messageController.markRead,
);

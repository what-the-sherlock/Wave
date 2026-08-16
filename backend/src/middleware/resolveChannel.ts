import type { NextFunction, Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import { ForbiddenError, NotFoundError } from "../errors/AppError.js";
import * as channelService from "../channels/channel.service.js";
import type { Channel, ChannelMembershipInfo, ChannelPeer } from "../channels/channel.service.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- standard Express augmentation pattern
  namespace Express {
    interface Request {
      channel?: Channel & { membership: ChannelMembershipInfo | null; dmPeer: ChannelPeer | null };
    }
  }
}

/**
 * RLS's `can_read_channel` already scopes visibility (public channels are
 * discoverable workspace-wide even before joining; private/DM channels only
 * for members), so a channel that doesn't resolve here is indistinguishable
 * from one that doesn't exist — 404, never 403 (docs/security-model.md §4).
 */
export const resolveChannel = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const channelId = req.params.channelId;
    if (!channelId) {
      throw new NotFoundError("Channel not found");
    }
    const result = await channelService.getChannelForUser(req.claims!.sub, channelId);
    if (!result) {
      throw new NotFoundError("Channel not found");
    }
    req.channel = { ...result.channel, membership: result.membership, dmPeer: result.dmPeer };
    next();
  },
);

/**
 * A public channel is discoverable without joining, but its *messages*
 * require membership — browsing a public channel joins you to it, an
 * explicit product decision encoded here rather than in RLS
 * (docs/database-design.md §5.2's note on msg_select vs can_read_channel).
 */
export function requireChannelMembership(req: Request, _res: Response, next: NextFunction): void {
  if (!req.channel?.membership) {
    throw new ForbiddenError("Join this channel first");
  }
  next();
}

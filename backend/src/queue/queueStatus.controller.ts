import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import { withServiceRoleScope } from "../db/rlsScope.js";
import * as queueStatusRepo from "./queueStatus.repository.js";

/** Admin-only (authorize("workspace:update"), OWNER/ADMIN — see
 * workspace.routes.ts). JSON only, deliberately no dashboard UI
 * (docs/implementation-roadmap.md Phase 5, "minimal queue-status admin
 * page"). */
export const getStatus = asyncHandler(async (_req: Request, res: Response) => {
  const counts = await withServiceRoleScope((tx) => queueStatusRepo.getQueueCounts(tx));
  res.status(200).json({ counts });
});

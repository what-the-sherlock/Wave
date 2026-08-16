import type { NextFunction, Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import { NotFoundError } from "../errors/AppError.js";
import * as workspaceService from "../workspaces/workspace.service.js";
import type { Workspace, WorkspaceRole } from "../workspaces/workspace.service.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- standard Express augmentation pattern
  namespace Express {
    interface Request {
      workspace?: Workspace & { role: WorkspaceRole };
    }
  }
}

/**
 * RLS already filters `workspaces`/`workspace_members` to member-visible
 * rows, so a non-member's lookup naturally returns nothing — no separate
 * permission check is needed for read access, and the 404 that results
 * never confirms whether the workspace exists at all (docs/security-model.md
 * §4, the same convention `NotFoundError` documents on the shared workspace
 * `profiles` visibility).
 */
export const resolveWorkspace = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const workspaceId = req.params.workspaceId;
    if (!workspaceId) {
      throw new NotFoundError("Workspace not found");
    }
    const result = await workspaceService.getByIdForUser(req.claims!.sub, workspaceId);
    if (!result) {
      throw new NotFoundError("Workspace not found");
    }
    req.workspace = { ...result.workspace, role: result.role };
    next();
  },
);

import type { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "../errors/AppError.js";
import { hasPermission } from "../authz/permissions.js";

/**
 * Only reachable after `resolveWorkspace`, so a 403 thrown here always means
 * "confirmed member of this workspace, lacking this specific permission" —
 * never used to signal "you're not a member," which is `resolveWorkspace`'s
 * 404 (docs/security-model.md §4).
 */
export function authorize(permission: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.workspace || !hasPermission(req.workspace.role, permission)) {
      throw new ForbiddenError(`Missing permission: ${permission}`);
    }
    next();
  };
}

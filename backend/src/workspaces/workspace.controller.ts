import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import { NotFoundError } from "../errors/AppError.js";
import * as workspaceService from "./workspace.service.js";
import type { Workspace, WorkspaceRole } from "./workspace.service.js";
import type { CreateWorkspaceBody, UpdateWorkspaceBody, UpdateAiSettingsBody } from "./workspace.schemas.js";

function toDto(workspace: Workspace, role: WorkspaceRole) {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    iconUrl: workspace.iconUrl,
    memberCount: workspace.memberCount,
    settings: workspace.settings,
    role,
    createdAt: workspace.createdAt,
  };
}

export const create = asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.body as CreateWorkspaceBody;
  const { workspace, role } = await workspaceService.createWorkspace(req.claims!.sub, name);
  res.status(201).json(toDto(workspace, role));
});

export const listMine = asyncHandler(async (req: Request, res: Response) => {
  const rows = await workspaceService.listMyWorkspaces(req.claims!.sub);
  res.status(200).json(rows.map(({ workspace, role }) => toDto(workspace, role)));
});

export const getBySlug = asyncHandler(async (req: Request, res: Response) => {
  const slug = req.params.slug!;
  const result = await workspaceService.getBySlugForUser(req.claims!.sub, slug);
  if (!result) {
    throw new NotFoundError("Workspace not found");
  }
  res.status(200).json(toDto(result.workspace, result.role));
});

export const getById = asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json(toDto(req.workspace!, req.workspace!.role));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const patch = req.body as UpdateWorkspaceBody;
  const workspace = await workspaceService.updateSettings(req.claims!.sub, req.workspace!.id, patch);
  res.status(200).json(toDto(workspace, req.workspace!.role));
});

export const updateAiSettings = asyncHandler(async (req: Request, res: Response) => {
  const { aiEnabled } = req.body as UpdateAiSettingsBody;
  const workspace = await workspaceService.updateAiEnabled(req.claims!.sub, req.workspace!.id, aiEnabled);
  res.status(200).json(toDto(workspace, req.workspace!.role));
});

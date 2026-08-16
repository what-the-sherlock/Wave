import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import * as inviteService from "./invite.service.js";
import type { Invite } from "./invite.service.js";
import type { CreateInviteBody } from "./workspace.schemas.js";

function toDto(invite: Invite) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    maxUses: invite.maxUses,
    useCount: invite.useCount,
    expiresAt: invite.expiresAt,
    revokedAt: invite.revokedAt,
    createdAt: invite.createdAt,
  };
}

export const create = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as CreateInviteBody;
  const { invite, token } = await inviteService.createInvite(req.claims!.sub, req.workspace!.id, body);
  res.status(201).json({ ...toDto(invite), token });
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const invites = await inviteService.listInvites(req.claims!.sub, req.workspace!.id);
  res.status(200).json(invites.map(toDto));
});

export const revoke = asyncHandler(async (req: Request, res: Response) => {
  await inviteService.revokeInvite(req.claims!.sub, req.workspace!.id, req.params.inviteId!);
  res.status(204).send();
});

export const preview = asyncHandler(async (req: Request, res: Response) => {
  const result = await inviteService.previewInvite(req.claims!.sub, req.params.token!);
  res.status(200).json(result);
});

export const accept = asyncHandler(async (req: Request, res: Response) => {
  const result = await inviteService.acceptInvite(req.claims!.sub, req.params.token!);
  res.status(200).json(result);
});

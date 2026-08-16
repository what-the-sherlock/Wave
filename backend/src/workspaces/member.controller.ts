import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import * as memberService from "./member.service.js";
import type { MemberWithProfile } from "./member.service.js";
import type { UpdateMemberRoleBody } from "./workspace.schemas.js";

function toDto(member: MemberWithProfile) {
  return {
    userId: member.userId,
    fullName: member.fullName,
    avatarUrl: member.avatarUrl,
    displayName: member.displayName,
    role: member.role,
    joinedAt: member.joinedAt,
  };
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const members = await memberService.listMembers(req.claims!.sub, req.workspace!.id);
  res.status(200).json(members.map(toDto));
});

export const updateRole = asyncHandler(async (req: Request, res: Response) => {
  const { role } = req.body as UpdateMemberRoleBody;
  await memberService.updateRole(
    req.claims!.sub,
    req.workspace!.role,
    req.workspace!.id,
    req.params.userId!,
    role,
  );
  res.status(204).send();
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await memberService.removeMember(
    req.claims!.sub,
    req.workspace!.role,
    req.workspace!.id,
    req.params.userId!,
  );
  res.status(204).send();
});

export const leaveWorkspace = asyncHandler(async (req: Request, res: Response) => {
  await memberService.leave(req.claims!.sub, req.workspace!.id);
  res.status(204).send();
});

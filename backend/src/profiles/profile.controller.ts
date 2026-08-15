import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import * as profileService from "./profile.service.js";
import type { Profile } from "./profile.service.js";
import type { UpdateProfileBody } from "./profile.schemas.js";

function toDto(profile: Profile) {
  return {
    id: profile.id,
    fullName: profile.fullName,
    avatarUrl: profile.avatarUrl,
    timezone: profile.timezone,
  };
}

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const profile = await profileService.getOwnProfile(req.claims!.sub);
  res.status(200).json(toDto(profile));
});

export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  const patch = req.body as UpdateProfileBody;
  const profile = await profileService.updateOwnProfile(req.claims!.sub, patch);
  res.status(200).json(toDto(profile));
});

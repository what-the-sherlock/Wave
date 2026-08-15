import { withRlsScope } from "../db/rlsScope.js";
import { NotFoundError } from "../errors/AppError.js";
import * as profileRepo from "./profile.repository.js";
import type { Profile, ProfilePatch } from "./profile.repository.js";

export type { Profile } from "./profile.repository.js";

export async function getOwnProfile(userId: string): Promise<Profile> {
  return withRlsScope({ userId }, async (tx) => {
    const profile = await profileRepo.findById(tx, userId);
    if (!profile) {
      // Can legitimately happen for an instant right after signup if the
      // `handle_new_user` trigger's insert hasn't been visible yet, or —
      // should not happen otherwise, since the trigger is the only writer.
      throw new NotFoundError("Profile not found");
    }
    return profile;
  });
}

export async function updateOwnProfile(userId: string, patch: ProfilePatch): Promise<Profile> {
  return withRlsScope({ userId }, async (tx) => {
    const profile = await profileRepo.update(tx, userId, patch);
    if (!profile) {
      throw new NotFoundError("Profile not found");
    }
    return profile;
  });
}

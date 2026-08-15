import { eq } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { profiles } from "../db/schema.js";
import type { Profile } from "../db/schema.js";

export type { Profile, NewProfile } from "../db/schema.js";

/**
 * The only module (besides `db/**`) permitted to import the drizzle
 * client/schema directly — enforced by `eslint.config.js`. Every query in
 * the codebase is constructed here, which is what makes "does this query
 * carry a workspace filter?" (from Phase 2 onward) answerable by reading
 * one directory instead of auditing every handler.
 */

export async function findById(tx: Tx, userId: string): Promise<Profile | undefined> {
  const [row] = await tx.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
  return row;
}

export type ProfilePatch = Partial<Pick<Profile, "fullName" | "timezone">>;

export async function update(
  tx: Tx,
  userId: string,
  patch: ProfilePatch,
): Promise<Profile | undefined> {
  const [row] = await tx
    .update(profiles)
    .set(patch)
    .where(eq(profiles.id, userId))
    .returning();
  return row;
}

import { z } from "zod";

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
});
export type CreateWorkspaceBody = z.infer<typeof createWorkspaceSchema>;

/**
 * Slug is deliberately absent — it's server-generated at creation time and
 * immutable afterward, so links never break out from under an existing
 * workspace (docs/implementation-roadmap.md Phase 2 plan).
 */
export const updateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    iconUrl: z.string().trim().url().nullable().optional(),
    settings: z
      .object({
        allowPublicInvites: z.boolean().optional(),
        aiEnabled: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdateWorkspaceBody = z.infer<typeof updateWorkspaceSchema>;

/** OWNER is never an assignable target — ownership transfer is cut for v1. */
export const updateMemberRoleSchema = z.object({
  role: z.enum(["ADMIN", "MEMBER"]),
});
export type UpdateMemberRoleBody = z.infer<typeof updateMemberRoleSchema>;

export const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().optional(),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresInDays: z.number().int().min(1).max(30).optional(),
});
export type CreateInviteBody = z.infer<typeof createInviteSchema>;

import { z } from "zod";

/**
 * `avatarUrl` is deliberately not editable here — there is no upload
 * mechanism until Supabase Storage lands in Phase 6, and accepting an
 * arbitrary client-supplied URL as "your avatar" with nothing backing it
 * would be a half-built feature rather than a real one.
 */
export const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(1, "Full name is required").max(80).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateProfileBody = z.infer<typeof updateProfileSchema>;

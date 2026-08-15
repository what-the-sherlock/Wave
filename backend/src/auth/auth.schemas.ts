import { z } from "zod";
import { isCommonPassword } from "./commonPasswords.js";

const emailSchema = z.string().trim().toLowerCase().email("Invalid email address");

const newPasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters")
  .refine((pw) => !isCommonPassword(pw), {
    message: "This password is too common. Please choose a stronger one.",
  });

export const signUpSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required").max(80, "Full name is too long"),
  email: emailSchema,
  password: newPasswordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  // Deliberately not re-validated for strength/commonality here — this is
  // an existing account's password, and Supabase's own credential check is
  // the authority. Rejecting a valid existing password locally would be a
  // usability bug, not a security improvement.
  password: z.string().min(1, "Password is required"),
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

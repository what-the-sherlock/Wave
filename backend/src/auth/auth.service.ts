import * as supabaseAuth from "./supabaseAuthClient.js";
import type { AuthResult } from "./supabaseAuthClient.js";

/**
 * Thin today — Phase 1 auth is entirely Supabase's job
 * (docs/target-architecture.md §6). This seam is where Phase 2+ logic that
 * genuinely belongs to *us* will land (e.g. ensuring a personal workspace
 * exists after signup), kept separate from the controller per the
 * routes → controllers → services → repositories layering (D15).
 */

export async function signUp(email: string, password: string, fullName: string): Promise<AuthResult> {
  return supabaseAuth.signUp(email, password, fullName);
}

export async function logIn(email: string, password: string): Promise<AuthResult> {
  return supabaseAuth.signInWithPassword(email, password);
}

export async function refresh(refreshToken: string): Promise<AuthResult> {
  return supabaseAuth.refreshSession(refreshToken);
}

export async function logOut(accessToken: string): Promise<void> {
  return supabaseAuth.signOut(accessToken);
}

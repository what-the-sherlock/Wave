import { z } from "zod";

/**
 * The most dangerous credential in the system: it bypasses Row-Level
 * Security entirely (docs/security-model.md §5, docs/database-design.md
 * §5.3). This module must never be imported from an HTTP request path —
 * `eslint.config.js` enforces that structurally via `no-restricted-imports`,
 * the same technique `db/client.ts` uses to keep raw table access confined
 * to repositories.
 *
 * As of Phase 1 nothing imports this yet (the worker arrives in Phase 5).
 * It is validated now so the shape of the boundary exists from day one
 * rather than being retrofitted once something actually needs it.
 */
const schema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(20, "SUPABASE_SERVICE_ROLE_KEY looks too short to be real"),
});

export type PrivilegedConfig = Readonly<{
  SUPABASE_SERVICE_ROLE_KEY: string;
}>;

export function loadPrivilegedConfig(
  source: NodeJS.ProcessEnv = process.env,
): PrivilegedConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid privileged configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}

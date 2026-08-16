// @ts-check
import tseslint from "typescript-eslint";

/**
 * Two structural rules are enforced here, not just documented:
 *
 * 1. Only `src/db/**`, `**\/*.repository.ts`, and tests may import the raw
 *    drizzle client/schema. Everything else must go through a repository.
 *    See docs/target-architecture.md §7.
 * 2. Only the worker entrypoint and tests may import the privileged
 *    (service_role) config. The HTTP-serving code path must never see it.
 *    See docs/security-model.md §5.
 */
const restrictedDbImport = {
  group: ["**/db/client*", "**/db/schema*"],
  message:
    "Only repositories (**/*.repository.ts) may import the db client/schema directly. " +
    "Add a repository method instead — see docs/target-architecture.md §7.",
};

const restrictedPrivilegedImport = {
  group: ["**/config/privileged*"],
  message:
    "The privileged (service_role) config must never be reachable from the HTTP " +
    "request path. Only the worker entrypoint may import it — see docs/security-model.md §5.",
};

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-imports": [
        "error",
        { patterns: [restrictedDbImport, restrictedPrivilegedImport] },
      ],
    },
  },
  {
    // The db layer and repositories may import the client/schema directly —
    // that restriction lifts here, but the privileged-config restriction
    // stays on: a repository still must not reach for service_role.
    files: ["src/db/**/*.ts", "src/**/*.repository.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [restrictedPrivilegedImport] },
      ],
    },
  },
  {
    // The composition root needs `closeDb()` for graceful shutdown — pool
    // lifecycle management, not a query, so this is a narrow and
    // legitimate exception rather than a weakening of the rule. The
    // privileged-config restriction stays on.
    files: ["src/server.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [restrictedPrivilegedImport] },
      ],
    },
  },
  {
    // Job handlers act on behalf of the system, not a single user's RLS
    // scope — the same bounded, deliberate bypass docs/security-model.md §5
    // describes (see db/rlsScope.ts's withServiceRoleScope). Some workers
    // (attachment.process) also need the raw service_role key itself, to
    // call Supabase Storage's REST API directly. The db-client restriction
    // stays on: workers still go through repositories, never raw queries
    // outside them.
    files: ["src/queue/workers/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [restrictedDbImport] }],
    },
  },
  {
    // Tests exercise both restricted modules directly to verify their
    // behaviour, so both restrictions lift here.
    files: ["test/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);

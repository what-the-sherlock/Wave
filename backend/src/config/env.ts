import { z } from "zod";

/**
 * Public application configuration. Validated eagerly so a missing or
 * malformed variable crashes the process at boot instead of surfacing as a
 * confusing 500 on the first request that needs it — the original app's
 * `PORT` had no fallback and `JWT_SECRET` was never validated at all
 * (docs/current-architecture.md §8, §9).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(5001),

  // Supavisor transaction-mode pooler connection (docs/scalability.md §2).
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
      message: "DATABASE_URL must be a postgres:// connection string",
    }),

  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_ANON_KEY: z.string().min(20, "SUPABASE_ANON_KEY looks too short to be real"),

  // HS256 shared secret used by local `supabase start` and most hosted
  // projects. When absent, JWT verification falls back to remote JWKS
  // (docs/realtime-architecture.md §2, docs/target-architecture.md §6).
  SUPABASE_JWT_SECRET: z.string().min(16).optional(),

  COOKIE_DOMAIN: z.string().optional(),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),

  // Invite emails are best-effort and fully optional (docs/implementation-
  // roadmap.md Phase 2 — deliberate deviation from the literal roadmap
  // text): the shareable invite link always works with neither of these
  // set. When both are present, invite.service attempts to send via
  // Resend's HTTP API and logs+ignores any failure. Mirrors the
  // SUPABASE_JWT_SECRET optional-fallback pattern already in this file.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // Phase 5: notification emails are a distinct, separately-flagged concern
  // from invite emails above — built and tested, shipped off by default
  // because sending from a custom address needs a verified domain a
  // personal project may not have (docs/free-tier-plan.md §6).
  FEATURE_EMAIL: z.coerce.boolean().default(false),

  // Phase 5: gates whether this process starts pg-boss and registers its
  // job handlers. Same process by default (docs/free-tier-plan.md §5) —
  // splitting workers into a second deployment later is a config change,
  // not a code change.
  RUN_WORKERS: z.coerce.boolean().default(false),

  // pg-boss's polling/maintenance loop needs a session-pinned connection —
  // it will not work through Supavisor's transaction-mode pooler. Falls
  // back to DATABASE_URL, which is correct locally (no pooler running) but
  // must be overridden to a direct/session-mode connection in production.
  PGBOSS_DATABASE_URL: z.string().optional(),

  // Phase 6: enforced both at the zod schema layer (upload.schemas.ts) and
  // by the storage bucket's own file_size_limit (belt and suspenders).
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(5),

  // Phase 7: optional, same pattern as RESEND_API_KEY — every AI feature
  // degrades gracefully (503, never a 500 or a crash) when it's unset,
  // rather than failing boot, since AI is a per-workspace opt-in leaf
  // dependency (docs/ai-architecture.md §1). Verified against Groq's
  // current model list (2026-08): llama-3.3-70b-versatile was deprecated
  // for free/developer tier on 2026-06-17; openai/gpt-oss-120b is the
  // current default (30 RPM / 1K RPD / 8K TPM free tier — confirms the
  // ~6k input token budget in docs/free-tier-plan.md §4).
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  AI_DAILY_REQUEST_CAP: z.coerce.number().int().positive().default(500),
  // Xenova/bge-small-en-v1.5 → 384 dims, matching message_embeddings'
  // halfvec(384) column (docs/database-design.md §11). Changing this
  // requires a re-embedding backfill, not just a config flip.
  EMBEDDING_MODEL: z.string().default("Xenova/bge-small-en-v1.5"),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type AppConfig = Readonly<{
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  DATABASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_JWT_SECRET: string | undefined;
  COOKIE_DOMAIN: string | undefined;
  CORS_ORIGINS: readonly string[];
  RESEND_API_KEY: string | undefined;
  EMAIL_FROM: string | undefined;
  FEATURE_EMAIL: boolean;
  RUN_WORKERS: boolean;
  PGBOSS_DATABASE_URL: string;
  MAX_UPLOAD_MB: number;
  GROQ_API_KEY: string | undefined;
  GROQ_MODEL: string;
  AI_DAILY_REQUEST_CAP: number;
  EMBEDDING_MODEL: string;
  LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  isProduction: boolean;
  isTest: boolean;
  /** Cookies get `secure: true` outside local development. */
  secureCookies: boolean;
}>;

export class ConfigError extends Error {
  constructor(issues: string) {
    super(`Invalid environment configuration:\n${issues}`);
    this.name = "ConfigError";
  }
}

/**
 * Parses and validates configuration from the given source (defaults to
 * `process.env`). Exposed as a function — rather than only a module-level
 * singleton — so tests can construct a config from an arbitrary env object
 * without mutating global state.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(issues);
  }

  const data = parsed.data;
  const corsOrigins = data.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (corsOrigins.length === 0) {
    throw new ConfigError("  - CORS_ORIGINS: must contain at least one origin");
  }

  return Object.freeze({
    NODE_ENV: data.NODE_ENV,
    PORT: data.PORT,
    DATABASE_URL: data.DATABASE_URL,
    SUPABASE_URL: data.SUPABASE_URL,
    SUPABASE_ANON_KEY: data.SUPABASE_ANON_KEY,
    SUPABASE_JWT_SECRET: data.SUPABASE_JWT_SECRET,
    COOKIE_DOMAIN: data.COOKIE_DOMAIN,
    CORS_ORIGINS: Object.freeze(corsOrigins),
    RESEND_API_KEY: data.RESEND_API_KEY,
    EMAIL_FROM: data.EMAIL_FROM,
    FEATURE_EMAIL: data.FEATURE_EMAIL,
    RUN_WORKERS: data.RUN_WORKERS,
    // Locally there is no pooler (DATABASE_URL already points at the direct
    // connection on 54322), so the fallback is correct as-is. In production,
    // PGBOSS_DATABASE_URL must be set explicitly to a direct/session-mode
    // connection, not the Supavisor transaction-mode pooler.
    PGBOSS_DATABASE_URL: data.PGBOSS_DATABASE_URL ?? data.DATABASE_URL,
    MAX_UPLOAD_MB: data.MAX_UPLOAD_MB,
    GROQ_API_KEY: data.GROQ_API_KEY,
    GROQ_MODEL: data.GROQ_MODEL,
    AI_DAILY_REQUEST_CAP: data.AI_DAILY_REQUEST_CAP,
    EMBEDDING_MODEL: data.EMBEDDING_MODEL,
    LOG_LEVEL: data.LOG_LEVEL,
    isProduction: data.NODE_ENV === "production",
    isTest: data.NODE_ENV === "test",
    // Only "production" — not merely "not development". Automated tests
    // (and this is the part worth stating explicitly: most real staging
    // deployments too, unless they terminate TLS) run over plain HTTP, and
    // a `Secure`-flagged cookie is silently dropped by any HTTP client
    // over a non-TLS connection. Tying this to "production only" is what
    // makes cookie-based auth testable with supertest at all.
    secureCookies: data.NODE_ENV === "production",
  });
}

/**
 * Process-wide config singleton. Importing this module is what makes a
 * missing env var fatal at boot — evaluated once, at import time.
 */
export const config: AppConfig = loadConfig();

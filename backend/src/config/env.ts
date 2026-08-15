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

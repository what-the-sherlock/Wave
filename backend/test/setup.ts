import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Best-effort: picks up real local Supabase credentials if backend/.env
// exists (populated by running `supabase start` — see .env.example), so a
// developer who has it running gets real integration test runs. Silently
// does nothing on a fresh clone.
loadDotenv({ path: path.resolve(__dirname, "../.env") });

// Fallbacks so `config/env.ts`'s eager validation always succeeds — every
// test file transitively imports it via `app.ts`. These are schema-valid
// but non-functional; integration tests that need a *reachable* database
// or auth service check for that explicitly via test/helpers/db.ts and
// self-skip rather than fail when it's absent.
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:54322/postgres";
process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_ANON_KEY ??= "unit-test-placeholder-anon-key-0000000000000000";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "unit-test-placeholder-service-role-key-00000000000";
process.env.CORS_ORIGINS ??= "http://localhost:5173";
process.env.LOG_LEVEL ??= "silent";

// SUPABASE_JWT_SECRET is deliberately NOT given a fallback here. Current
// Supabase (including local `supabase start`) signs tokens with an
// asymmetric key by default, so `verifyAccessToken` must take the
// remote-JWKS path in every test file *except* the ones specifically
// testing the HS256 path — those set and clean up the env var themselves
// via `vi.resetModules()` (see test/unit/jwt.test.ts) so the mutation
// cannot leak into other test files sharing this worker process.

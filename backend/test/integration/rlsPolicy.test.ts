import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { withRlsScope } from "../../src/db/rlsScope.js";
import { profiles } from "../../src/db/schema.js";
import { makeTestApp } from "../helpers/testApp.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

/**
 * These tests exercise Row-Level Security directly, independent of the
 * HTTP layer — proving the *database* enforces isolation, not just that
 * our application code happens to filter correctly. This is the core claim
 * of docs/security-model.md §0: "can a user access data belonging to
 * someone else?" must be provably no, and provable means a test that would
 * still fail even if every repository method were rewritten to forget its
 * scope filter.
 */
describe.skipIf(!liveStackAvailable)("Row-Level Security (integration, live Supabase)", () => {
  const app = makeTestApp();
  const adminPool = new Pool({ connectionString: process.env.DATABASE_URL! });

  afterAll(async () => {
    await adminPool.end();
  });

  it("every table in the public schema has RLS enabled — a default-deny CI gate", async () => {
    const { rows } = await adminPool.query<{ tablename: string }>(
      `select tablename from pg_tables t
        where schemaname = 'public'
          and not exists (
            select 1 from pg_class c
             where c.relname = t.tablename and c.relrowsecurity = true
          )`,
    );
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });

  it("auth.uid() resolves to whichever user withRlsScope was called for", async () => {
    const client = await adminPool.connect();
    try {
      const userId = "01234567-89ab-4cde-8123-456789abcdef";
      await client.query("BEGIN");
      await client.query(`select set_config('role', 'authenticated', true)`);
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      const { rows } = await client.query<{ uid: string }>("select auth.uid() as uid");
      await client.query("ROLLBACK");
      expect(rows[0]?.uid).toBe(userId);
    } finally {
      client.release();
    }
  });

  it("a user can select only their own profile row via RLS, never another user's", async () => {
    const userA = await signUpTestUser(app);
    const userB = await signUpTestUser(app);

    const rowsForA = await withRlsScope({ userId: userA.id }, (tx) =>
      tx.select().from(profiles),
    );

    expect(rowsForA).toHaveLength(1);
    expect(rowsForA[0]?.id).toBe(userA.id);
    expect(rowsForA.some((r) => r.id === userB.id)).toBe(false);
  });

  it("an update targeting another user's row affects zero rows — RLS filters silently rather than erroring", async () => {
    const userA = await signUpTestUser(app);
    const userB = await signUpTestUser(app, { fullName: "Original Name" });

    const result = await withRlsScope({ userId: userA.id }, (tx) =>
      tx
        .update(profiles)
        .set({ fullName: "Hacked By A" })
        .where(eq(profiles.id, userB.id))
        .returning(),
    );

    expect(result).toHaveLength(0);

    const bStillIntact = await withRlsScope({ userId: userB.id }, (tx) =>
      tx.select().from(profiles).where(eq(profiles.id, userB.id)),
    );
    expect(bStillIntact[0]?.fullName).toBe("Original Name");
  });

  it(
    "pooled-connection scope does not leak between interleaved requests " +
      "(docs/security-model.md §4 — the exact pattern transaction-mode pooling risks)",
    async () => {
      const userA = await signUpTestUser(app);
      const userB = await signUpTestUser(app);

      const [rowsForA, rowsForB] = await Promise.all([
        withRlsScope({ userId: userA.id }, (tx) => tx.select().from(profiles)),
        withRlsScope({ userId: userB.id }, (tx) => tx.select().from(profiles)),
      ]);

      expect(rowsForA.map((r) => r.id)).toEqual([userA.id]);
      expect(rowsForB.map((r) => r.id)).toEqual([userB.id]);
    },
  );

  it("a user with no session (anon) cannot read any profile row, one way or another", async () => {
    // Two environments, two equally-secure failure shapes: local Postgres
    // has no GRANT for `anon` at all (query throws "permission denied"
    // before RLS is even consulted), while a real hosted project has
    // Supabase's platform-level default grant for `anon` already in place
    // — so the query succeeds, but RLS still filters it to zero rows. Both
    // guarantee the same thing (anon reads nothing); only the shape of
    // that guarantee differs, so this accepts either.
    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`select set_config('role', 'anon', true)`);
      try {
        const { rows } = await client.query("select * from public.profiles");
        expect(rows).toHaveLength(0);
      } catch (err) {
        expect((err as Error).message).toMatch(/permission denied/i);
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

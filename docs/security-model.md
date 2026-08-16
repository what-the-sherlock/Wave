# wave — Security Model

> Greenfield build on Supabase/Postgres. Debt IDs (D1–D25) refer to
> [current-architecture.md](./current-architecture.md) §9 — design lessons from the original
> code, not live bugs.

---

## 0. The core requirement

> **Can a user from Workspace A access data belonging to Workspace B?**

The answer must be provably no. In the MongoDB plan, "provably" meant an adversarial test suite
compensating for a database that could not enforce isolation. **With Postgres RLS, the database
enforces it** — and the test suite verifies the policies rather than substituting for them.

That is the single biggest security consequence of the stack change: the failure mode of a
handler that forgets its tenant filter changes from **data leak** to **empty result set**.

---

## 1. Defence in depth

```text
Layer 0 — SUPABASE AUTH        identity, password hashing, verification, reset, OAuth
                               (we do not implement any of it)
Layer 1 — HTTPONLY COOKIE      token unreadable by JS; sameSite=strict kills CSRF
Layer 2 — MIDDLEWARE           authenticate → withRlsScope → authorize(permission)
Layer 3 — POSTGRES RLS  ★      the database returns only rows this user may read
Layer 4 — ADVERSARIAL TESTS    cross-tenant probes in CI, gating merges
```

**Layer 3 is the one that holds.** Layers 2 and 4 are depth and verification.

---

## 2. Authentication

### Supabase Auth behind an Express proxy

Design and rationale: [target-architecture.md](./target-architecture.md) §6.

**What we no longer write** — and therefore no longer get wrong: password hashing and cost
tuning, refresh-token rotation with reuse detection, email verification, password reset tokens,
OAuth flows, and timing-safe credential comparison. The original code had defects in several of
these (D10 token-before-save, a dead `minlength` validator, a 6-character minimum).

**What we still own:**

| Concern | Our responsibility |
|---|---|
| Token transport | `httpOnly` + `sameSite=strict` + `secure` cookies set by Express |
| JWT verification | Signature via Supabase JWKS (asymmetric), `iss` and `exp` checked |
| Refresh timing | Server-side refresh near expiry; cookies rotated transparently |
| Socket auth | Same cookie, verified at handshake ([realtime-architecture.md](./realtime-architecture.md) §2) |
| Rate limiting | Our own limits on the proxy endpoints, on top of Supabase's |
| Logout | Revoke the Supabase session **and** clear cookies with matching attributes (D18) |

**Why proxy rather than use `supabase-js` in the browser.** The default SPA pattern stores the
session in `localStorage`, where any XSS can read it. The cookie approach keeps the token out of
JavaScript entirely and gives the socket handshake a credential it can verify — the thing the
original app got right ([current-architecture.md](./current-architecture.md) §10) and worth
preserving.

**The refresh cookie is scoped** `path=/api/v1/auth/refresh`, so it is not attached to ordinary
API requests and not exposed to every handler, proxy log, or error report.

**Session revocation.** Logout calls Supabase's sign-out (invalidating the refresh token) and
clears both cookies. Access tokens remain valid until expiry (~1h) — bounded and acceptable.
For immediate revocation on compromise, Supabase's "sign out all sessions" is called and
`io.in('u:'+userId).disconnectSockets()` drops live sockets in the same operation.

### Rate limiting

Supabase rate-limits its own auth endpoints, but our proxy is the public surface and needs its
own limits. **In-process**, because the deployment is a single instance
([free-tier-plan.md](./free-tier-plan.md) §5); Redis-backed if a second instance is ever added,
since per-instance limits would otherwise be N× too permissive.

| Endpoint | Limit |
|---|---|
| `POST /auth/login` | 5/15min per IP **and** 10/hour per email |
| `POST /auth/signup` | 3/hour per IP |
| `POST /auth/reset` | 3/hour per email |
| `POST /auth/refresh` | 30/hour per user |
| messages write | 30/min per user |
| upload presign | 20/hour per user |
| AI endpoints | 20/hour per user, 500/day per workspace |
| global API | 300/min per user |

Progressive lockout keyed on **both** IP and account, so neither dimension alone can lock out a
victim. The in-process limiter for early phases is per-instance and therefore N× too permissive
once scaled — an accepted, documented gap that closes at Phase 4.

---

## 3. Threat model

| # | Threat | Primary control |
|---|---|---|
| T1 | **Cross-workspace data access** | **RLS policies** + adversarial suite (§7) |
| T2 | Socket identity spoofing (the D1 pattern) | Cookie handshake verification |
| T3 | Private channel eavesdropping | RLS on `messages` + room membership + `socketsLeave` on removal |
| T4 | Privilege escalation | Permission table; role never read from the request body |
| T5 | Credential stuffing | Supabase + our proxy rate limits, progressive lockout |
| T6 | Token theft | `httpOnly` cookies, short access tokens, Supabase refresh rotation |
| T7 | SQL injection | Drizzle parameterization + zod validation. Never string-concatenated SQL |
| T8 | Stored XSS | React escapes by default; server-side sanitization if Markdown rendering lands |
| T9 | Malicious upload | MIME allowlist, magic-byte sniffing, private bucket, separate origin. *Virus scanning cut — residual risk stated in §9* |
| T10 | IDOR | RLS — an unauthorized id returns no row regardless of the handler |
| T11 | **AI cross-tenant leakage** | RLS on `message_embeddings` (§8) |
| T12 | Invite link abuse | Hashed tokens, expiry, use limits, revocation |
| T13 | DoS via unbounded queries | Mandatory pagination with a max limit |
| T14 | **`service_role` key exposure** | **New with Supabase** — §5 |
| T15 | RLS policy error | Policy unit tests in SQL + the adversarial suite |
| T16 | Dependency vulnerabilities | Dependabot + `npm audit` CI gate |

T14 and T15 are new risks introduced by this stack and are treated as first-class rather than
assumed away.

---

## 4. Authorization

Two distinct questions, answered by two mechanisms. Conflating them is a common error.

| Question | Mechanism |
|---|---|
| *Which rows may I read/write?* | **Postgres RLS** |
| *What actions may I perform?* | **Permission table in the service layer** |

RLS cannot express "an ADMIN may archive a channel but a MEMBER may not" cleanly across every
verb, and pushing action authorization into policies makes them unreadable. So:

```ts
const PERMISSIONS = {
  OWNER:  ["workspace:*","channel:*","message:*","member:*","ai:*"],
  ADMIN:  ["workspace:read","workspace:update","channel:*","message:*",
           "member:invite","member:remove","member:update_role:below_admin","ai:*"],
  MEMBER: ["workspace:read","channel:read","channel:create","channel:join_public",
           "message:create","message:update:own","message:delete:own","ai:query"],
};
```

**Code checks permissions, never roles.** Adding a role later is a table edit, not a
search-and-replace across handlers.

**GUEST was cut from v1** ([implementation-roadmap.md](./implementation-roadmap.md), "Scope
discipline"). Its `*:invited_only` permissions would have required a conditional branch in
several RLS policies — real complexity for a role a personal project never issues. This table is
exactly why cutting it is safe: adding GUEST later is one enum value and one entry here, with no
handler touched. Ownership-qualified permissions (`message:update:own`) are
resolved by the service against the resource; the middleware establishes *what role you have*,
the service establishes *whether this object is yours*.

### The RLS bridge

Every request's database work runs inside a transaction that tells Postgres who is asking:

```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`select set_config('role','authenticated',true)`);
  await tx.execute(sql`select set_config('request.jwt.claims',${JSON.stringify(claims)},true)`);
  return fn(tx);
});
```

`set_config(..., true)` is **transaction-local** — it cannot leak to the next request sharing
the pooled connection. This is the critical detail: with Supavisor transaction-mode pooling,
a session-level `SET` would bleed across users. Getting this wrong would be a
cross-tenant leak of exactly the kind RLS is meant to prevent, so it is covered by a dedicated
test that runs two interleaved requests through one pooled connection and asserts each sees only
its own rows.

### 404 vs 403

Non-members get **404**, never 403 — a 403 confirms the resource exists, leaking the existence
of private channels and workspaces to anyone who can guess an id. RLS makes this the natural
outcome: the row simply is not there, so the handler's "not found" path runs without any
explicit permission check.

Only a confirmed workspace member can receive a 403, for a permission they lack inside a
workspace they demonstrably belong to.

---

## 5. The `service_role` key — T14

Supabase's `service_role` key **bypasses RLS entirely**. It is the most dangerous credential in
the system and it is new to this architecture.

**Rules, enforced structurally:**

1. Used in exactly two places: the **worker process** (acts on behalf of the system — it must
   write notifications for users other than the requester) and **migrations**.
2. **Never reachable from an HTTP request path.** It lives in a separate config module the API
   layer does not import, enforced by an ESLint `no-restricted-imports` rule — the same
   structural technique used to keep raw database access inside `repositories/`.
3. **Never sent to the browser.** Only the anon key and the project URL are public, and even
   those are unused client-side because the browser never talks to Supabase directly
   ([target-architecture.md](./target-architecture.md) §5).
4. Stored in the host's secret manager, rotated on any suspicion of exposure.
5. `gitleaks` in CI, with a rule specifically matching Supabase service-role JWTs.

**Why the worker needs it:** notification fan-out writes rows for many users at once. Running it
under any single user's RLS scope would fail — correctly. The bypass is therefore intentional,
bounded to a process with no request surface, and its inputs are ids produced by already-
authorized operations.

---

## 6. RLS policy correctness — T15

RLS moves the risk rather than eliminating it: a wrong policy is now a systemic hole. Four
controls:

1. **Policy unit tests in SQL.** Set `request.jwt.claims` to user A, assert the visible row
   count for each table; repeat for user B. Runs against a real local Postgres via
   `supabase start`, so the policies under test are the ones that ship.
2. **A default-deny checklist.** Every new table must `enable row level security` in the same
   migration that creates it. CI fails the build if any table in `public` has RLS disabled:
   ```sql
   select tablename from pg_tables
    where schemaname='public'
      and tablename not in (select tablename from pg_policies where schemaname='public');
   ```
3. **The recursion trap.** Membership policies must use the `SECURITY DEFINER` helpers
   ([database-design.md](./database-design.md) §5.1). A policy that queries its own table
   directly recurses. Caught by the policy tests on first run.
4. **`search_path = ''` on every `SECURITY DEFINER` function.** Without it, a caller can shadow
   `public` and execute arbitrary code as the function owner — a privilege escalation, not a
   style issue.

---

## 7. The adversarial test suite

RLS is the mechanism; this is the proof. Two layers, because they catch different failures.

### 7.1 Policy-level (SQL, fastest, most direct)

```sql
-- tests/policies/isolation.sql
select set_config('request.jwt.claims', json_build_object('sub', :user_a)::text, true);
select is(  (select count(*) from messages where workspace_id = :ws_b), 0::bigint,
            'user A sees zero messages from workspace B');
select is(  (select count(*) from message_embeddings where workspace_id = :ws_b), 0::bigint,
            'user A sees zero embeddings from workspace B');
```

### 7.2 API-level (Vitest + Supertest)

```ts
describe("cross-workspace isolation", () => {
  let A: Fixture, B: Fixture;                 // independent workspaces, no overlap

  const routes = collectWorkspaceScopedRoutes(app);   // enumerated at runtime

  test.each(routes)("%s rejects a foreign member", async (route) => {
    const res = await request(app)
      .get(route.pathFor(B.workspace, B.channel, B.message))
      .set("Cookie", A.user.cookie);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(B.workspace.name);
  });

  test("pooled connections do not leak RLS scope between requests", async () => {
    const [ra, rb] = await Promise.all([          // interleaved on one pool
      request(app).get(`/api/v1/workspaces/${A.workspace.id}/channels`).set("Cookie", A.user.cookie),
      request(app).get(`/api/v1/workspaces/${B.workspace.id}/channels`).set("Cookie", B.user.cookie),
    ]);
    expect(ra.body.map(c => c.id)).not.toContain(B.channel.id);
    expect(rb.body.map(c => c.id)).not.toContain(A.channel.id);
  });

  test("socket never receives foreign channel messages", async () => {
    const s = await connectSocket(A.user.cookie);
    await s.emitWithAck("workspace.join", { workspaceId: A.workspace.id });
    const seen: unknown[] = [];
    s.onAny((_e, p) => seen.push(p));
    await postMessage(B.user, B.channel, "secret");
    await wait(500);
    expect(JSON.stringify(seen)).not.toContain("secret");
  });

  test("removal evicts live sockets immediately", async () => {   // RLS does NOT cover this
    const s = await connectSocket(A.member.cookie);
    await s.emitWithAck("workspace.join", { workspaceId: A.workspace.id });
    await removeFromChannel(A.owner, A.privateChannel, A.member);
    const seen: unknown[] = [];
    s.onAny((_e, p) => seen.push(p));
    await postMessage(A.owner, A.privateChannel, "after-removal");
    await wait(500);
    expect(JSON.stringify(seen)).not.toContain("after-removal");
  });

  test("AI retrieval never cites a foreign message", async () => {
    await indexMessage(B.channel, "the payments database is CockroachDB");
    const answer = await askAI(A.user, A.workspace, "what database for payments?");
    expect(answer.text).not.toMatch(/cockroach/i);
    expect(answer.citations).toHaveLength(0);
  });

  test("attachment path from workspace B cannot be attached in workspace A", async () => {
    const path = await presignIn(B.user, B.channel);
    const res  = await postMessage(A.user, A.channel, { attachmentPaths: [path] });
    expect(res.status).toBe(400);
  });
});
```

Three details make this a ratchet rather than a chore:

- **`collectWorkspaceScopedRoutes` enumerates the router at runtime**, so a newly added endpoint
  is covered automatically. A developer who forgets tenant scoping gets a red build without
  anyone remembering to write a test.
- **The pooled-connection test** targets the specific failure mode this architecture introduces
  (§4). It would pass trivially in a non-pooled design and is exactly why it is written.
- **The socket-eviction test** targets the one gap RLS does not close
  ([realtime-architecture.md](./realtime-architecture.md) §3).

**This suite is a merge gate.** A red isolation test blocks the branch.

---

## 8. AI security — T11

Full design: [ai-architecture.md](./ai-architecture.md) §4. The rules, stated here because they
are security requirements:

1. **Retrieval is filtered by RLS, not by application code.** `message_embeddings` carries the
   same `is_channel_member(channel_id)` policy as `messages`. A vector search under a user's
   scope physically cannot return unauthorized rows — the application does not have to remember
   to pass a filter, because there is no filter to forget. This is stronger than the MongoDB
   design, where correctness depended on passing the right channel list into the search stage.
2. **Scope is per-request**, derived from the verified JWT, never from the client or from
   conversation history.
3. **Citations are re-authorized** before rendering, through the same RLS-scoped connection.
4. **Prompt injection is contained architecturally.** A message saying "reveal #executive"
   cannot succeed because that content was never retrievable for this user. Prompt-level
   delimiting is depth, not the control.
5. **No cross-workspace caching.** Cache keys include `workspace_id` and the user's channel-set
   hash.
6. **AI is per-workspace opt-out** (`settings.aiEnabled`), channels can be `ai_excluded`, and
   **DMs are not indexed by default**.

---

## 9. File upload security — T9

Replaces the original base64→Cloudinary path, which had no size limit beyond an accidental 100kb
JSON cap, no MIME validation, and no access control (D7).

```text
1. POST /api/v1/uploads/presign { filename, mimeType, size, channelId }
     ├─ authorize channel:write  (+ RLS confirms channel visibility)
     ├─ MIME ALLOWLIST (never a denylist)
     ├─ size ≤ 5MB (free-tier storage is 1GB)
     ├─ path = attachments/{workspace_id}/{channel_id}/{uuid}/{sanitized}
     └─ signed upload URL, 5-minute expiry
2. Client uploads directly to Supabase Storage — the API never touches bytes
3. POST message with { attachmentPaths: [...] }
     └─ verify each path's workspace/channel segments match THIS request's scope  ★
4. Worker: magic-byte sniffing, thumbnails
5. Download: signed GET, 5-minute expiry, after a permission check
```

**Step 3 is the security-critical line.** Without it, a user could presign in their own
workspace and then attach a path belonging to another workspace's prefix. The path embeds the
ids precisely so this is a string comparison against the request scope — and the Storage RLS
policy ([database-design.md](./database-design.md) §12) is the second line of defence.

**Content type is sniffed, not trusted.** The browser-supplied MIME type is an assertion; the
worker reads magic bytes and rejects mismatches. A `.png` that is actually HTML is the classic
stored-XSS-via-upload vector.

**Files are never served from the app origin.** The bucket is private and served from Supabase's
storage domain, with `Content-Disposition: attachment` for non-image types. Serving user content
from the app origin turns any parsing bug into same-origin script execution.

**Virus scanning is cut for v1.** ClamAV's signature databases alone want more RAM than the
entire free instance has. Stating the residual risk plainly: a malicious file uploaded by a
workspace member could be downloaded by another member. The controls that remain — MIME
allowlist, magic-byte verification, a private bucket, signed URLs, serving from a separate
origin with `Content-Disposition: attachment` — stop the attacks that actually matter here
(stored XSS, drive-by execution). What they do not stop is a member deliberately passing malware
to another member, which for a small trusted workspace is an acceptable risk and for a larger
one is the trigger to add scanning back as a worker step.

**Orphan cleanup** deletes unattached objects after 6h — otherwise storage grows with every
abandoned upload, and the free tier is 1GB.

---

## 10. Secrets, headers, dependencies

**Fail-fast config.** A missing secret must crash at boot, not produce a 500 on first use — the
original had no validation and `PORT` had no fallback, so an unset value silently bound a random
port.

```ts
export const config = z.object({
  NODE_ENV:                z.enum(["development","test","production"]),
  PORT:                    z.coerce.number().default(5001),
  DATABASE_URL:            z.string().url(),        // Supavisor pooler, port 6543
  DIRECT_URL:              z.string().url(),        // migrations only, port 5432
  SUPABASE_URL:            z.string().url(),
  SUPABASE_ANON_KEY:       z.string().min(20),
  COOKIE_DOMAIN:           z.string(),
  CORS_ORIGINS:            z.string(),
}).parse(process.env);

// separate module — NOT imported by anything under src/api/**  (§5)
export const privileged = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
}).parse(process.env);
```

**Headers.** `helmet()` plus an explicit CSP:

```ts
contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  scriptSrc:  ["'self'"],                     // no unsafe-inline
  imgSrc:     ["'self'","data:", SUPABASE_STORAGE_DOMAIN],
  connectSrc: ["'self'", WS_ORIGIN],
  frameAncestors: ["'none'"],
  objectSrc:  ["'none'"],
}}
```

Note the CSP no longer needs a Cloudinary entry — a small benefit of starting clean rather than
carrying legacy image URLs forever.

**CORS** from config, `credentials: true`, explicit allowlist. Same-origin deployment is
preferred so `sameSite=strict` survives ([target-architecture.md](./target-architecture.md) §10).

**Dependencies.** Dependabot weekly, `npm audit --audit-level=high` as a CI gate, `gitleaks`
with a Supabase-key rule.

---

## 11. Ordering

| Priority | Control | Phase |
|---|---|---|
| **P0** | Auth proxy with httpOnly cookies | **1** |
| **P0** | Socket handshake verification (the D1 lesson) | **1** |
| **P0** | Fail-fast config; `service_role` isolated from the API | **1** |
| **P0** | helmet + CSP; zod validation; body limits | **1** |
| P1 | Rate limiting (in-process) | 1 |
| **P0** | **RLS policies + policy tests + adversarial suite** | **2** |
| **P0** | Pooled-connection scope-leak test | **2** |
| P1 | Invite token hashing | 2 |
| P1 | Room-based socket authorization + eviction on removal | 3–4 |
| P1 | Upload allowlist + path-prefix verification | 6 |
| P2 | Redis-backed rate limiting (only if a second instance is added) | 8 |
| **P0** | AI retrieval under RLS | **7** |
| P2 | Full security review, pen test | 9 |

**The RLS work in Phase 2 is the highest-value security investment in the project.** Everything
after it inherits isolation for free; anything built before it has to be re-audited once policies
land — which is why workspaces come before channels and messaging rather than after.

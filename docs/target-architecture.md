# Katta — Target Architecture

> **Context: greenfield rebuild.** The original MongoDB database and deployment credentials are
> gone. The React frontend is carried forward; the backend is rewritten in TypeScript against
> Supabase/Postgres. Debt IDs (D1–D25) refer to
> [current-architecture.md](./current-architecture.md) §9 and are design lessons, not bugs to
> fix in place.

---

## 1. Design constraints

1. **No data to preserve, no environment to keep alive.** This removes the single largest
   constraint from the original plan and is why the database decision reverses (§3).
2. **The React frontend is kept.** Components, stores, routing, and daisyUI theming are reused.
   Converted to TypeScript as they are touched, not in one pass.
3. **The REST-write / socket-read split stays.** The original got this right
   ([current-architecture.md](./current-architecture.md) §10). Everything is built around it.
4. **Tenant isolation must be enforced by the database, not by convention.** This is now
   achievable and is the main reason the stack changed.
5. **Horizontal scalability must be possible, not necessarily deployed.** One API instance is a
   fine topology for a small org — but it must be a choice.
6. **One developer, part-time.** Every piece of infrastructure costs ongoing attention.

---

## 2. Target diagram

```text
                     ┌─────────────────────────────────────┐
                     │  React 18 + Vite + TypeScript       │
                     │  TanStack Query · Zustand · daisyUI │
                     └──────┬─────────────────────┬────────┘
                            │                     │
                   REST (httpOnly cookie)   WebSocket (same cookie
                            │                at handshake)
                            ▼                     ▼
     ┌────────────────────────────────────────────────────────────────┐
     │                  Express API (TypeScript, N ≥ 1)               │
     │                                                                │
     │  HTTP:  helmet → cors → pino-http → rate-limit → validate(zod) │
     │         → authenticate → withRlsScope → controller → service   │
     │                                                                │
     │  Auth proxy:  /api/v1/auth/*  ⇄  Supabase GoTrue               │
     │               sets Supabase tokens as httpOnly cookies         │
     │                                                                │
     │  Socket.IO gateway:  cookie handshake → rooms → handlers       │
     │                      @socket.io/redis-adapter                  │
     │                                                                │
     │  In-process state (one instance): PresenceStore · typing ·     │
     │                     rate limits · permission LRU               │
     │                     — all behind interfaces, Redis-swappable   │
     │                                                                │
     │  pg-boss workers (RUN_WORKERS=true, same process by default):  │
     │    notification.fanout · email.send · attachment.process       │
     │    embedding.generate · cleanup.orphans                        │
     │                                                                │
     │  Services → Repositories (Drizzle) → pg pool                   │
     │                              │                                 │
     │      every transaction: SET LOCAL request.jwt.claims           │
     │                         ⇒ RLS applies to every query           │
     └───────┬───────────────────────────────────┬────────────────────┘
             │                                   │
             ▼                                   ▼
  ┌────────────────────────────┐      ┌────────────────────────┐
  │        SUPABASE            │      │   Groq (LLM API)       │
  │                            │      │   ~6k token contexts   │
  │  Postgres                  │      │   queued, rate-limited │
  │   ├── RLS policies ★       │      └────────────────────────┘
  │   ├── tsvector FTS         │
  │   ├── pgvector (halfvec)   │      ┌────────────────────────┐
  │   ├── pg-boss job tables   │      │  Local embeddings      │
  │   └── SQL migrations       │      │  Transformers.js       │
  │                            │      │  bge-small, 384-dim    │
  │  Auth (GoTrue)             │      │  ★ never leaves host   │
  │  Storage (S3-compat)       │      └────────────────────────┘
  └────────────────────────────┘
```

Everything runs on free tiers — budgets, limits, and what breaks first in
[free-tier-plan.md](./free-tier-plan.md). **Redis is absent by design**: its only job is
coordinating multiple instances, and the free-tier deployment runs one (§free-tier-plan §5).

**★ is the architectural centre of gravity.** Every read the API performs runs under a Postgres
role scoped to the requesting user. A query that forgets its tenant filter returns zero rows
instead of another workspace's data.

---

## 3. The database decision — reversed

The Phase 0 draft recommended keeping MongoDB. That recommendation was explicitly conditional:

> *"Postgres is the better database for this domain in the abstract. It is not better enough to
> justify rewriting the only working part of the application before adding a single feature."*

**The condition no longer holds.** There is no data, no deployment, and the backend data-access
layer is ~500 lines. The migration cost that carried the entire argument is now approximately
one week of work that has to happen regardless, because the database it targets is gone.

### Why Supabase/Postgres now

**1. Row-Level Security answers the project's hardest requirement.**

The stated core security requirement is *"can a user from Workspace A access data belonging to
Workspace B?"* In the MongoDB design, the answer was "no, provided every developer routes every
query through a repository that remembers to include `workspaceId`" — compensated for with
lint rules, branded types, and an adversarial test suite. It was discipline dressed as
architecture.

With RLS, isolation is a property of the database:

```sql
create policy "messages readable by channel members"
  on messages for select using ( is_channel_member(channel_id) );
```

A handler that writes `select * from messages` — no filter at all — returns only messages the
requesting user can read. The failure mode of forgetting a filter changes from *data leak* to
*no result*. That is a categorical improvement, not an incremental one.

**2. The domain is relational and always was.** `workspace → members → channels → members →
messages → reactions/mentions/attachments` is a join graph with real foreign keys. In the
document model, reactions and mentions were embedded arrays chosen partly to avoid joins.
Here they are tables with indexes and referential integrity.

**3. Message ordering becomes atomic.** The `seq` counter design needed for ordering, gap
detection, and unread counts required two round trips in MongoDB, with a documented failure
window that permanently burned a sequence number on a crash. In Postgres it is one statement
that is also idempotent (§7 of [database-design.md](./database-design.md)).

**4. Supabase consolidates more than Atlas did.**

| Need | MongoDB plan | Supabase plan |
|---|---|---|
| Primary store | Atlas M10 (~$60/mo) | Supabase Postgres |
| Full-text search | Atlas Search (needs M10+) | `tsvector` + GIN, built in |
| Vector search | Atlas Vector Search | `pgvector` + HNSW |
| Object storage | Cloudflare R2 | Supabase Storage (S3-compatible, RLS-aware) |
| Auth | ~1 week of Phase 1 | Supabase Auth (GoTrue) |
| Migrations | hand-rolled runner | Supabase CLI, versioned SQL |
| Local dev stack | `mongodb-memory-server` | `supabase start` — real Postgres, real RLS |

That last row matters more than it looks: integration tests run against a **real** database with
the **actual** RLS policies, rather than an in-memory stand-in that cannot express them.

**5. Cost drops.** ~$65–75/mo all-in versus ~$100–150 for the Atlas plan.

### What we give up, honestly

- **Schema rigidity.** Adding a column is a migration, not a write. This is a benefit that
  reads as a cost for the first two weeks.
- **Vendor coupling.** Postgres is portable (`pg_dump` and go). **Auth is the sticky part** —
  moving off Supabase Auth later means re-homing user identities. This is the real lock-in and
  it is accepted deliberately in exchange for not writing auth.
- **RLS has sharp edges** — recursive policies, per-row evaluation cost, and interaction with
  vector indexes. All three are covered in [database-design.md](./database-design.md) §5 and
  [ai-architecture.md](./ai-architecture.md) §4 rather than discovered in production.
- **Connection limits.** Postgres has them; Mongo's driver pooling is more forgiving. Handled
  with Supavisor transaction-mode pooling (§6).

### Rejected

| Rejected | Why |
|---|---|
| **Stay on MongoDB** | The only argument for it was migration cost, and there is nothing to migrate |
| Self-hosted Postgres | Supabase gives Auth + Storage + Studio + migrations for less than the time cost of operating Postgres |
| Neon / RDS + separate auth | Cheaper per-GB, but then auth, storage, and vector tooling are three more decisions |
| Direct client → database via PostgREST | Business logic (seq assignment, fan-out, notifications) must live in the API. §5 |
| Supabase Realtime | Decided against — §4 |
| Supabase Edge Functions | The API is a long-lived Express process with WebSockets. Edge functions solve a different problem |
| Elasticsearch / Meilisearch | Postgres FTS is sufficient well past this scale |
| Separate vector DB | `pgvector` under the same RLS policies is strictly more secure — [ai-architecture.md](./ai-architecture.md) §4 |
| Kafka / RabbitMQ / BullMQ | pg-boss on the database we already have — no new infrastructure |
| Microservices, Kubernetes, GraphQL, Next.js | Unchanged from the original analysis — cost without benefit at this scale |

---

## 4. Real-time: Socket.IO, not Supabase Realtime

Supabase Realtime (Postgres Changes, Broadcast, Presence, authorized by RLS) would remove the
Redis adapter and make the handshake-auth problem disappear entirely. It was a genuine
contender. We are keeping Socket.IO for three reasons:

1. **Protocol control.** The reconnection design depends on a custom `workspace.join` ack that
   returns per-channel head sequences, letting the client detect gaps by arithmetic
   ([realtime-architecture.md](./realtime-architecture.md) §7). Supabase Realtime has no
   equivalent custom-ack primitive; that design would have to be rebuilt around extra REST
   round trips.
2. **Portability.** Postgres is portable and Storage is S3-compatible. Realtime is not — it
   would deepen the lock-in that §3 already accepts for Auth. Keeping the real-time layer
   independent bounds the exposure.
3. **It already exists.** The frontend is being kept, and it is written against
   `socket.io-client`.

**The trade accepted:** we write the cookie handshake auth (the D1 fix) and take on a Redis
dependency at Phase 4. Both are well-understood and roughly a day of work each.

**Postgres Changes is explicitly not used**, even as a supplement. Streaming row changes to
clients would bypass the service layer that assigns sequences, resolves mentions, and triggers
notification fan-out — producing two sources of truth for what a "new message" event means.

---

## 5. No direct client → database access

A Supabase design decision people get wrong: the browser holds a Supabase session, so it *can*
query tables directly through `supabase-js`, with RLS as the guard.

**We do not do this.** The browser talks to Express, and only Express talks to Postgres.

Reasons: message creation must assign a sequence number, enforce idempotency, resolve mentions,
emit a socket event, and enqueue notification fan-out. None of that can happen in a direct
table insert. Splitting reads across two paths (some direct, some via API) would also mean two
authorization surfaces, two caching stories, and two places to look when something is wrong.

**RLS is therefore not client-facing protection — it is protection for our own backend against
its own bugs.** That is the correct framing, and it is why RLS is still worth every line despite
no untrusted client ever holding a connection.

---

## 6. Auth: Supabase Auth behind an Express proxy

The default Supabase SPA pattern stores the session in `localStorage`, which is readable by any
XSS. The current Katta app uses `httpOnly` + `sameSite=strict` cookies — genuinely the best
thing about the original codebase ([current-architecture.md](./current-architecture.md) §10),
and the foundation the socket handshake auth depends on.

We keep the cookie and get Supabase's auth logic, by proxying:

```text
POST /api/v1/auth/login  { email, password }
      │
      ├─ Express → Supabase GoTrue (password grant)
      ├─ receives { access_token (JWT, ~1h), refresh_token }
      └─ Set-Cookie: sb-access  httpOnly, sameSite=strict, secure
         Set-Cookie: sb-refresh httpOnly, sameSite=strict, secure,
                                path=/api/v1/auth/refresh

every subsequent request:
      ├─ read sb-access cookie
      ├─ verify JWT signature via Supabase JWKS (cached, asymmetric keys)
      ├─ near expiry → refresh server-side, rotate cookies transparently
      └─ req.claims = { sub, role, ... }
```

**What this buys:** password hashing, reset flows, email verification, OAuth, and refresh-token
rotation are Supabase's problem, while the token never touches JavaScript. The socket handshake
reads the same `sb-access` cookie — so the D1 fix is identical to the design already written.

**What it costs:** OAuth redirect flows need an Express callback route to perform the PKCE code
exchange server-side rather than in the browser. One extra endpoint.

**Why the JWT claims matter beyond authentication:** `req.claims` is what gets injected into the
Postgres session so `auth.uid()` resolves inside RLS policies (§7). Authentication and
authorization share one mechanism instead of being bolted together.

---

## 7. Backend layering and the RLS bridge

```text
routes/          path + middleware chain. no logic.
  ↓
middleware/      authenticate → withRlsScope → authorize(permission) → validate(zod)
  ↓
controllers/     HTTP shape only.
  ↓
services/        business logic, transactions, domain events. unit-testable.
  ↓
repositories/    Drizzle queries. every one runs inside an RLS-scoped transaction.
  ↓
db/              schema, migrations, policies.
```

The critical piece is `withRlsScope`. Rather than a repository that *remembers* to filter, every
request runs its database work inside a transaction that tells Postgres who is asking:

```ts
export async function withRlsScope<T>(claims: JwtClaims, fn: (tx: Tx) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('role', 'authenticated', true)`);
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`);
    return fn(tx);
  });
}
```

`set_config(..., true)` is transaction-local, so it cannot leak to the next request sharing the
pooled connection. From that point on, `auth.uid()` inside every policy resolves to this user,
and every query in the transaction is filtered by the database.

**The `service_role` key bypasses RLS entirely and is used in exactly two places:** the worker
process (which acts on behalf of the system, not a user) and migrations. It is never reachable
from an HTTP request path. This is enforced by putting it in a separate config object that the
API layer does not import — the same structural approach the ESLint model-import rule takes.

**Query layer: Drizzle.** TypeScript-first, generates plain SQL, works cleanly with
transaction-mode pooling (no prepared-statement conflicts), and drops to raw SQL where the
schema needs it — such as the single-statement message insert
([database-design.md](./database-design.md) §7). Prisma was rejected for friction with both
pgbouncer-style pooling and per-transaction session settings.

**Migrations: Supabase CLI.** Versioned SQL files that include tables, policies, functions, and
storage buckets — Supabase-specific objects that a TS-schema-first tool cannot express. Drizzle's
schema definition is kept in sync as the typed view of the same tables.

**Pooling:** Supavisor transaction mode (port 6543) for the API and worker; direct connection
(5432) for migrations only.

---

## 8. Frontend architecture

The frontend is kept and extended. Changes are additive.

| Concern | Today | Target | Why |
|---|---|---|---|
| Server state | hand-cached in Zustand | **TanStack Query** | Directly replaces `getUsers`/`getMessages`/`isXLoading`; `useInfiniteQuery` is the scrollback primitive |
| Client state | Zustand | **Zustand (keep)** | Right tool for socket, active workspace/channel, presence, theme, drafts |
| Types | JS | **TypeScript, incrementally** | Converted as components are touched; shared request/response types with the backend |
| Routing | inline ternaries | `<RequireAuth>` + `<RequireWorkspace>` | 5 routes becomes ~15 |
| Forms | `useState` + manual | **react-hook-form + zod** | Same zod schemas as the backend |
| HTTP | bare axios | axios + **response interceptor** | 401 → refresh → retry → redirect; fixes the D11 error-handler crash |
| Styling | Tailwind + daisyUI | **keep** | Working, themed, zero migration value in changing it |
| Realtime | ad-hoc `socket.on` | `useSocketEvent` hook + typed event map | Fixes D22 (handler-scoped `off`) and D23 (dedupe) |
| Auth | direct axios calls | same, against the Express proxy | **No `supabase-js` in the browser** — §5, §6 |

### The socket / query bridge

Socket events must not fight the query cache. The rule: **socket events write into the TanStack
Query cache**, they do not maintain a parallel store.

- `message.created` → `queryClient.setQueryData(['messages', channelId], append + dedupe)`
- Dedupe on server `id`, with `clientMsgId` reconciling the optimistic placeholder
- On reconnect → sequence-gap comparison, then a targeted refetch
  ([realtime-architecture.md](./realtime-architecture.md) §7)

---

## 9. Technology decisions

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | React 18, Vite, **TypeScript** (incremental) | Kept from the existing app |
| Server state | **TanStack Query** | Replaces hand-rolled cache |
| Client state | **Zustand** (keep) | Already there, right size |
| UI | **Tailwind + daisyUI** (keep) | Working; 32 themes already built |
| Forms | **react-hook-form + zod** | Shared schemas |
| Backend | **Node + Express 4, TypeScript** | Written fresh in TS; Express because the socket + middleware model is well-understood and the frontend already targets it |
| Validation | **zod** | Shared frontend/backend; infers types |
| Database | **Supabase Postgres** | §3 |
| Query layer | **Drizzle ORM** | §7 |
| Migrations | **Supabase CLI** (versioned SQL) | Expresses policies and buckets, not just tables |
| Auth | **Supabase Auth via Express proxy** | §6 |
| Authorization | **Postgres RLS** + permission table | §3, [security-model.md](./security-model.md) §4 |
| Realtime | **Socket.IO** (Redis adapter deferred to Phase 8) | §4, [free-tier-plan.md](./free-tier-plan.md) §5 |
| Cache / coordination | **In-process**, behind `PresenceStore` / cache interfaces | One instance on free tier ⇒ Redis has no job yet. Swappable later |
| Queue | **pg-boss** on the existing Postgres | No new infrastructure, and enqueue shares the message's transaction. `Queue` interface keeps BullMQ a swap |
| Search | **Postgres FTS** (`tsvector` + GIN, `pg_trgm`) | Built in, RLS-covered, sufficient past this scale |
| Vector | **pgvector** (HNSW, `halfvec(384)`) | Same database ⇒ same RLS policies ⇒ retrieval cannot leak |
| Storage | **Supabase Storage** | S3-compatible, signed URLs, RLS-aware bucket policies |
| Email | **Resend**, built but disabled | Needs a verified domain; optional for a personal project |
| LLM | **Groq** (70B-class instruct), behind an `LlmProvider` interface | Generous free tier, fast streaming. Provider is a config value |
| Embeddings | **Local Transformers.js** (`bge-small-en-v1.5`, 384-dim) | Free, unmetered, and **indexed text never leaves our infrastructure** |
| Logging | **pino + pino-http** | Structured JSON, request IDs |
| Metrics | **An admin `/stats` page** | One instance, a few users. A Prometheus + Grafana stack would be a second system to operate |
| Errors | **Sentry** | Frontend + API. The actual alerting mechanism |
| Testing | **Vitest + Supertest + `supabase start` + Playwright** | Integration tests hit real Postgres with real policies |
| Container | **Docker + docker-compose** | API + worker; Supabase CLI supplies Postgres, Auth, Storage |
| CI | **GitHub Actions** | lint → typecheck → migrate → test → build. Also runs the Supabase keep-alive cron |
| Hosting | **Fly.io** (API + worker), **Cloudflare Pages** (frontend), **Supabase**, **Groq** | All free tiers. **Not Render** — it sleeps after 15 min, which is fatal for WebSockets |

---

## 10. Deployment topology

```text
     Cloudflare Pages                 (static React build)
                 │
                 │  /api/*  and  /socket.io/*  → same apex domain
                 ▼
     ┌───────────────────────────────┐
     │  Fly.io                        │
     │   api    (512MB, always on)    │  Express + Socket.IO + pg-boss workers
     │   worker (256MB, optional)     │  split out only when RAM demands it
     └───────┬────────────────────────┘
             │
   ┌─────────┴──────────┐
   ▼                    ▼
Supabase               Groq
(pg + auth + storage)  (LLM inference)
```

Free tiers throughout — full budget, limits, and what breaks first in
[free-tier-plan.md](./free-tier-plan.md). **The API and worker start as one process** behind a
`RUN_WORKERS` flag; splitting them is a deploy-config change, not a code change.

**Same-origin frontend is strongly preferred** — serving the React build from the same apex
domain as `/api` preserves `sameSite=strict` on the auth cookies, which is what makes CSRF a
non-issue. A cross-origin CDN frontend would force `sameSite=none` and require explicit CSRF
tokens. Do not split the origin without accepting that work.

Sticky sessions are not required, provided Socket.IO is pinned to `transports: ['websocket']`.
If a host forces long-polling fallback, they become mandatory — a deployment checklist item.

**Estimated cost: $0/month.** Every service runs on its free tier — Supabase, Fly.io,
Cloudflare Pages, Groq, and local embeddings. The Supabase free tier **pauses projects after 7
days of inactivity**, solved with a GitHub Actions keep-alive cron
([free-tier-plan.md](./free-tier-plan.md) §2).

The paid path — Supabase Pro, a second instance, Redis, a hosted frontier model — is roughly
$70/mo and is a plan upgrade rather than a rearchitecture, because the free-tier implementations
sit behind `PresenceStore`, `Queue`, and `LlmProvider` interfaces.

---

## 11. What the rebuild reuses

| Existing file | Fate |
|---|---|
| `frontend/src/components/*` | ✅ **Kept.** ChatContainer gains virtualization + infinite scroll; Sidebar becomes workspace + channel navigation |
| `frontend/src/pages/*` | ✅ **Kept.** Login/SignUp repoint at the auth proxy |
| `frontend/src/store/useThemeStore.js` | ✅ **Kept as-is** |
| `frontend/src/store/useAuthStore.js` | ⟳ Split: auth → TanStack Query; socket → `useSocketStore`; presence → `usePresenceStore` |
| `frontend/src/store/useChatStore.js` | ⟳ Replaced by TanStack Query hooks + a slim `useUIStore` |
| `frontend/src/lib/axios.js` | ⟳ Extended with the refresh interceptor |
| `frontend/src/components/skeletons/*` | ✅ **Kept** |
| `backend/**` | ⟳ **Rewritten** in TypeScript against Postgres. ~500 lines against a database that no longer exists |
| root `package.json` | ⟳ Rewritten as npm workspaces; the `"chai": "file:.."` self-dependency (D17) does not return |

The backend rewrite is not a big-bang decision — it is the unavoidable consequence of changing
databases, and it is small. The frontend, which is the larger body of work, is preserved intact.

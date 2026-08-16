# wave — Scalability & Observability

> Greenfield on Supabase/Postgres. The original could not scale horizontally at all — presence
> lived in a module-scoped object (D12) and fan-out targeted a socket id that existed in one
> process. The goal here is not to run three servers; it is to make instance count a
> configuration value rather than a rewrite.

---

## 1. What is stateful, and where it lives

| State | Location | Notes |
|---|---|---|
| Users, workspaces, channels, messages | **Postgres** | Source of truth |
| Files | **Supabase Storage** | External, S3-compatible |
| Session | **JWT in httpOnly cookie** | Stateless; refresh handled by Supabase |
| Socket connections | **Per-instance (irreducible)** | Bridged by the Redis adapter, if N > 1 |
| Presence | **In-process**, behind `PresenceStore` | Redis implementation exists for N > 1 |
| Typing | **In-process** TTL map | Ephemeral by nature |
| Rate-limit counters | **In-process** | Per-instance limits are N× too permissive once N > 1 |
| Permission cache | **In-process LRU** | Cache only — never the authority |
| Idempotency fast path | **Not implemented** | The unique constraint was always the guarantee |
| Job queues | **Postgres** (pg-boss) | Enqueue shares the message's transaction |

**On free tier the project runs one instance, so nothing above needs to be shared.** Redis
exists in this architecture for exactly one purpose — coordinating multiple instances — and that
purpose is absent until §7 limit #5 is reached ([free-tier-plan.md](./free-tier-plan.md) §5).

**What matters is that every one of these sits behind an interface from Phase 1.** The single
irreducible piece of per-instance state is the TCP connections themselves; everything else is
in-process *by configuration*, not by assumption. That distinction is the specific lesson of
D12: the original's failure was not that `userSocketMap` was in-process, but that
`userSocketMap[userId]` appeared directly in the message controller, so nothing could be swapped
without rewriting every caller.

**Consequence, stated plainly: the app cannot run more than one instance today.** That is the
correct trade for a personal project on free tiers, and moving to N > 1 is a constructor change
plus one line for the Socket.IO adapter — the Phase 8 work.

---

## 2. Horizontal-scale architecture

**Today (free tier):**

```text
       API #1  ← one instance: Express + Socket.IO + pg-boss workers
           │      in-process presence, typing, rate limits, cache
           ▼
      Supavisor pooler (transaction mode, 6543)
           ▼
      Supabase Postgres  ← also holds the pg-boss job tables
```

**The upgrade path, if a free-tier limit is ever hit:**

```text
                   Load Balancer  (TLS, health checks)
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
       API #1          API #2          API #3      ← stateless; N is a config value
           │               │               │
           └───────────────┼───────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
           Redis                   Supabase
      ┌──────────────┐        ┌────────────────────┐
      │ socket pubsub│        │ Supavisor pooler   │
      │ presence     │        │        ↓           │
      │ rate limits  │        │  Postgres primary  │
      │ perm cache   │        └────────────────────┘
      └──────────────┘
```

**The difference between the two is a constructor swap and one line of Socket.IO setup**,
because `PresenceStore`, the rate limiter, and the cache are interfaces with both
implementations written and tested (Phase 4). That is the whole point of §1.

**No sticky sessions required** provided Socket.IO is pinned to `transports: ['websocket']` —
a WebSocket is one long-lived connection to one instance, so there is nothing to make sticky.
If a host forces long-polling fallback, sticky sessions become mandatory. Deployment checklist
item, not an architectural one.

### Connection pooling — the Postgres-specific constraint

This is the main operational difference from the MongoDB plan and it needs to be got right up
front.

Postgres has a hard connection limit; Supabase's tiers cap it well below what N API instances × a
naive pool would open. **Supavisor in transaction mode** (port 6543) multiplexes many client
connections onto few database connections.

| Consumer | Connection | Why |
|---|---|---|
| API instances | Supavisor **transaction** mode, 6543 | Short transactions, high concurrency |
| Worker | Supavisor transaction mode, 6543 | Same |
| Migrations | **Direct**, 5432 | DDL and advisory locks need session mode |

**Two consequences that must be designed around, not discovered:**

1. **No prepared statements** in transaction mode. Drizzle is fine with this; it is the main
   reason Prisma was rejected ([target-architecture.md](./target-architecture.md) §7).
2. **Session-level state does not persist between transactions.** This is precisely why
   `withRlsScope` uses `set_config(..., true)` — transaction-local. A session-level `SET` would
   bleed RLS scope between users sharing a pooled connection. That failure would be a
   cross-tenant leak, so it has a dedicated test
   ([security-model.md](./security-model.md) §7.2).

Per-instance pool size is kept small (10–20) and multiplied by instance count against the tier
limit before scaling.

---

## 3. Consistency requirements

### Strong consistency required

| Operation | Why | Mechanism |
|---|---|---|
| Sequence assignment | Duplicate `seq` breaks ordering, pagination, unread counts | Single transaction in `send_message()` |
| Idempotency | Duplicate messages are visible corruption | `unique (channel_id, client_msg_id)` |
| Membership changes | The authorization boundary — a stale "yes" is a leak | Primary reads; cache invalidated on write |
| Workspace creation | Partial creation leaves an unusable workspace | `begin/commit` |
| Invite acceptance | Double-accept must not create two memberships | Unique constraint + atomic `use_count` increment |
| Role changes | Privilege escalation window | Primary reads + immediate cache bust |

**All six are ordinary transactions in Postgres.** In the MongoDB design several needed
bespoke handling and one (sequence assignment) had a documented failure window. This is the
quiet, cumulative benefit of the stack change.

### Eventual consistency acceptable

| Data | Staleness | Consequence |
|---|---|---|
| Presence | ~30s | A dot is the wrong colour |
| Typing | ~8s | Indicator lingers |
| Unread counts | seconds | Badge briefly wrong, corrected on next read |
| `member_count` | minutes | A number is slightly off |
| Notifications | seconds | Arrives shortly after the message |
| Search index | none — `tsvector` is a generated column, updated in the same statement | — |
| Embeddings | ~30s (debounced) | Very recent messages not yet semantically searchable |
| Email | minutes | Email is slow anyway |

**Anything that gates access is strongly consistent; anything cosmetic is not.** Permission
caching sits deliberately on the strong side — invalidated on write rather than allowed to
expire, because a 5-minute window of stale authorization is a security bug, not a UX
imperfection.

Note the search row: FTS is *not* eventually consistent here, because the generated column is
computed in the same statement as the write. That is a genuine simplification over an external
search index.

---

## 4. Caching

```text
Request → Redis (hit ~1ms) → Postgres (miss ~2–15ms) → populate Redis
```

| Key | TTL | Invalidated by |
|---|---|---|
| `perm:{userId}:{wsId}` → role + channel ids | 5m | membership write |
| `ws:{wsId}` → workspace row | 10m | workspace update |
| `ch:{chId}` → channel row | 10m | channel update |
| `profile:{userId}` | 15m | profile update |
| `unread:{userId}:{wsId}` | 1h | new message in a member channel |

**Write-through invalidation, not TTL expiry, for anything security-relevant.** TTL is the
backstop for a missed invalidation, not the mechanism.

**Deliberately not cached:** message content — the `(channel_id, seq desc)` index answers in
single-digit milliseconds, so caching would add an invalidation problem for no measurable gain.

**Note on the permission cache and RLS.** The cache serves the *application's* permission checks
(what actions may you take). It never short-circuits RLS, which always consults the database.
A stale cache can therefore cause a wrongly-allowed *action attempt*, which then returns zero
rows. Depth working as intended.

---

## 5. What can be asynchronous

| Work | Sync/async | Reasoning |
|---|---|---|
| Insert message + assign `seq` | **sync** | The user must know it was accepted |
| Emit `message.created` | **sync**, fire-and-forget | Sub-millisecond; delay would be visible |
| Notification fan-out | **async** | 200-member `@channel` = 200 inserts |
| Email | **async** | Provider latency must not affect message send |
| Thumbnails | **async** | Seconds of CPU |
| Virus scan | **async** | Blocks download, not send |
| Search indexing | **none needed** | Generated column |
| Embeddings | **async, batched, debounced** | 30s is imperceptible; batching is 10× cheaper |
| Digests, retention cleanup | **scheduled** | pg-boss repeatables |

**Target: message-send p95 < 150ms** — validation, `send_message()`, emit, respond. Everything
else is queued.

### Queue design (pg-boss on the existing Postgres)

| Queue | Concurrency | Retries | On permanent failure |
|---|---|---|---|
| `notification.fanout` | 10 | 5, exp backoff | Dead-letter + alert — user-visible loss |
| `email.send` | 5 | 3, exp backoff | Dead-letter, manual retry (disabled by default) |
| `attachment.process` | 3 | 3 | Mark failed, notify uploader |
| `embedding.generate` | **2** (batched) | 3 | Dead-letter, nightly sweep |
| `cleanup.orphans` | 1 (repeatable) | 1 | Log |

*(`digest.daily` cut with the digest feature.)*

`embedding.generate` runs at low concurrency because the embedding model is CPU-bound and shares
the instance with the API ([free-tier-plan.md](./free-tier-plan.md) §3). It is the one queue
where concurrency is limited by RAM and CPU rather than by a downstream service.

**Every handler is idempotent.** The queue *will* retry a job whose worker died after doing the
work but before acking. Enforced with unique constraints where the schema allows — which
Postgres makes straightforward.

**Two properties pg-boss gives that a Redis queue would not**, both of which fall out of the job
tables living in the same database as the data:

- **Enqueue can share the message's transaction.** *"Insert the message and queue the fan-out,
  atomically"* is a single `commit` — no window where a message exists but its notifications
  were never queued.
- **Queued jobs survive a process restart.** They inherit Postgres durability rather than
  depending on a cache's persistence settings.

`cleanup.orphans` also carries the retention work that MongoDB TTL indexes would have handled
automatically ([database-design.md](./database-design.md) §14) — a small cost of the stack
change, paid in one job rather than several index definitions.

---

## 6. Failure modes

### An API instance dies

- Its WebSocket connections drop; clients reconnect via backoff onto another instance.
- Presence entries expire from Redis within 60s.
- In-flight requests fail; the client retries with the same `client_msg_id`, and
  `send_message()` returns the existing row rather than creating a duplicate.
- A transaction killed mid-flight rolls back — **including the sequence increment**, so unlike
  the MongoDB design it does not permanently burn a `seq`.
- **Impact: brief reconnect. No data loss, no sequence gap.**

### The single instance restarts

With no Redis, all ephemeral state is in the process. A restart therefore loses presence, typing,
rate-limit counters, and the permission cache.

| State | On restart | Impact |
|---|---|---|
| Presence | Lost | Clients reconnect within seconds and re-register. Self-healing |
| Typing | Lost | Nobody notices |
| Rate limits | **Reset** | A determined attacker could restart-cycle... but cannot cause restarts. Acceptable |
| Permission cache | Lost | Repopulates from Postgres on demand. Slower, still correct |
| **Queued jobs** | **Survive** | pg-boss stores them in Postgres — a genuine advantage over Redis-backed queues here |
| Messages, users, everything real | **Survive** | In Postgres |

**Every loss is self-healing, and the queue survives.** That last row is worth noting: a
Redis-backed queue would lose in-flight jobs on a Redis flush, whereas pg-boss inherits
Postgres's durability. Choosing it for infrastructure-minimalism reasons produced a reliability
improvement as a side effect.

### If Redis is later added (Phase 8) and goes down

| Capability | Without Redis |
|---|---|
| Cross-instance delivery | **Broken** — only same-instance recipients get live events |
| Presence | Falls back to per-instance — partially correct |
| Rate limiting | **Fails closed for auth, open for everything else** — deliberate |
| Permission cache | Falls through to Postgres. Slower, still correct |
| Queues | **Unaffected** — they are in Postgres |
| REST API | **Works.** Messages send, history loads, search works, AI works |

**Redis down = degraded, not down.** Every cache read is wrapped so a timeout never becomes a
500. The auth/everything-else asymmetry in rate limiting goes in the runbook: rejecting logins
beats allowing unlimited brute force, while breaking the whole app is worse than serving it
unlimited.

### Groq is unavailable or rate-limited

AI features queue and retry with backoff; nothing else is affected. On free tier a 429 is a
*routine* condition rather than an incident, which is why AI requests go through the queue in
the first place ([ai-architecture.md](./ai-architecture.md) §5). The user sees "summarizing…"
for longer, never an error.

### Postgres is unavailable

The one dependency whose loss is a genuine outage — which is the correct place for that property
to sit. Supabase handles failover; the driver retries. Impact: elevated latency and some failed
requests during election.

**Supabase-specific watch item:** connection exhaustion presents like an outage but is not one.
`pg_stat_activity` connection count is an alerting metric, not an afterthought (§8).

### The queue backs up

Notification and email latency climbs. Alert at > 1,000 waiting jobs. Response: scale worker
replicas — stateless and independently scalable, which is the whole reason the worker is a
separate process rather than a thread in the API.

### An external service is down

| Service | Behaviour |
|---|---|
| Supabase Storage | Uploads fail with a clear message. Messaging unaffected |
| Resend | Retries with backoff, dead-letters after 3. In-app notifications unaffected. Disabled by default anyway |
| Groq | AI queues and retries; a sustained outage surfaces "temporarily unavailable". **Zero effect on core messaging** |
| *(embeddings)* | *No external dependency — they run in-process* |

AI is architecturally a leaf dependency — nothing in the message path calls it. That is why it
can be a Phase 7 addition rather than a rearchitecture.

---

## 7. Scaling limits, in the order they arrive

**On free tier, the ceilings are the tier's, not the architecture's.** The ordered list of what
breaks first is in [free-tier-plan.md](./free-tier-plan.md) §9 — Groq TPM, then the 500MB
database, then instance RAM. Every one is fixed by a plan change, not a rearchitecture.

The architectural ceilings below are what remain once the tiers are paid for:

| Metric | Comfortable ceiling | What breaks first | Fix |
|---|---|---|---|
| **Instance RAM (free tier)** | **512MB** | **Local embedding model during backfill** | Split the worker onto its own machine |
| **Database size (free tier)** | **500MB** | **Embeddings + HNSW index** | `halfvec`, retention, or upgrade |
| Concurrent sockets/instance | ~10k | Node event loop, memory | Add instances (requires Redis) |
| Database connections | tier-dependent | Supavisor pool exhaustion | Lower per-instance pool, upgrade tier |
| Messages/sec/channel | ~1k | Row lock on `channels.last_message_seq` | Batch, or shard the counter |
| Messages total | 100M+ | Nothing — the composite index holds | Partition by `created_at` |
| Workspace members | ~10k | `@channel` fan-out job size | Chunk fan-out jobs |
| FTS quality | tens of millions | `ts_rank_cd` relevance, not speed | Revisit a dedicated engine |
| Vector recall | millions | HNSW + RLS filtering ([ai-architecture.md](./ai-architecture.md) §4) | `ef_search`, partition by workspace |
| Queue throughput | ~1k jobs/min | pg-boss polling, database load | Swap the `Queue` adapter to BullMQ |

**For a personal project, one instance and one worker — in one process — is comfortably
sufficient.** The point of this document is that instance count is a slider, not that the slider
needs moving.

---

## 8. Observability

### Structured logging

**pino + pino-http**, replacing the original's ~15 unstructured `console.log` calls (D25).

```ts
logger.info({ requestId, userId, workspaceId, channelId,
              event: "message.created", durationMs: 42 }, "message created");
```

Every request carries a `requestId` (from `X-Request-Id` or generated), propagated through
services, socket handlers, and queue jobs via `AsyncLocalStorage`, so one user action is
traceable end to end: HTTP → service → job → socket emit.

**Redaction is configured, not remembered:** `password`, `token`, `cookie`, `authorization`,
`sb-access`, `sb-refresh`, and `service_role` are redacted at the logger level, so no call site
can leak a credential by accident.

### Metrics — an admin `/stats` page, not a metrics stack

For one instance and a handful of users, a Prometheus exporter plus a hosted Grafana dashboard is
instrumentation cosplay. What is actually needed is a page showing whether anything is close to a
free-tier ceiling:

| Shown on `/stats` | Why |
|---|---|
| **`pg_database_size()` of 500MB** | **The ceiling most likely to be hit (§7)** |
| Storage used, of 1GB | Second most likely |
| Groq requests today | Third |
| Queue depth and failed-job count | Earliest warning that background work is stuck |
| Active sockets | Real-time load at a glance |
| Slowest 10 queries (`pg_stat_statements`) | Where an unindexed RLS predicate shows up |

That last row deserves the attention a metrics stack would have gone to. RLS is a per-row cost
invisible in ordinary request timings, and a policy that loses its index — the
`(select auth.uid())` optimization dropped in a refactor, say
([database-design.md](./database-design.md) §5.1) — degrades everything at once. Checking the
slow-query list occasionally catches it; a dashboard nobody opens does not.

**Sentry does the actual alerting**, because errors are what you need to be told about. The
`/stats` page is for the numbers you go and look at.

### Health endpoints

```text
GET /healthz    liveness  — process is up. NO dependency checks
GET /readyz     readiness — Postgres ping + Redis ping. 503 if either is down
GET /metrics    prometheus scrape, internal only
```

The distinction matters: a liveness probe that checks the database restarts every instance during
a database blip, turning partial degradation into a total outage. Liveness asks "is this process
wedged?"; readiness asks "should the balancer send it traffic?".

### Error tracking

**Sentry** across frontend, API, and worker, tagged with `requestId` so a user report, a log
line, and a stack trace join up. Source maps uploaded in CI.

### Alerts — three, plus one merge gate

A personal project cannot act on a pager at 3am, so the alert list is what you would actually
want an email about:

| Condition | Action |
|---|---|
| **Sentry: a new unhandled error type** | email |
| **Database > 400MB of 500MB** | email — tighten retention before writes start failing |
| **Failed jobs > 0** | email — something background is silently broken |
| **Cross-tenant or RLS policy test failure** | **block merge** |

**Recommended:** Sentry plus the host's log view. **Explicitly not recommended:** Prometheus,
Grafana, Loki, or any self-hosted observability stack — a second system to operate, for a project
with one instance and one developer.

---

## 9. Load testing (Phase 8) — smoke level

A 512MB free instance cannot generate the numbers a production plan would specify, and this
project will not see them. Two scenarios, sized to what actually catches bugs:

1. **~50 concurrent users** on message send and scrollback (k6). Enough to surface an unindexed
   query or a connection-pool misconfiguration, which are the realistic failures. Watch p95 and
   the pool gauge together — under Postgres they rise as one signal.
2. **Mass reconnect** — disconnect every client at once, which is exactly what a deploy does.
   Confirm they all recover via gap replay with no message loss. The interesting question is
   whether `workspace.join`'s per-connection RLS query saturates the pool; at 50 clients it will
   not, but the shape of the answer is visible.

**Deep scrollback** is worth one manual check — page back through a few thousand seeded messages
and confirm the `(channel_id, seq desc)` index holds and memory stays flat.

*Cut from the earlier plan: 500-user REST ramps, 5,000-socket artillery runs, and a 5,000-client
reconnect storm.*

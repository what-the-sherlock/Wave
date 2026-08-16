# wave — Architecture & Planning Docs

Phase 0 deliverables: an audit of the original application and a plan for rebuilding it as a
team collaboration platform. **No application code has been written yet.**

> **The project is restarting, on free tiers throughout.** The original MongoDB database and
> deployment credentials were lost, so there is no data to migrate and no environment to
> preserve. The React frontend is carried forward; the backend is rebuilt in TypeScript on
> Supabase/Postgres, with Groq for inference. **Total running cost: $0/month.**

## Read in this order

| # | Document | What it answers |
|---|---|---|
| 1 | [current-architecture.md](./current-architecture.md) | What the original app was, what it got right, and 25 catalogued mistakes not to repeat (with `file:line` references) |
| 2 | [prd.md](./prd.md) | What we are building and for whom |
| 3 | [target-architecture.md](./target-architecture.md) | The target system, the database decision **and its reversal**, and the final stack |
| 4 | [database-design.md](./database-design.md) | Postgres schema, **RLS policies**, indexes, message ordering, idempotency |
| 5 | [realtime-architecture.md](./realtime-architecture.md) | Socket auth, rooms, events, presence, reconnection |
| 6 | [security-model.md](./security-model.md) | Threat model, RLS as the isolation mechanism, the adversarial test suite |
| 7 | [ai-architecture.md](./ai-architecture.md) | RAG design and why pgvector under RLS is the security-critical choice |
| 8 | [scalability.md](./scalability.md) | Stateful inventory, connection pooling, failure modes, observability |
| 9 | [free-tier-plan.md](./free-tier-plan.md) | **Every quota, what we do to stay inside it, and what breaks first.** The source of truth for limits and cost |
| 10 | [implementation-roadmap.md](./implementation-roadmap.md) | Phases 0–9 with objectives, changes, tests, and done-checklists |

## The database decision was made twice

The first pass recommended **keeping MongoDB**, explicitly on migration cost:

> *"Postgres is the better database for this domain in the abstract. It is not better enough to
> justify rewriting the only working part of the application before adding a single feature."*

Losing the database and the deployment removed that condition. With no data to migrate and ~500
lines of backend data access, the recommendation reverses to **Supabase/Postgres**. The reasoning
for both positions is preserved in [target-architecture.md](./target-architecture.md) §3, because
the reversal is the useful part — not the conclusion.

## What the restart changed

| | Before | After |
|---|---|---|
| Database | MongoDB Atlas | **Supabase Postgres** |
| Tenant isolation | Repository discipline + tests | **Row-Level Security**, enforced by the database |
| Auth | ~1 week of Phase 1 | **Supabase Auth** behind an Express proxy (httpOnly cookies preserved) |
| Search / vector / storage | Atlas Search · Atlas Vector · Cloudflare R2 | `tsvector` · `pgvector` · Supabase Storage — all in one service |
| Highest risk | **Live data migration** | **RLS policy correctness** |
| Timeline | ~24–31 weeks | **~20–26 weeks** |
| Cost | ~$100–150/mo | **$0/mo** |

The risk did not vanish — it moved from *"will we lose user data"* to *"are the policies right"*.
That is a better class of risk: policy errors are caught by deterministic tests in CI, migration
errors are caught in production.

## Decisions worth knowing before reading further

- **RLS is the isolation mechanism.** A handler that forgets its tenant filter returns an empty
  result instead of another workspace's data. This is the single largest consequence of the
  stack change.
- **Socket.IO, not Supabase Realtime** — the reconnection design depends on a custom ack that
  returns per-channel head sequences, and keeping the real-time layer portable bounds the
  lock-in already accepted for Auth.
- **The browser never talks to Supabase directly.** Message creation must assign a sequence,
  enforce idempotency, emit an event, and enqueue fan-out — none of which a direct table insert
  can do.
- **`service_role` bypasses RLS** and is the most dangerous credential in the system. It lives in
  a config module the API layer cannot import, and is used only by the worker and migrations.
- **The migrations directory is the first deliverable.** Its absence is what made losing an
  environment unrecoverable the first time; Phase 9 requires a full rebuild from migrations and
  secrets in under 30 minutes.
- **No Redis, and one instance.** Redis exists in this architecture for exactly one job —
  coordinating multiple instances — and free tier runs one. Presence, typing, and rate limiting
  are in-process **behind interfaces**, with the Redis implementations written and tested but not
  deployed. Adding them later is a constructor change.
- **pg-boss, not BullMQ.** The job queue lives in the Postgres we already have. Side benefit:
  enqueue shares the message's transaction, and queued jobs survive a restart.
- **Groq for inference, local embeddings.** Groq has no embeddings endpoint, so
  `bge-small-en-v1.5` runs in-process via Transformers.js — which means **indexed message text
  never leaves our infrastructure**, a privacy improvement that fell out of a cost decision.
- **The AI context budget is ~6k tokens, not ~15k.** Free-tier limits are tokens-per-minute, not
  dollars, so AI requests are **queued rather than issued synchronously** and a 429 never reaches
  the user.
- **Scope was cut by retrofit cost, not by current value.** GUEST role, group DMs, channel
  deletion, virus scanning, digest emails, action-item extraction, thread rooms, and the
  Prometheus stack are all out — each is an enum value or an afternoon to add later. RLS, the
  `seq` counter, socket auth, cursor pagination, and the layering all stayed, because
  retrofitting any of them into a built app is brutal. Full list in
  [implementation-roadmap.md](./implementation-roadmap.md), "Scope discipline".
- **No Elasticsearch, no separate vector DB, no microservices, no Kubernetes.**

**Timeline: ~15–19 weeks** for one part-time developer, at $0/month.

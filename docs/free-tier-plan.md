# Katta — Free-Tier Plan

> **This project runs on free tiers end to end.** That is a design constraint, not a footnote:
> it removes Redis from the early architecture, changes the queue technology, caps the AI context
> budget, and makes *rate limits* — not dollars — the thing to engineer around.
>
> This document is the single source of truth for limits and budgets. Where another doc states a
> cost or a quota, it defers to this one.
>
> **Free-tier terms change often.** Every number below is "as of planning" and should be verified
> against the provider's current dashboard before Phase 1. The *design consequences* are what
> matter and they hold even if the exact numbers move.

---

## 1. The stack, and what each tier actually gives

| Service | Free allowance (verify current) | Binding constraint | Design consequence |
|---|---|---|---|
| **Supabase** | 500MB database · 1GB storage · 5GB egress · 50k MAU · **pauses after 7 days idle** | **500MB database** | Vector dimensions and `halfvec` matter (§3). Keep-alive cron (§2) |
| **Groq** | Per-model RPM / TPM / RPD | **TPM (tokens per minute)** | **AI context budget drops to ~6k tokens** (§4) |
| **Embeddings** | Local model — no quota at all | Worker RAM | 384-dim model, quantized (§3) |
| **Fly.io / Koyeb** | Small always-on instance | **RAM (256–512MB)** | API + worker in one process; queue must be light |
| **Cloudflare Pages** | Unlimited bandwidth, no cold start | — | Frontend is genuinely unconstrained |
| **Upstash Redis** | Low daily command cap | Command count | **Not used.** Presence heartbeats alone would exhaust it (§5) |
| **Resend** | 3k/month, 100/day, needs a verified domain | Domain requirement | **Email deferred / optional** (§6) |
| **Sentry** | 5k errors/month | — | Fine |
| **GitHub Actions** | 2,000 min/month private, unlimited public | — | Fine. Also runs the keep-alive cron |

**Total cost: $0/month**, versus ~$70 for the paid plan.

---

## 2. Supabase free tier

### The 7-day pause — the biggest practical annoyance

Free projects pause after 7 days without activity, and resuming is manual. For a personal
project that gets touched in bursts, this bites constantly.

**Fix:** a GitHub Actions cron that runs a trivial query every 3 days.

```yaml
# .github/workflows/keepalive.yml
on:
  schedule: [{ cron: "0 6 */3 * *" }]
  workflow_dispatch:
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sf "$SUPABASE_URL/rest/v1/profiles?select=id&limit=1" \
            -H "apikey: $SUPABASE_ANON_KEY" > /dev/null
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
```

Free, and it doubles as a liveness canary.

### The 500MB database budget

This is the real ceiling, and it is mostly consumed by embeddings rather than messages.

| Data | Per row | 50k messages |
|---|---|---|
| `messages` (incl. `tsvector`, indexes) | ~500 B | **~25 MB** |
| `message_embeddings` as `vector(384)` | ~1.5 KB | ~75 MB |
| `message_embeddings` as **`halfvec(384)`** | ~0.8 KB | **~38 MB** |
| HNSW index (roughly 1.5–2× the vector data) | — | **~60 MB** |
| `chunk_text` | ~300 B | ~15 MB |
| Everything else (workspaces, members, notifications) | — | ~15 MB |
| **Total with `halfvec`** | | **~155 MB** |
| **Total with `vector(384)`** | | **~190 MB** |
| *(with 1024-dim vectors as originally planned)* | | *~450 MB — the whole budget* |

**Two decisions follow, and both are in [database-design.md](./database-design.md) §11:**

1. **384 dimensions, not 1024.** A 1024-dim embedding would consume the entire free tier on its
   own. `bge-small-en-v1.5` at 384 dims is competitive on retrieval benchmarks — measurably
   below a frontier 1024-dim model, but by a margin that the golden-set evaluation
   ([ai-architecture.md](./ai-architecture.md) §6) can actually quantify rather than guess at.
2. **`halfvec(384)` rather than `vector(384)`.** pgvector's half-precision type is 2 bytes per
   dimension instead of 4 — **half the storage and half the index size**, with recall loss small
   enough to be within noise at this scale. Verify with the golden set; revert to `vector` if
   recall drops meaningfully.

**Retention keeps this bounded.** The `cleanup.orphans` job already purges soft-deleted messages
and orphaned uploads ([database-design.md](./database-design.md) §14). On free tier, add a
`pg_database_size()` metric and a warning at 400MB.

### Connection limits

The free tier's direct connection limit is low. **Supavisor transaction-mode pooling is
mandatory, not optional** — this was already the design
([scalability.md](./scalability.md) §2), but on free tier it is what makes the app work at all
rather than a scaling nicety.

---

## 3. Embeddings — local, not an API

**Groq does not offer an embeddings endpoint.** It is an inference provider for chat models. So
the embedding half of the RAG pipeline needs its own answer.

**Recommended: run the embedding model locally in the worker** via
[`@huggingface/transformers`](https://github.com/huggingface/transformers.js) (Transformers.js)
with `Xenova/bge-small-en-v1.5` — 384 dimensions, quantized to ~25–35MB on disk.

**Why local wins here, beyond cost:**

| | Local (Transformers.js) | Hosted embedding API |
|---|---|---|
| Cost | **$0, forever** | Free tier with a quota |
| Rate limit | **None** | RPM caps that throttle backfill |
| Backfill of 50k messages | Runs as fast as CPU allows | Days, spread across quota windows |
| **Privacy** | **Message text never leaves our infrastructure at index time** | Every indexed message is sent to a third party |
| Cost | RAM: ~150–250MB peak | ~0 RAM |

The privacy row is a genuine security improvement over the earlier plan, and it sharpens the
claim in [ai-architecture.md](./ai-architecture.md) §4 Rule 6: with local embeddings, the **only**
text that leaves our infrastructure is the handful of retrieved chunks sent to Groq at query
time. Indexing is entirely internal.

**The catch is RAM.** On a 512MB instance running the API too, 250MB for the embedding model is
tight. Mitigations in order:

1. Use the **quantized** model (`dtype: 'q8'`) — the default in Transformers.js and adequate for
   retrieval.
2. **Lazy-load** the model on first embedding job and keep it warm; do not load it at boot.
3. If RAM is genuinely short, **split the worker onto its own small instance** — Fly's allowance
   covers more than one machine, and the worker can be much smaller than the API.
4. Fallback: a hosted embedding free tier (Google's `text-embedding-004` free tier is the usual
   choice, 768 dims). Costs the privacy property and adds a rate limit to backfill. Only if
   local proves unworkable.

**Decision to make at Phase 7, not now** — but the schema commits to 384 dimensions either way,
so a fallback provider must be configured to output 384 (`text-embedding-004` supports
`outputDimensionality`).

---

## 4. Groq — the AI provider

Fast (LPU inference, genuinely good for streaming summaries), generous, and free. The constraint
is different in kind from a paid API: **you are limited by tokens per minute, not by dollars.**

### The design consequence: the context budget drops

The paid plan budgeted ~15–18k input tokens per Q&A request. On a free tier where the per-minute
token allowance for a 70B-class model is in the low tens of thousands, **a single request of
that size can exceed the entire per-minute allowance**, producing 429s under any real use.

**Revised budget: ~6k input tokens per request.**

| | Paid plan | Free tier |
|---|---|---|
| Retrieved chunks after fusion | 20 | **8–10** |
| Neighbour context per chunk | ±3 messages | **±1 message** |
| Input tokens | ~15–18k | **~6k** |
| Output tokens | 1024 | **768** |
| Catch-up window | 500 messages | **200 messages**, chunked if larger |

**This is a quality trade, and it should be measured rather than assumed.** Fewer chunks means
lower recall in the context window even when retrieval itself is good. The golden-set evaluation
([ai-architecture.md](./ai-architecture.md) §6) measures retrieval and answer quality separately
precisely so this trade is visible: if recall@20 is high but answers degrade, the context budget
is the cause, not the retriever.

### Rate limiting becomes queueing

On a paid tier, exceeding your budget is a cost problem you cap. On a free tier, exceeding RPM
is a **429 in the user's face**. So:

- **AI requests go through the job queue**, not straight to the provider. The socket streams the
  result when it is ready ([realtime-architecture.md](./realtime-architecture.md) §4).
- A **token-bucket limiter in front of the Groq client**, configured below the published limits,
  smooths bursts instead of failing them.
- **429 → exponential backoff with jitter**, retried by the queue rather than surfaced.
- The UI says *"summarizing…"* and streams when ready. For a personal project a 3-second wait is
  fine; an error is not.
- **Caching matters more than it did for cost reasons** — the `(channel_id, last_read_seq,
  last_message_seq)` cache key now protects a daily request quota, not a bill.

### Model choice

A 70B-class instruct model (e.g. `llama-3.3-70b-versatile`) for summarization and Q&A; a smaller,
faster model for cheap classification-style work if it is ever needed. **Check Groq's current
model list and per-model limits before Phase 7** — availability rotates.

**Structured output is the weak spot.** Action-item extraction relies on schema-conformant
output. Open models are less reliable at this than frontier models, so:
- Use JSON-schema / structured-output mode where the model supports it.
- **Validate every response with zod** and retry once on a parse failure.
- Treat action-item extraction as the **lowest-priority AI feature** (it already is — 7.6) and be
  willing to cut it if quality is poor. Do not ship an extractor that invents assignees.

### Provider abstraction

Everything above goes behind one interface, so the provider is a config value:

```ts
interface LlmProvider {
  complete(req: { system: string; messages: Msg[]; maxTokens: number }): Promise<string>;
  stream(req: …): AsyncIterable<string>;
}
```

`GroqProvider` is the implementation. A hosted frontier model becomes a drop-in swap if the
project ever outgrows free tier — and the context budget widens again at the same time. This is
worth building on day one of Phase 7: it is ~50 lines and it is what keeps the AI decision
reversible.

---

## 5. Redis is deferred, and the queue changes

### Why no Redis

Redis existed in the architecture for **one reason: coordinating multiple API instances**
([scalability.md](./scalability.md) §1). On free tier we run **one instance**. So its entire
purpose is absent.

And the free Redis tiers do not fit the workload anyway. Presence heartbeats at one per 25
seconds per connected user are ~3,500 commands per user per day — a handful of users would
exhaust a typical free command allowance on presence alone, before any queue traffic.

**So: no Redis until horizontal scaling is actually needed.**

| Need | Paid plan | Free tier |
|---|---|---|
| Socket.IO cross-instance fan-out | Redis adapter | **Not needed** — one instance |
| Presence | Redis sets | **In-process `Map`**, behind `PresenceStore` |
| Typing | Redis TTL keys | **In-process `Map`** with timers |
| Rate limiting | Redis counters | **In-process** counters |
| Idempotency fast path | Redis | **Dropped** — the unique constraint was always the guarantee |
| Permission cache | Redis | **In-process LRU**, 5-minute TTL |
| Job queue | BullMQ on Redis | **pg-boss on Postgres** (§5.2) |

**This is the same design, with a different backing store.** The `PresenceStore` interface was
already specified in Phase 1 precisely so the implementation could be swapped
([realtime-architecture.md](./realtime-architecture.md) §6) — that decision was made to avoid
repeating debt item D12, and it pays off here immediately. Adding Redis later is a constructor
change plus one line for the Socket.IO adapter.

**What is genuinely lost:** the app cannot run more than one instance. That is stated plainly
rather than hidden — it is the correct trade for a personal project, and the architecture keeps
the door open.

### 5.2 pg-boss instead of BullMQ

BullMQ requires Redis. **pg-boss** is a job queue built on Postgres — the database we already
have.

**Why it fits here:**
- **No new infrastructure.** Zero additional services, zero additional accounts.
- Real queue semantics: retries, exponential backoff, scheduling, repeatable jobs, dead-letter
  handling, concurrency limits. Everything the design needs
  ([scalability.md](./scalability.md) §5).
- Job state is in the same transaction boundary as the data, which makes *"insert the message and
  enqueue the fan-out atomically"* trivially correct — something BullMQ cannot do.

**Costs, honestly:**
- Job tables consume the 500MB budget. Small (job rows are tiny) and pg-boss archives and deletes
  completed jobs on a schedule — but the retention settings must be configured, not left at
  default.
- Polling adds baseline database load. At personal-project volume this is negligible.
- **Needs care with transaction-mode pooling.** pg-boss maintains its own connection for
  maintenance work; give it a small dedicated pool on the direct connection rather than sharing
  the Supavisor transaction pool.
- Lower throughput ceiling than Redis — thousands of jobs/minute rather than tens of thousands.
  Far above what this project produces.

**Keep it behind a `Queue` interface.** Swapping to BullMQ when Redis arrives should be one
adapter, not a rewrite of every job handler.

---

## 6. Email is optional

Resend's free tier is 3,000/month — plenty. The obstacle is that sending from a custom address
requires a **verified domain**, and the shared testing sender can only deliver to your own
address.

**Decision: email moves from P1 to optional in Phase 5.** In-app notifications deliver the
actual value; email is the least important notification channel for a personal project and the
only one that requires buying a domain.

Phase 5 still builds the `email.send` job and the templates — the work is small and the
integration point should exist — but ships with the provider disabled behind
`FEATURE_EMAIL=false`. Turning it on later is adding an API key and verifying a domain.

**Consequence for the digest feature (N7):** deferred with it. No loss — a daily digest for a
workspace you are the only member of is not a feature.

---

## 7. Hosting

The API is a long-lived process with **WebSockets**, which rules out most serverless free tiers
and makes cold starts genuinely disqualifying.

| Option | Fit | Notes |
|---|---|---|
| **Fly.io** ✅ recommended | Good | Small always-on machines; WebSockets are first-class; the allowance covers an API machine plus a small worker. Verify current free terms |
| **Koyeb** ✅ alternative | Good | Free instance that does not sleep; simple deploys |
| **Oracle Cloud Always Free** | **Most resources** | 4 ARM cores / 24GB RAM, always on — by far the most generous free compute available. Requires managing a VM (Docker, nginx, TLS). Worth it if you want the ops experience; more work otherwise |
| **Render free** ❌ | **Poor** | Spins down after ~15 minutes idle, ~50s cold start. **Fatal for a WebSocket chat app** — every visit after a quiet period starts with a minute of nothing |
| **Cloudflare Pages** ✅ frontend | Excellent | Unlimited bandwidth, no cold start, global |

**Recommended topology:**

```text
        Cloudflare Pages          (React build, same apex domain)
                 │  /api/*  and  /socket.io/*  proxied
                 ▼
        Fly.io  ── api      (512MB, always on)  ← Express + Socket.IO + pg-boss workers
                └─ worker   (256MB, optional)   ← split out only if RAM demands it
                 │
     ┌───────────┴────────────┐
     ▼                        ▼
  Supabase                  Groq
 (pg + auth + storage)     (LLM inference)
```

**API and worker in one process to start.** pg-boss workers run inside the Express process
behind a `RUN_WORKERS=true` flag. Splitting them is a deploy-config change, not a code change —
and the flag means the split can happen the moment RAM or the embedding model demands it.

Same-origin frontend remains strongly preferred so `sameSite=strict` cookies survive
([target-architecture.md](./target-architecture.md) §10).

---

## 8. Storage limits

Supabase free: **1GB file storage, 5GB egress/month.**

| Setting | Paid plan | Free tier |
|---|---|---|
| Max upload size | 25MB (100MB admin) | **5MB** |
| Attachments per message | 10 | **4** |
| Thumbnail generation | Yes | Yes — and it now also reduces egress |
| Orphan cleanup | 24h | **6h** — reclaim faster |
| Virus scanning | ClamAV in the worker | **Cut** — signature databases want more RAM than the whole instance ([security-model.md](./security-model.md) §9) |

Egress is the sleeper constraint: 5GB/month sounds ample until images are re-fetched on every
scrollback. **Cache-Control headers on signed URLs and aggressive thumbnail use are what keep
this inside the tier**, and thumbnails now earn their keep twice.

---

## 9. What breaks first, in order

Honest failure ordering as the project grows, so effort goes to the right place:

| # | Limit hit | Symptom | Fix |
|---|---|---|---|
| 1 | **Groq TPM** | AI features queue and feel slow | Shrink context further, or upgrade the provider |
| 2 | **Supabase 500MB** | Writes fail | Retention, `halfvec`, purge embeddings for old channels, or upgrade ($25) |
| 3 | **Instance RAM** | OOM restarts, usually during embedding backfill | Split the worker onto its own machine |
| 4 | **Supabase egress 5GB** | Throttling | Thumbnails, caching, or upgrade |
| 5 | **One instance** | Cannot scale horizontally | Add Redis + the Socket.IO adapter — the deferred Phase 4 work |

**Every one of these is fixed by a configuration or plan change, not a rearchitecture.** That is
the point of keeping `PresenceStore`, `Queue`, and `LlmProvider` as interfaces: the free-tier
implementations are swappable, so outgrowing the free tier costs money rather than a rewrite.

---

## 10. Roadmap impact

| Phase | Change |
|---|---|
| 1 | Supabase free project + keep-alive cron. Otherwise unchanged |
| 2 | RLS is a Postgres feature, not a tier feature. **GUEST role cut** |
| 3 | **Group DMs and channel deletion cut. Thread rooms cut** |
| **4** | **Redis removed.** Presence, typing, and rate limiting in-process behind their interfaces. All *behaviour* still ships — multi-device presence, typing, read state, reconnection with gap replay. **Only one `PresenceStore` implementation is written** |
| **5** | **pg-boss instead of BullMQ.** Email built but disabled. **Digest and three-way notification prefs cut; mute stays** |
| 6 | Upload cap 5MB; orphan cleanup at 6h; egress-aware caching. **Virus scanning cut** |
| **7** | **Groq + local Transformers.js embeddings.** 384-dim `halfvec`, ~6k context, queued requests, `LlmProvider` from day one. **Vector-only retrieval first; action-item extraction cut** |
| **8** | **Admin `/stats` page + Sentry instead of a Prometheus stack.** Smoke-level load test. Redis and a second instance deferred until a limit is hit |
| 9 | **Two E2E flows, three drills.** The backup/restore drill matters *more* — free tiers have weaker backup guarantees |

Full cut list and the reasoning: [implementation-roadmap.md](./implementation-roadmap.md),
"Scope discipline". The principle is **cut by retrofit cost, not by current value** — which is
why RLS, the `seq` counter, socket auth, and cursor pagination all survived a scope pass that
removed a third of the feature list.

**Net effect on the timeline: ~15–19 weeks**, down from ~20–26.

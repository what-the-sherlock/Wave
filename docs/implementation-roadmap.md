# Katta — Implementation Roadmap

> **Greenfield rebuild on Supabase/Postgres, running entirely on free tiers.** No data to
> migrate, no environment to preserve. The React frontend is carried forward; the backend is
> written fresh in TypeScript.
> Free-tier budgets and their design consequences: [free-tier-plan.md](./free-tier-plan.md).
> Debt IDs (D1–D25) refer to [current-architecture.md](./current-architecture.md) §9 — design
> lessons from the original code, not live bugs.

---

## Phase dependency graph

```text
Phase 0 — Audit & Architecture          ◄── this document set
   │
   ▼
Phase 1 — Foundation                    ◄── new TS backend · Supabase project · auth proxy
   │        config · errors · validation · logging · tests · socket auth
   │
   ▼
Phase 2 — Workspaces & RLS              ◄── HARD GATE: policy tests + isolation suite green
   │        the highest-value security work in the project
   │
   ▼
Phase 3 — Channels & Messaging
   │        channels · messages · seq · threads · reactions · pagination
   │
   ├───────────────┬───────────────┐
   ▼               ▼               ▼
Phase 4         Phase 5         Phase 6
Real-Time       Notifications   Search & Files
presence        pg-boss         Postgres FTS
typing/read     workers         Supabase Storage
reconnection    (email off)
   │               │               │
   └───────────────┴───────┬───────┘
                           ▼
                  Phase 7 — AI            ◄── HARD GATE: isolation suite green
                           │                  Groq + local embeddings
                           ▼
                  Phase 8 — Observability (+ Redis & scale, only if outgrown)
                           │
                           ▼
                  Phase 9 — Production Hardening
```

**Parallelism.** Phases 4, 5, and 6 are independent once Phase 3 lands. Solo, run 4 → 5 → 6
(real-time correctness first, since notification fan-out depends on the room model). Phase 7
needs 5 (queue) and 6 (search UI).

### Complexity and sizing

| Phase | Complexity | Solo estimate | Risk |
|---|---|---|---|
| 0 — Audit | Low | done | — |
| 1 — Foundation | **Medium** | 2–3 weeks | Low |
| 2 — Workspaces & RLS | **High** | 3–4 weeks | **High** — policy correctness |
| 3 — Channels & Messaging | **High** | 3–4 weeks | Medium |
| 4 — Real-Time | **Medium–High** | 2 weeks | Medium |
| 5 — Notifications & Jobs | Medium | 1.5–2 weeks | Low |
| 6 — Search & Files | **Low–Medium** | 1.5–2 weeks | Low |
| 7 — AI | **High** | 3–4 weeks | **High** — retrieval recall, free-tier limits |
| 8 — Observability | Medium | 1.5–2 weeks | Low |
| 9 — Hardening | Medium | 2 weeks | Low |
| | | **~20–26 weeks** | |

---

## Scope discipline

A personal project on free tiers should build less than a company product. The cuts below are
deliberate, and the principle behind them matters more than the list:

> **Cut by retrofit cost, not by current value.** Anything painful to add to a built system
> stays, even when it looks elaborate. Anything that is a migration and an afternoon later goes,
> even when the design is already written.

### Cut from v1

| Cut | Why | Cost to add later |
|---|---|---|
| **GUEST role** | Its `*:invited_only` permissions are a whole class of conditional RLS policy for a role a personal project never issues | One enum value, one policy branch |
| **Group DMs** (`GROUP_DM`) | A private channel already *is* a group DM. Extra channel type, extra `dm_key` handling, no new capability | One enum value |
| **Channel deletion** | Archive covers the actual need and is reversible | A cascade and a confirm dialog |
| **Ownership transfer** | You are the owner | One endpoint |
| **Virus scanning (ClamAV)** | Signature databases alone want ~1GB RAM — more than the entire instance. The controls that actually matter (allowlist, magic-byte sniffing, private bucket, separate origin) all stay | A worker step |
| **Digest emails** | A daily digest of a workspace where you are the only member | A repeatable job |
| **Three-way notification prefs** | `ALL`/`MENTIONS`/`NONE` per channel is a settings screen nobody opens. **Mute stays** | An enum column |
| **Action item extraction** (7.6) | The AI feature most dependent on reliable structured output, which is where open models are weakest. Already last in the order | A service + a prompt |
| **Thread rooms** (`th:{id}`) | Lazy join/leave on thread open is a second room lifecycle. Broadcasting replies to `ch:{id}` and filtering client-side is indistinguishable at this scale | A room type |
| **Custom status, `@here`, per-workspace retention settings** | Polish | Trivial |

### Simplified, not cut

| Was | Now | Rationale |
|---|---|---|
| Hybrid retrieval (vector + FTS + RRF) from the start | **Vector-only first**; add FTS fusion *only if* the evaluation shows it is needed | Two query paths is the most complex part of the AI layer. Earn it with a measurement |
| 40-question golden set, LLM judge, CI regression gate | **~15 questions, recall measured by hand at Phase 7** | Still answers "did 384-dim/halfvec/6k-context hurt?" — which is the actual question. The CI gate is machinery for a team |
| Prometheus + Grafana + 12 metrics | **Structured logs + Sentry + a handful of gauges on an admin page** | One instance, a few users. Health endpoints stay |
| k6 + artillery, 5,000 sockets, reconnect storm | **Smoke-level load test, ~50 concurrent** | A 512MB free instance cannot generate the old numbers, and you will not have 5,000 users |
| Chaos drills + a runbook per alert | **Three drills: restart, quota exhaustion, restore-from-backup** | The restore drill is the one that matters, given how this project started |
| E2E across every critical flow | **Two flows: signup→workspace→channel→message, and search** | Highest value per minute of maintenance |

### Where I over-engineered, not the free tier

Three of these were my own excess and are worth naming separately:

1. **Two `PresenceStore` implementations.** I proposed writing `RedisPresenceStore` in Phase 4
   and not deploying it. That is writing code you do not run. **The interface is the insurance;
   the second implementation is speculation.** Only `InMemoryPresenceStore` gets written.
2. **The full metrics catalogue.** Twelve Prometheus metrics and a hosted dashboard for a
   single-instance app with a handful of users is instrumentation cosplay.
3. **The 5,000-socket load test.** Specified against a scale this deployment cannot reach and
   this project will never see.

### Not cut, and worth defending

These look like the "enterprise" parts and are the first things a simplification pass reaches
for. They stay, because each is cheap to build now and brutal to retrofit:

| Kept | Cost now | Cost to retrofit |
|---|---|---|
| **RLS policies + isolation test suite** | Declarative SQL, written once per table | Auditing every query in a built app. **This is the project's whole point** |
| **`seq` counter + idempotency** | ~30 lines in one Postgres function | Changes the message schema and every client that renders it |
| **Socket cookie handshake auth** | ~15 lines | Changes the entire auth story, and it is debt item D1 |
| **Cursor pagination** | One index, one query shape | The app visibly breaks at ~1,000 messages |
| **`withRlsScope` + the pooled-connection leak test** | ~20 lines, test included | It catches a silent cross-tenant leak. Nothing else does |
| **Service/repository layering** | A directory convention | Touching every file |
| **Virtualized message list** | One library | A busy channel janks and you rewrite the renderer |
| **Config validation, error middleware, structured logging** | An afternoon each | Debugging production without them |

### Revised sizing

| Phase | Was | Now |
|---|---|---|
| 1 — Foundation | 2–3 wks | **2 wks** |
| 2 — Workspaces & RLS | 3–4 wks | **2.5–3 wks** |
| 3 — Channels & Messaging | 3–4 wks | **3 wks** |
| 4 — Real-Time | 2 wks | **1.5 wks** |
| 5 — Notifications & Jobs | 1.5–2 wks | **1 wk** |
| 6 — Search & Files | 1.5–2 wks | **1.5 wks** |
| 7 — AI | 3–4 wks | **2–3 wks** |
| 8 — Observability | 1.5–2 wks | **1 wk** |
| 9 — Hardening | 2 wks | **1.5 wks** |
| **Total** | ~20–26 wks | **~15–19 wks** |

Phases 8 and 9 are now thin enough that **merging them is reasonable** if you prefer nine phases
to ten. They are kept separate here only to avoid renumbering cross-references across ten
documents.

### What the restart changed

| | Original (MongoDB, evolve) | Now (Supabase, greenfield) |
|---|---|---|
| Total | ~24–31 weeks | **~21–27 weeks** |
| Phase 3 | 4–5 weeks, **highest risk in the project** (live data migration, dual-read shim, backfill, soak period) | 3–4 weeks, medium risk. **The migration workstream is deleted** |
| Phase 1 | Included ~1 week of auth implementation | Auth is Supabase's. Time goes into the backend skeleton instead |
| Phase 6 | Atlas Search index + R2 setup | Postgres FTS is a generated column. Simpler |
| Tenant isolation | Discipline + tests compensating for the database | **Enforced by RLS**, verified by tests |
| Highest risk | Data migration | **RLS policy correctness** |

The risk did not disappear — it moved from "will we lose user data" to "are the policies right".
That is a much better trade: policy errors are caught by tests in CI, whereas migration errors
are caught in production.

---

# Phase 0 — Audit & Architecture ✅

**Objective.** Understand the original system well enough that no later phase rests on an
assumption, and choose a stack against the actual constraints.

**Deliverables** (this document set): [current-architecture.md](./current-architecture.md) ·
[prd.md](./prd.md) · [target-architecture.md](./target-architecture.md) ·
[database-design.md](./database-design.md) ·
[realtime-architecture.md](./realtime-architecture.md) ·
[security-model.md](./security-model.md) · [ai-architecture.md](./ai-architecture.md) ·
[scalability.md](./scalability.md) · this roadmap.

**Key decisions.** Supabase/Postgres (reversing the initial MongoDB recommendation once the
migration constraint disappeared) · Supabase Auth behind an Express proxy to keep httpOnly
cookies · Socket.IO not Supabase Realtime · RLS as the isolation mechanism · Drizzle · pg-boss ·
Postgres FTS · pgvector · Supabase Storage · Groq with local embeddings · **free tiers
throughout, so no Redis and one instance**. No Elasticsearch, no separate vector DB, no
microservices, no Kubernetes.

**Definition of done**
- [x] Every source file of the original read and catalogued
- [x] Database decision made, then **revisited** when the premise changed
- [x] Stack chosen against constraints, with rejections justified
- [ ] **Reviewed and approved** ← the gate on Phase 1

---

# Phase 1 — Foundation

**Objective.** Stand up a new, correct backend skeleton and a fresh Supabase environment. Nothing
user-facing beyond parity with the original app's login and profile.

> The original's socket bypass (D1) is not a live exploit any more — nothing is deployed. It
> remains the design lesson that shapes this phase: **the authenticated socket handshake ships
> in Phase 1, before any feature work**, because "read the user id from the handshake query" is
> the path of least resistance and is exactly what gets written again under time pressure.

### Features
Sign up, log in, log out, password reset, profile editing. Parity with what exists — the point of
this phase is the substrate underneath.

### Backend changes
| Area | Work |
|---|---|
| Project | New TypeScript backend, npm workspaces, strict `tsconfig` |
| Supabase | Project created; local stack via `supabase start`; CLI migrations wired into CI |
| Schema | `profiles` + the `handle_new_user` trigger ([database-design.md](./database-design.md) §3) |
| Auth | **Express proxy over Supabase Auth**, tokens in httpOnly cookies ([target-architecture.md](./target-architecture.md) §6) |
| Auth | JWT verification via cached Supabase JWKS; server-side refresh near expiry |
| DB access | Drizzle + `pg` over the Supavisor pooler; `withRlsScope` transaction wrapper |
| Config | zod-validated env, fail-fast at boot; **`service_role` in a separate module the API cannot import** |
| Errors | `AppError` hierarchy + centralized error middleware. No try/catch in controllers |
| Validation | zod on every route; `express.json({ limit: '256kb' })` — deliberate, not inherited (D7) |
| Security | `helmet()` + CSP; CORS from config; in-process rate limiting |
| Logging | pino + pino-http, `requestId` via `AsyncLocalStorage`; redaction configured |
| Health | `/healthz`, `/readyz` |
| Layering | `routes → controllers → services → repositories`; ESLint bans DB access outside `repositories/` (D15) |
| Realtime | Socket.IO with **cookie handshake verification**; `u:{userId}` rooms; ack/error wrapper; `PresenceStore` interface with an in-process implementation |

### Frontend changes
- TypeScript enabled (`allowJs`), `lib/` and stores converted first.
- **axios response interceptor**: 401 → refresh → retry once → on failure clear and redirect.
  Fixes the original's "expired token = permanently broken page" (D6/D11 lesson).
- `error.response?.data?.message ?? 'Something went wrong'` everywhere (D11).
- `<RequireAuth>` wrapper replacing inline route ternaries.
- Login/SignUp repointed at the auth proxy. **No `supabase-js` in the browser**
  ([target-architecture.md](./target-architecture.md) §5).
- Socket connects with `withCredentials: true` and **no `query` parameter** (D1).
- Fix `onlineUsers.length - 1` (D21).
- App-root error boundary; TanStack Query wired for the session query.

### Database changes
`profiles` table, trigger, RLS enabled with self-and-shared-workspace policies (the workspace
half activates in Phase 2). Migrations directory established — **the artefact that makes losing
an environment recoverable**, which is the concrete lesson of this restart.

### Real-time changes
Authenticated handshake, personal rooms, error/ack wrapper. No workspace concept yet.

### Infrastructure
`docker-compose` for the API; `supabase start` supplies Postgres, Auth, and Storage locally.
GitHub Actions: lint → typecheck → migrate → test → build, **plus the Supabase keep-alive cron**
([free-tier-plan.md](./free-tier-plan.md) §2) so the free project never pauses.
**No Redis** — not in this phase, and not in any phase unless the project outgrows one instance.

### Testing
- Vitest in both workspaces; Supertest harness with cookie helpers.
- Integration tests against the **real local Supabase stack** — real Postgres, real policies.
- Auth: signup, login, wrong password, expired token → **401 not 500**, refresh rotation, logout
  clears cookies and revokes the session.
- **Socket auth: a forged `handshake.query.userId` is ignored; identity comes from the cookie.**
  The D1 regression test.
- Config validation; error mapper; `withRlsScope` sets and clears transaction-local settings.
- Target ~60% on `services/` and `middleware/`. Not a global coverage number.

### Security
Delivers the Phase 1 P0s from [security-model.md](./security-model.md) §11: httpOnly cookie
auth, socket handshake verification, fail-fast config, `service_role` isolation, helmet + CSP,
zod validation, body limits.

### Deployment
Fresh Supabase project (free) · Fly.io service · Cloudflare Pages frontend. **Not Render** — it
sleeps after 15 minutes idle, which is fatal for WebSockets
([free-tier-plan.md](./free-tier-plan.md) §7).
Env: `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `COOKIE_DOMAIN`, `CORS_ORIGINS`, `LOG_LEVEL`.
**Credentials go into the host's secret manager and a `.env.example` is committed** — the
specific failure that caused this restart.

### Dependencies
Phase 0 approval.

### Definition of done
- [ ] A forged `handshake.query.userId` cannot impersonate anyone (test proves it)
- [ ] Auth tokens are in httpOnly cookies; no token is readable from `document.cookie`
- [ ] An expired token returns 401 and the frontend silently refreshes or redirects
- [ ] The process refuses to boot with a missing or invalid env var
- [ ] `service_role` is unreachable from any HTTP request path (ESLint-enforced)
- [ ] Every endpoint validates input with zod
- [ ] No `console.log`; all logs structured JSON with a `requestId`
- [ ] `/healthz` and `/readyz` correct
- [ ] `supabase db push` from empty → working schema, verified in CI
- [ ] A new developer runs the full stack locally in under 10 minutes
- [ ] CI green: lint, typecheck, migrate, test, build

---

# Phase 2 — Workspaces & Row-Level Security

**Objective.** Introduce tenancy **and the mechanism that makes it safe**. This is the phase
where the project's central security property is established.

> **The highest-value work in the entire roadmap.** Everything built after this inherits
> isolation; anything built before it would need re-auditing once policies land. That ordering is
> deliberate.

### Features
Create a workspace · switch workspaces · invite by email or link · accept an invite · member
directory · roles (**OWNER/ADMIN/MEMBER** — GUEST cut) · leave · workspace settings.

### Backend changes
- Tables: `workspaces`, `workspace_members`, `invites`
  ([database-design.md](./database-design.md) §4).
- **`SECURITY DEFINER` helper functions** — `is_workspace_member`, `workspace_role_of` — with
  `search_path = ''`, breaking the RLS recursion trap (§5.1).
- **RLS policies on all three tables**, using `(select auth.uid())` for InitPlan evaluation.
- Repositories and services for workspace, member, and invite.
- Middleware: `resolveWorkspace` (404 for non-members) and `authorize(permission)`.
- Permission table; **handlers check permissions, never roles** — which is precisely what makes
  adding GUEST later a table edit rather than a search-and-replace.
- Branded TS types `WorkspaceId` / `UserId` / `ChannelId`.
- Workspace creation as a **transaction**: workspace + OWNER membership + `#general` placeholder.
- Invite tokens stored as SHA-256 hashes; acceptance via a `SECURITY DEFINER` function (the
  invitee is not yet a member, so RLS would otherwise refuse).
- Routes under `/api/v1/workspaces/*`.

### Frontend changes
- Workspace switcher; active workspace in `useWorkspaceStore` and the URL (`/w/:slug/...`).
- Pages: create workspace, accept invite, members list, settings.
- `<RequireWorkspace>` route wrapper.
- TanStack Query hooks: `useWorkspaces`, `useWorkspaceMembers`, `useInvites`.
- Role-aware UI — **cosmetic only; the server and the database are the authority**.

### Database changes
Three tables, their policies, the helper functions, and the indexes that back the policy
predicates (`wm_user_ws_idx` leading with `user_id` — §6). **A CI check fails the build if any
table in `public` lacks RLS.**

### Real-time changes
`workspace.join` with membership verified through an RLS-scoped query · `ws:{workspaceId}` rooms ·
`workspace.member.joined`/`removed` · **`socketsLeave` on removal**, because RLS governs database
reads and not socket fan-out ([realtime-architecture.md](./realtime-architecture.md) §3).

### Infrastructure
Resend for invite emails (sent synchronously this phase; moves to the queue in Phase 5).

### Testing — **the phase's most important deliverable**
- **SQL policy tests**: set `request.jwt.claims` to user A, assert zero visible rows from
  workspace B, per table ([security-model.md](./security-model.md) §7.1).
- **API adversarial suite** with `collectWorkspaceScopedRoutes` enumerating the router at
  runtime, so new endpoints are covered automatically.
- **The pooled-connection scope-leak test** — two interleaved requests on one pool, each seeing
  only its own rows. This targets the specific failure mode transaction-mode pooling introduces.
- Permission matrix: every role × every permission.
- Invites: accept, double-accept, expired, revoked, wrong email, exceeded uses.
- Workspace creation atomicity under forced failure.
- RLS recursion: the helper functions do not stack-overflow (fails loudly on first run if wrong).

### Security
Delivers T1, T4, T12, T15. The 404-not-403 convention, which RLS makes the natural outcome.

### Deployment
Migration then deploy. Feature-flagged (`FEATURE_WORKSPACES`) so the UI can ship dark.
**Rollback:** flag off; new tables are inert.

### Dependencies
Phase 1 complete.

### Definition of done
- [ ] **SQL policy tests and the API isolation suite both pass, and both gate merges**
- [ ] A user in Workspace A gets 404 (never 403, never 200) on every Workspace B resource
- [ ] Runtime route enumeration proves no workspace-scoped endpoint is untested
- [ ] The pooled-connection test proves RLS scope never leaks between requests
- [ ] CI fails if any `public` table has RLS disabled
- [ ] Every `SECURITY DEFINER` function sets `search_path = ''`
- [ ] Policy predicates use `(select auth.uid())` and are index-backed (verified with `explain`)
- [ ] Workspace creation is atomic under forced failure
- [ ] Removing a member evicts their live sockets within one second
- [ ] Invite tokens never stored or logged in plaintext

---

# Phase 3 — Channels & Messaging

**Objective.** Build the core product: channels, messages, threads, reactions, pagination.

> In the MongoDB plan this was the highest-risk phase, because it migrated live DM history into
> channels with a dual-read shim and a soak period. **None of that exists now.** It is ordinary
> feature work against an empty database.

### Features
Public/private channels · join/leave · settings and archiving · **DMs as channels** · message
edit and delete · threads · reactions · mentions · infinite scrollback · jump to message.
*(Cut: group DMs — a private channel is one. Channel deletion — archive covers it.)*

### Backend changes
- Tables: `channels`, `channel_members`, `messages`, `message_reactions`, `message_mentions`
  ([database-design.md](./database-design.md) §4) with their RLS policies.
- `is_channel_member` / `can_read_channel` helper functions.
- **`send_message()`** — the single-statement atomic, idempotent insert with sequence assignment
  (§7). One round trip; a retry does not burn a sequence number.
- `channel.service`: create, join public, invite to private, archive, membership.
- `message.service`: edit (own, or admin), soft delete with tombstone, thread replies with
  `reply_count` maintenance, reaction toggling, mention parsing.
- **Cursor pagination on `seq`**, max limit 100 (D13 lesson).
- DM creation guarded by the `dm_key` unique partial index — no duplicate DM channels under a race.

### Frontend changes
- Sidebar: channels and DMs grouped, unread badges, create-channel modal.
- `ChatContainer` rewritten: `useInfiniteQuery` scrollback, **virtualized list**
  (`@tanstack/react-virtual` — a 10k-message channel cannot be DOM nodes), scroll anchoring.
- Message hover actions: edit / delete / react / reply in thread.
- Thread panel; reaction picker and pills; mention autocomplete.
- **Optimistic send keyed on `clientMsgId`**, reconciled when the real row arrives from HTTP or
  socket, whichever wins (D23).

### Database changes
Five tables, the `(channel_id, seq desc)` index that makes scrollback fast, the FTS generated
column and its GIN index (ready for Phase 6 at zero extra cost), and policies for each table.

### Real-time changes
`ch:{channelId}` rooms only · `message.created/updated/deleted` ·
`message.reaction.added/removed` · `thread.reply.created` (broadcast to the **channel** room,
filtered client-side) · `channel.*` · head sequences returned in the `workspace.join` ack.

### Infrastructure
None new.

### Testing
- Message CRUD; edit/delete permissions (own vs. admin); soft-delete visibility.
- **Idempotency**: the same `clientMsgId` twice → one row, second call returns the first.
- **Ordering**: 100 concurrent sends → 100 distinct gapless sequences.
- **Sequence rollback**: a failed insert does not burn a `seq` (the Postgres-specific improvement).
- Pagination cursor correctness across boundaries — nothing skipped, nothing repeated.
- **Private channel isolation within a workspace**: a workspace member who is not a channel
  member gets 404, enforced by RLS.
- Thread reply counts; reaction toggle idempotence.

### Security
T3, T10, T13. The isolation suite extends to channels and messages.

### Deployment
Migration then deploy, flag `FEATURE_CHANNELS`. **Rollback:** flag off; tables are inert.
No data-migration risk, no soak period, no irreversible step.

### Dependencies
Phase 2 complete.

### Definition of done
- [ ] 100 concurrent sends produce 100 unique gapless sequence numbers
- [ ] Retrying with the same `clientMsgId` never creates a second message
- [ ] A failed insert rolls back the sequence increment
- [ ] Scrollback loads 50 at a time; a 10k-message channel scrolls smoothly (virtualized)
- [ ] A workspace member who is not a channel member gets 404 on a private channel
- [ ] Edit/delete permitted only for the author or a channel admin
- [ ] Threads, reactions, and mentions functional and tested
- [ ] `explain` shows an index scan on `(channel_id, seq desc)` for scrollback

---

# Phase 4 — Production Real-Time

**Objective.** Make real-time correct under failure. **Every behaviour users can perceive ships
here — on one instance, with no Redis.** The multi-instance work moves to Phase 8, because on
free tier it never becomes necessary ([free-tier-plan.md](./free-tier-plan.md) §5).

### Features
Accurate multi-device presence · typing indicators · read receipts and unread counts synced
across devices · **seamless reconnection with no missed messages**.

### Backend changes
- **`InMemoryPresenceStore`** implementing the Phase 1 interface: socket **sets** per user
  (multi-device — the D9 fix), per-workspace rosters, heartbeat, and a sweeper
  ([realtime-architecture.md](./realtime-architecture.md) §6).
- `typing.start` → TTL map entry; debounced `typing.updated` broadcasts **the current set of
  typers**, not deltas.
- `channel.read` → `greatest()` update, echoed to `u:{userId}` for cross-device sync.
- `GET /channels/:id/messages?after={seq}` — the replay endpoint.
- `workspace.join` ack returns per-channel head sequences for gap detection.
- Ack wrappers and per-event socket rate limits; periodic socket re-authentication.

**Only `InMemoryPresenceStore` is written.** The earlier plan had a `RedisPresenceStore` built
and tested but not deployed — that is writing code you do not run. The interface is the
insurance; the second implementation waits until something needs it.

### Frontend changes
- `useSocketEvent` hook with **handler-scoped `off`** (D22).
- Reconnection manager: compare local vs. ack sequences → REST replay only where a gap exists.
- Offline outbox flushed on reconnect with the original `clientMsgId`.
- Presence and typing indicators; unread badges; mark-read on scroll, debounced.
- Connection status indicator.

### Database changes
None. `last_read_seq` and `last_message_seq` already exist from Phase 3 — this is where they earn
their keep.

### Infrastructure
**None new.** No Redis, no additional service, no additional account.

### Testing
- **Multi-device**: two sockets, one user → presence correct; closing one keeps them online
  (the D9 regression test).
- **Reconnection**: disconnect → messages sent → reconnect → gap detected → replay → exactly
  consistent, no duplicates.
- Read state converges across devices.
- Socket rate limits return `RATE_LIMITED` without disconnecting.
- The presence sweeper reaps a vanished client within 60s.
- **Presence tests target the interface, not the implementation**, so a future Redis version
  inherits the suite for free.

### Security
Rooms as the authorization boundary; `socketsLeave` on removal; socket rate limiting; token
expiry mid-connection handled.

### Deployment
One instance. No new environment variables. **Rollback:** a single deploy revert.

### Dependencies
Phase 3 complete.

### Definition of done
- [ ] Two tabs → one online presence; closing one keeps the user online
- [ ] Disconnect 30s → reconnect → every missed message appears exactly once
- [ ] Typing indicators expire without explicit stop events
- [ ] Unread counts consistent across devices
- [ ] Restarting the instance loses no messages; presence self-heals within seconds
- [ ] Presence tests are written against the interface, not the implementation
- [ ] *(deferred: Redis, and two instances behind a load balancer)*

---

# Phase 5 — Notifications & Background Jobs

**Objective.** Move work off the request path and build the notification system. Establishes the
async infrastructure Phases 6 and 7 depend on.

### Features
In-app notifications with unread badge · real-time delivery · **per-channel mute**.
*(Cut: three-way ALL/MENTIONS/NONE preferences, daily digest. Email built but shipped off.)*

### Backend changes
- **pg-boss** on the existing Postgres, behind a `Queue` interface so BullMQ stays a swap
  ([free-tier-plan.md](./free-tier-plan.md) §5.2). Workers run **in the API process** behind
  `RUN_WORKERS=true`; splitting them out is a deploy-config change.
- Queues: `notification.fanout`, `email.send`, `cleanup.orphans`
  ([scalability.md](./scalability.md) §5). *(`digest.daily` cut with the digest feature.)*
- **Enqueue inside the message's transaction** — pg-boss makes "insert the message and queue the
  fan-out, atomically" trivially correct, which a Redis-backed queue cannot do.
- **The worker runs under `service_role`** — it writes notifications for users other than the
  requester, which no single user's RLS scope permits. The bounded, deliberate bypass
  ([security-model.md](./security-model.md) §5).
- `notification.service`: list (paginated), mark read, mark all read, unread count.
- Fan-out worker: resolve mentions, DM targets, thread subscribers → filter by `muted_until` and
  **live presence** → insert → emit → queue email for users offline > 5 min.
- Email templates (React Email) via Resend, **built but shipped disabled** (`FEATURE_EMAIL=false`)
  — sending from a custom address needs a verified domain, which a personal project may not have
  ([free-tier-plan.md](./free-tier-plan.md) §6). The integration point exists; turning it on is
  an API key and a domain.
- **Every handler idempotent** — the queue retries jobs whose worker died after doing the work.
- `cleanup.orphans` carries retention **and the 500MB database-size guard**.
- A minimal queue-status admin page (pg-boss has no Bull Board equivalent), admin-only.

### Frontend changes
Notification bell, dropdown, badge, infinite list · real-time `notification.created` → badge +
toast · **mute control on the channel menu** · browser Notifications API.

### Database changes
`notifications` table with the **partial index on unread** (keeps the badge query small
regardless of history) and its RLS policy (`user_id = auth.uid()` — strictly personal).
`channel_members.muted_until` only — the `notification_pref` enum is dropped.

### Real-time changes
`notification.created` → `u:{userId}` with a running unread total.

### Infrastructure
**None new.** pg-boss creates its own schema in the existing database. Resend account is
optional and only needed when email is switched on.

### Testing
- Fan-out: `@channel` in a multi-member channel → one notification each, respecting mutes.
- **Idempotency: a re-run job does not double-notify.**
- Dead-letter behaviour after max retries.
- **The worker's `service_role` usage does not leak across workspaces** — it writes only for
  users entitled to the source message.

### Security
Notification previews are workspace-scoped. Email rate limits. Signed unsubscribe tokens.
Bull Board behind admin auth.

### Deployment
Same service, `RUN_WORKERS=true`. Env: `FEATURE_EMAIL=false` (plus `RESEND_API_KEY`,
`EMAIL_FROM`, `APP_URL` when enabled).
**Rollback:** `RUN_WORKERS=false` — jobs queue harmlessly in Postgres and drain when re-enabled.
Messaging unaffected.

### Dependencies
Phases 3 and 4.

### Definition of done
- [ ] A mention produces a notification within 2s
- [ ] Muted channels produce nothing
- [ ] Re-running any job produces no duplicates
- [ ] Message-send p95 unchanged by fan-out
- [ ] Failed jobs land in a dead-letter state and alert
- [ ] Queued jobs survive a process restart
- [ ] Disabling workers does not affect messaging
- [ ] *(email verified working when `FEATURE_EMAIL=true`, but shipped off)*

---

# Phase 6 — Search & File Attachments

**Objective.** Make history findable and file sharing work properly. **The cheapest phase**, and
noticeably cheaper than it would have been on MongoDB.

### Features
Full-text message search with filters · user and channel search · drag-and-drop upload with
progress · image previews and lightbox · access-controlled downloads.

### Backend changes
- `search.service` over `websearch_to_tsquery` + `ts_headline` + `ts_rank_cd`
  ([database-design.md](./database-design.md) §10). **RLS supplies the scoping — the query has no
  channel filter, because it needs none.**
- `pg_trgm` for fuzzy user and channel name matching.
- `GET /api/v1/workspaces/:id/search` with filters and highlighting.
- `upload.service`: signed upload URLs, MIME **allowlist**, **5MB size cap** (free-tier storage
  is 1GB), path scheme embedding `workspace_id`/`channel_id`.
- **Path-prefix verification at attach time** — the check that stops a user attaching another
  workspace's object ([security-model.md](./security-model.md) §9).
- `attachment.process` worker: magic-byte sniffing and thumbnails (sharp). **Thumbnails earn
  their keep twice** — they also protect the 5GB monthly egress allowance.
- **No virus scanning.** ClamAV's signature databases alone want more RAM than the whole
  instance. The controls that actually stop the realistic attacks — MIME allowlist, magic-byte
  verification, a private bucket, and serving from a separate origin with
  `Content-Disposition: attachment` — all stay.
- Signed download URLs, 5-minute expiry, after a permission check, with `Cache-Control` set so
  scrollback does not re-fetch images repeatedly.
- `cleanup.orphans` deletes unattached objects after **6h** (faster reclaim on 1GB).

### Frontend changes
Search modal (`Cmd/Ctrl+K`) with filters, highlighting, jump-to-message · drag-and-drop, paste,
progress, cancel · image grid, lightbox, file cards.

### Database changes
**None for search** — the `search_vector` generated column and its GIN index shipped in Phase 3.
Adds `message_attachments` with its RLS policy, plus the Storage bucket policies (§12).

That "none" is the concrete payoff of the FTS-as-generated-column decision: no index build, no
backfill, no reindex job, and **no eventual consistency** — a message is searchable the instant
it is committed.

### Real-time changes
`attachment.ready` → `u:{userId}` when processing completes.

### Infrastructure
Supabase Storage bucket (private) with RLS policies. **No R2, no Cloudinary, no Atlas Search,
no ClamAV.**

### Testing
- Search relevance and **workspace scoping under RLS** (a query cannot return foreign messages).
- Search respects private-channel membership.
- Upload: allowlist rejection, size rejection, **MIME spoofing** (a `.png` that is HTML),
  signed-URL expiry.
- **A path from workspace B cannot be attached in workspace A → 400.**
- Orphan cleanup removes unattached objects and only those.

### Security
T9 in full: allowlist not denylist, magic-byte sniffing, private bucket, separate serving origin,
`Content-Disposition: attachment`, async scanning gating download.

### Deployment
Env: `MAX_UPLOAD_MB`. CSP `imgSrc` gains the Supabase storage domain.
**Rollback:** feature-flag uploads off; search is additive.

### Dependencies
Phase 3 (messages), Phase 5 (worker).

### Definition of done
- [ ] Search returns relevant results in < 500ms and cannot cross a workspace boundary
- [ ] Private-channel messages invisible in search to non-members
- [ ] A newly sent message is searchable immediately
- [ ] A 20MB file uploads with a progress bar
- [ ] A file with a spoofed MIME type is rejected
- [ ] A path from another workspace cannot be attached
- [ ] Downloads require a permission check; the bucket is not public
- [ ] Orphaned uploads cleaned up nightly

---

# Phase 7 — AI

**Objective.** Add AI where it solves a chat-specific problem. **Gated on a green isolation
suite.** Full design: [ai-architecture.md](./ai-architecture.md).

### Features
Semantic search · thread summaries · catch-up summaries · workspace Q&A with citations.
*(Cut: action item extraction — the feature most dependent on reliable structured output, which
is where open models are weakest. Listed as future work.)*

### Backend changes
- `message_embeddings` table using **`halfvec(384)`**, **RLS policy identical to `messages`**,
  HNSW index.
- **Local embedding pipeline**: Transformers.js with `bge-small-en-v1.5`, quantized, lazy-loaded
  and kept warm ([free-tier-plan.md](./free-tier-plan.md) §3). Groq has no embeddings endpoint,
  and running locally means **indexed message text never leaves our infrastructure**.
- `embedding.generate` worker: debounced 30s, batched, skipping trivial content, excluded
  channels, and DMs by default.
- **`LlmProvider` interface with a `GroqProvider` implementation** — built on day one of this
  phase, ~50 lines, and what keeps the AI decision reversible.
- **Token-bucket limiter in front of the provider**, 429 → backoff + queue retry. AI requests are
  **queued, never issued synchronously**, because on free tier a rate limit is routine rather
  than exceptional.
- `retrieval.service`: **pgvector only to begin with**, inside an RLS-scoped transaction — no
  channel list assembled in application code. **10 chunks, ±1 neighbour, ~6k token budget.**
  FTS fusion (RRF) is added *only if* the evaluation shows vector-only misses exact identifiers
  in practice — two query paths is the most complex part of this layer and should be earned by
  a measurement, not assumed.
- `ai.service`: summarize and ask. Citation re-authorization through the same scoped connection.
- Per-user and per-workspace request caps.

### Frontend changes
Search "Ask" mode · "Catch me up" on unread channels · thread summary at `reply_count >= 15` ·
clickable citations that jump to the message · streaming responses · workspace AI on/off.

### Database changes
`message_embeddings` + policy + HNSW index. `channels.ai_excluded`,
`workspaces.settings.aiEnabled`. `hnsw.ef_search` tuned against the golden set.
**A `pg_database_size()` gauge and a warning at 400MB** — embeddings are what consume the 500MB
free tier, so this is where the ceiling gets watched.

### Real-time changes
Streaming AI responses over the socket to `u:{userId}` — long generations exceed a comfortable
HTTP timeout.

### Infrastructure
A Groq API key. **No new datastore, and no embedding vendor** — pgvector is an extension on the
database that already exists, and embeddings run in-process.

### Testing
- **The cross-tenant AI test**: index a message in Workspace B, ask from Workspace A, assert
  neither answer text nor citations contain it.
- **Removed from a channel → AI immediately stops returning its content.**
- Retrieval quality: **recall@10 against a ~15-question golden set, measured by hand once**.
  Enough to answer the only question that matters — *did 384 dimensions, `halfvec`, and a 6k
  context hurt?* — without building a CI evaluation harness for a team of one.
- Citation validity: every cited message exists and is readable by the asker.
- Prompt injection cannot surface unauthorized content.
- Request cap enforcement.

### Security
[ai-architecture.md](./ai-architecture.md) §4 — the six rules. T11 delivered.

### Deployment
Env: `GROQ_API_KEY`, `GROQ_MODEL`, `AI_DAILY_REQUEST_CAP`, `EMBEDDING_MODEL`. Per-workspace flag.
**Watch instance RAM on first deploy** — the embedding model is the largest memory consumer in
the system, and the backfill is when it peaks. Split the worker onto its own machine if it OOMs.
**Rollback:** `aiEnabled = false`. Core messaging is entirely unaffected — AI is a leaf
dependency by design.

### Dependencies
Phases 2, 3, 5, 6. **Hard gate: isolation suite green.**

### Definition of done
- [ ] **The cross-tenant AI test passes and gates merges**
- [ ] Retrieval recall@10 measured on the golden set and judged acceptable (or fusion added)
- [ ] Every answer carries citations; every citation is re-authorized
- [ ] Removing a user from a channel immediately stops AI answers from it
- [ ] Prompt injection cannot surface unauthorized content
- [ ] Request volume metered per workspace with an enforced cap
- [ ] **A provider 429 never reaches the user** — it queues and retries
- [ ] **Indexed message text never leaves our infrastructure** (local embeddings verified)
- [ ] Database stays under 400MB after full backfill, or retention is tightened
- [ ] DMs excluded from indexing by default
- [ ] Every AI feature degrades gracefully when the provider is down

---

# Phase 8 — Observability (and Scale, if outgrown)

**Objective.** Know what production is doing. **The horizontal-scale work is included but
conditional** — on free tier it stays unbuilt until §"what breaks first" limit #5 is actually
reached ([free-tier-plan.md](./free-tier-plan.md) §9).

### Backend changes
- **Sentry** across API and frontend, tagged with `requestId`. This is the single
  highest-value item in the phase — it is how you find out something broke.
- **An admin `/stats` page** with the numbers that actually matter on free tier:
  `pg_database_size` (of 500MB), storage used (of 1GB), queue depth, Groq requests today,
  active sockets. *Replaces the Prometheus + Grafana stack from the earlier plan — twelve
  metrics and a hosted dashboard is instrumentation cosplay for one instance and a few users.*
- Postgres slow-query logging; **`explain (analyze)` on the hot queries to confirm RLS
  predicates are index-backed** — cheap, and the one place a policy regression hides.
- In-process LRU caching per [scalability.md](./scalability.md) §4.
- Graceful shutdown: drain HTTP, close sockets with a reconnect hint, finish in-flight jobs.
- Connection pool tuning against the Supavisor free-tier limit.

**Deferred until a limit is actually hit:** Redis, the Socket.IO adapter, a second instance.
The interfaces make it a constructor change whenever that day arrives.

### Frontend changes
Route-level code splitting · virtualized member lists · Web Vitals reporting.

### Database changes
Indexes added or **dropped** based on `pg_stat_user_indexes` — unused indexes cost write
throughput.

### Testing
**A smoke-level load test, ~50 concurrent users** — enough to catch an unindexed query or a
connection-pool misconfiguration, which are the realistic failures. Plus a **scaled-down
reconnect check**: disconnect every client at once (a deploy does exactly this) and confirm they
all recover with no message loss.

*The earlier plan specified 5,000 concurrent sockets and a 5,000-client reconnect storm. A
512MB free instance cannot generate those numbers, and this project will not see them.*

### Security
Metrics endpoint internal-only; Sentry PII scrubbing; log redaction verified.

### Deployment
Stay at **one instance**. Add the second only when a free-tier limit forces it.

### Dependencies
Phases 4 and 5.

### Definition of done
- [ ] Sentry reporting errors from API and frontend, joined by `requestId`
- [ ] `/stats` shows free-tier headroom at a glance
- [ ] Message-send p95 < 150ms under ~50 concurrent users
- [ ] A mass reconnect recovers with no message loss
- [ ] No unindexed query, and no unindexed RLS predicate, in the slow-query log
- [ ] **A documented upgrade path to two instances** — written down, not built

---

# Phase 9 — Production Hardening

**Objective.** Close the gap between "works" and "operable by someone who did not build it".

### Changes
Findings from the security review and failure drills · accessibility pass (keyboard, ARIA, focus,
contrast) · empty, error, and offline states.

### Testing
- **Playwright E2E, two flows**: (1) signup → create workspace → create channel → send → thread
  → react; (2) search and jump-to-message. Highest value per minute of maintenance; the rest is
  covered by integration tests.
- **Three drills**, each with the expected behaviour written down:
  1. **Restore from backup, timed** — the one that matters most, given how this project started.
  2. Restart the instance under load — presence self-heals, no messages lost, queue drains.
  3. Exhaust the Groq quota — AI degrades, messaging is untouched.

*The earlier plan had a drill and a runbook per alert. Three drills that get actually run beat
ten that get written down once.*

### Security
Full review against [security-model.md](./security-model.md) · `npm audit` + Dependabot +
`gitleaks` (with a Supabase service-role rule) as CI gates · OWASP Top 10 walkthrough ·
optional external pen test · **secret rotation runbook exercised**, including rotating the
`service_role` key.

### Deployment
Rolling deploys · automated backups with a **tested** restore · architecture diagrams · a
`README` that gets a new developer running in under 10 minutes · ADRs for the major decisions,
**including the MongoDB → Supabase reversal and why the premise changed**.

*(Blue/green deploys cut — a brief reconnect on deploy is fine, and the client already handles
it via gap replay.)*

### Definition of done
- [ ] Two E2E flows run in CI
- [ ] All three drills executed with documented behaviour observed
- [ ] Security review complete, all high findings closed
- [ ] **Backup restore tested end to end and timed**
- [ ] **A complete environment can be rebuilt from migrations + secrets in under 30 minutes**
- [ ] Zero high or critical vulnerabilities
- [ ] Architecture docs match the built system

---

## What we are explicitly NOT building

| Not building | Why |
|---|---|
| Voice / video / huddles | A different product with a different stack (SFU, TURN, media servers) |
| Screen sharing | Same |
| End-to-end encryption | Fundamentally incompatible with server-side search and AI retrieval, which are core here. Pick one |
| Mobile apps | The web app should be responsive; native is a separate project |
| Custom emoji / stickers / soundboards | Polish, zero architectural interest |
| Workflow builder / apps platform | An entire product on its own |
| Per-message read receipts | O(users × messages) for marginal value. Watermarks instead ([database-design.md](./database-design.md) §8) |
| Federation / cross-workspace channels | Directly contradicts the isolation model |
| **Direct browser → Supabase table access** | Bypasses the service layer that assigns sequences and triggers fan-out ([target-architecture.md](./target-architecture.md) §5) |
| **Supabase Realtime** | No custom-ack primitive for the gap-replay design; deeper lock-in ([target-architecture.md](./target-architecture.md) §4) |
| **Supabase Edge Functions** | The API is a long-lived process with WebSockets |
| **Redis (for now)** | Its only job is multi-instance coordination, and free tier runs one instance. The `PresenceStore` interface is the insurance |
| **A second API instance (for now)** | Same reason. The upgrade path is documented, not built |
| **Email (for now)** | Needs a verified domain. Built, shipped disabled |
| **GUEST role, group DMs, channel deletion, ownership transfer** | See "Scope discipline" above — each is an enum value or an endpoint to add later |
| **Virus scanning** | ClamAV wants more RAM than the instance has. Allowlist + magic-byte sniffing + private bucket + separate origin stay |
| **Digest emails, three-way notification prefs** | Nobody opens the settings screen. Mute stays |
| **Action item extraction** | Weakest AI feature, most dependent on structured-output reliability |
| **Thread rooms, blue/green deploys, Prometheus/Grafana** | Complexity with no observable benefit at this scale |
| Elasticsearch / Meilisearch | Postgres FTS is sufficient well past this scale |
| Separate vector DB | pgvector under the same RLS is strictly more secure |
| Kafka / RabbitMQ / BullMQ | pg-boss on the database we already have |
| Microservices, Kubernetes, GraphQL, Next.js | Cost without benefit at this scale |

---

## Highest-risk areas

| Risk | Impact | Mitigation |
|---|---|---|
| **RLS policy error** | Systemic cross-tenant leak | SQL policy tests · runtime route enumeration · default-deny CI check · the recursion and `search_path` traps documented before they are hit |
| **Pooled-connection scope leak** | Cross-tenant leak, intermittent and hard to reproduce | `set_config(..., true)` transaction-local, plus a dedicated interleaved-request test |
| **`service_role` key exposure** | Total bypass of RLS | Separate config module, ESLint-enforced · never client-side · `gitleaks` rule · rotation runbook |
| **HNSW + RLS recall** | AI silently returns too few results | Measured against the golden set, gated in CI. *Note: fails toward too few, never too many — a quality risk, not a security one* |
| **Connection pool exhaustion** | Looks like an outage, isn't | Transaction-mode pooling · small per-instance pools · a paging alert at 80% · covered by the reconnect-storm load test |
| **Free-tier ceilings** (Groq TPM, 500MB DB, instance RAM) | Features degrade or writes fail | Ordered failure analysis in [free-tier-plan.md](./free-tier-plan.md) §9 · gauges and warnings ship in Phase 8 · **every fix is a plan change, not a rearchitecture** |
| **Groq structured-output quality** | Action-item extraction produces junk | zod validation + one retry · lowest phase priority (7.6) · **cut the feature rather than ship an extractor that invents assignees** |
| Supabase Auth lock-in | Expensive to leave later | Accepted deliberately. Postgres and Storage are portable; identity is the sticky part |
| Scope creep across 9 phases | Never finishing | Phase gates with concrete DoD checklists · the explicit not-building list |

**Compared to the original plan, the top risk changed from data migration to policy
correctness.** That is a better class of risk: policy errors are caught by deterministic tests in
CI; migration errors are caught in production.

---

## What to implement first

1. **Create the Supabase project, commit the migrations directory, and add the keep-alive cron.**
   The first artefact, because it is the thing whose absence caused this restart — an environment
   that can be rebuilt from source. The cron stops the free project pausing after 7 days.
2. **The backend skeleton**: config validation, error middleware, logging, layering, the
   `withRlsScope` wrapper.
3. **The auth proxy with httpOnly cookies**, then the **authenticated socket handshake** — the
   D1 lesson, built in before there is any feature to attach it to.
4. **The testing harness against the local Supabase stack.** Everything after this is riskier
   without it.
5. **The rest of Phase 1.**

Then stop and re-evaluate before Phase 2, because Phase 2 is where the RLS commitment is made and
where the project's central security property is either established correctly or has to be
revisited later at much greater cost.

# Katta — Product Requirements Document

> **Version:** 1.0 · **Status:** Draft, pending approval · **Phase:** 0
> Technical companion documents are indexed in [README.md](./README.md).

---

## 1. Summary

Katta was a 1:1 direct-message chat application: users sign up, see every other user in the
system, and exchange text and images. About 1,100 lines of code. **Its database and deployment
credentials have been lost, so the project is restarting** — the React frontend is carried
forward, the backend is rebuilt in TypeScript on Supabase/Postgres.

This PRD describes building it into a **team collaboration platform** — organized around
workspaces and channels, with threads, search, notifications, file sharing, and AI-assisted
catch-up and recall.

**The product goal:** something a 10–500 person engineering organization could plausibly adopt.
Not a Slack clone — a focused subset built properly, where "properly" means multi-tenant
isolation that is tested rather than assumed, real-time delivery that survives reconnection,
and AI that respects permissions.

---

## 2. Problem statement

The current product has three structural limits:

1. **No organization.** Every user sees every other user. There is no notion of a team, a
   company, or a boundary. It does not scale past a handful of people who all know each other.
2. **No topic structure.** All communication is 1:1. There is no way for a group to discuss
   something, and no way for someone to catch up on a discussion they were not part of.
3. **Nothing is findable.** No search, no threads, no history navigation. Information sent is
   information lost.

There is also a fourth, non-product problem that shapes the plan: **the real-time layer is
unauthenticated** — any user can receive any other user's live messages by supplying their ID
([current-architecture.md](./current-architecture.md) §9, D1). This is fixed first, before any
feature work.

---

## 3. Users and jobs

| Persona | Primary jobs |
|---|---|
| **Individual contributor** | Ask a question and get an answer · follow relevant discussions without reading everything · find a decision made weeks ago · share a file or screenshot |
| **Team lead** | Catch up after being away · see what their team is discussing · organize channels · onboard a new member |
| **Workspace admin** | Invite and remove people · manage roles · control who sees what · configure the workspace |

**Non-users:** consumers wanting a social chat app, and organizations needing voice/video —
both are explicitly out of scope ([implementation-roadmap.md](./implementation-roadmap.md),
"What we are explicitly NOT building").

---

> **Scope note.** Items struck through below were cut for v1. The reasoning and the cost to add
> each one back is in [implementation-roadmap.md](./implementation-roadmap.md), "Scope
> discipline" — the short version is that things which are cheap to retrofit were cut, and
> things which are expensive to retrofit were kept regardless of how elaborate they look.

## 4. Product principles

1. **Isolation is a feature.** A user must never see anything from a workspace they do not
   belong to. This is the property everything else is built on, and the one thing we test
   adversarially and automatically.
2. **Never lose a message.** Reconnection, retries, and multi-device must converge to exactly
   one copy of the truth.
3. **Real-time should feel instant, background work should be invisible.** Sending a message is
   synchronous; notifying 200 people about it is not.
4. **AI must cite its sources.** An unsourced answer about a technical decision is worse than no
   answer, because someone will act on it.
5. **Degrade, don't fail.** A rate-limited AI provider or a restarted instance should cost
   summaries and presence, not messaging.
6. **Evolve, don't rewrite.** The existing app stays functional throughout.

---

## 5. Functional requirements

### 5.1 Accounts and authentication *(Supabase Auth behind an Express proxy)*

| ID | Requirement | Priority | Source |
|---|---|---|---|
| A1 | Sign up with email, name, password (min 8 chars, common passwords rejected) | P0 | Supabase |
| A2 | Log in / log out; **sessions in httpOnly cookies** | P0 | Our proxy |
| A3 | Short-lived access tokens with silent refresh; an expired session redirects to login rather than breaking the page | P0 | Supabase + our interceptor |
| A4 | Revoke all sessions on password change or "log out everywhere" | P1 | Supabase |
| A5 | Profile: display name, avatar, timezone | P1 | Ours (`profiles`) |
| A6 | ~~Custom status with emoji and expiry~~ — **cut**; polish | — | — |
| A7 | Password reset by email | P1 | Supabase |
| A8 | Email verification | P2 | Supabase |
| A9 | OAuth (Google/GitHub) sign-in | P2 | Supabase + a PKCE callback route |

The "Source" column is the point of the Supabase Auth decision: **six of these nine requirements
are configuration rather than code.** A2 is the exception we deliberately keep ownership of —
the default Supabase SPA pattern stores tokens in `localStorage`, and the httpOnly cookie is
both a stronger property and what the socket handshake authenticates against
([target-architecture.md](./target-architecture.md) §6).

### 5.2 Workspaces

| ID | Requirement | Priority |
|---|---|---|
| W1 | Create a workspace with a name and a unique URL slug | P0 |
| W2 | Belong to multiple workspaces and switch between them | P0 |
| W3 | Invite by email or by shareable link (expiring, use-limited, revocable) | P0 |
| W4 | Accept an invite, joining as the invited role | P0 |
| W5 | Roles: **OWNER, ADMIN, MEMBER** — extensible without code changes to handlers | P0 |
| W6 | View the member directory | P0 |
| W7 | Admins can change roles (never above their own) and remove members | P0 |
| W8 | Removing a member preserves their message history and revokes access immediately, including live sockets | P0 |
| W9 | Leave a workspace | P1 · *ownership transfer cut* |
| W10 | Workspace settings: name, icon, invite policy, retention, AI enablement | P1 |
| W11 | **A user must never access any resource in a workspace they do not belong to** | **P0 — security invariant** |

### 5.3 Channels

| ID | Requirement | Priority |
|---|---|---|
| C1 | Public channels — any workspace member can view and join | P0 |
| C2 | Private channels — invite-only, invisible to non-members | P0 |
| C3 | Direct messages, modelled as two-person channels | P0 *(replaces existing DMs)* |
| C4 | ~~Group DMs~~ — **cut**; a private channel is one | — |
| C5 | Create, rename, set topic and description | P0 |
| C6 | Join and leave; invite others to private channels | P0 |
| C7 | Archive a channel (read-only, hidden from the default list) | P1 |
| C8 | ~~Delete a channel~~ — **cut**; archive (C7) covers it and is reversible | — |
| C9 | A `#general` channel is created automatically with the workspace | P1 |
| C10 | Channel member list | P1 |

### 5.4 Messaging

| ID | Requirement | Priority |
|---|---|---|
| M1 | Send a text message to a channel | P0 *(exists, re-targeted)* |
| M2 | Messages appear in the same order for every viewer | P0 |
| M3 | Edit your own message; an "edited" indicator is shown | P0 |
| M4 | Delete your own message; admins may delete any (tombstone shown) | P0 |
| M5 | Reply in a thread; the parent shows a reply count | P0 |
| M6 | Emoji reactions with counts and who reacted | P0 |
| M7 | `@user` and `@channel` mentions with autocomplete *(`@here` cut)* | P0 |
| M8 | Attach files and images | P0 *(replaces the ~75KB base64 path)* |
| M9 | Infinite scrollback, loaded in pages | P0 |
| M10 | Jump to a specific message (from search or a citation) | P1 |
| M11 | Unread indicators and counts per channel | P0 |
| M12 | Mark a channel read; state syncs across devices | P0 |
| M13 | **Retrying a send never produces a duplicate** | **P0** |
| M14 | **Messages sent while disconnected appear after reconnecting, exactly once** | **P0** |
| M15 | Markdown formatting (bold, italic, code, code blocks, links, lists) | P1 |
| M16 | Pin a message to a channel | P2 |
| M17 | Bookmark/save a message for yourself | P2 |

### 5.5 Real-time

| ID | Requirement | Priority |
|---|---|---|
| R1 | Messages arrive without a refresh, within ~200ms | P0 *(exists, re-architected)* |
| R2 | **Socket connections are authenticated by the session cookie, never by a client-supplied ID** | **P0 — fixes the current bypass** |
| R3 | Online/offline presence, correct across multiple devices and tabs | P0 *(exists but broken for multi-device)* |
| R4 | Typing indicators per channel | P1 |
| R5 | Edits, deletions, and reactions propagate live | P0 |
| R6 | Automatic reconnection with gap recovery | P0 |
| R7 | A visible connection status indicator | P1 |
| R8 | A socket never receives content from a channel the user cannot read | **P0 — security invariant** |

### 5.6 Notifications

| ID | Requirement | Priority |
|---|---|---|
| N1 | In-app notifications for mentions, DMs, thread replies, and invites | P0 |
| N2 | Unread badge with a total count | P0 |
| N3 | Real-time delivery | P0 |
| N4 | ~~Per-channel all/mentions/none preferences~~ — **cut**; N5 covers the real need | — |
| N5 | Mute a channel until a chosen time | P1 |
| N6 | Email for mentions and DMs when the user has been offline > 5 minutes | **Optional** — built, shipped disabled (needs a verified domain) |
| N7 | Daily digest email (opt-in), timezone-aware | Deferred with N6 |
| N8 | Browser push notifications | P2 |

### 5.7 Search

| ID | Requirement | Priority |
|---|---|---|
| S1 | Full-text message search within a workspace | P0 |
| S2 | Filters: channel, author, date range, has attachment | P1 |
| S3 | Result highlighting and jump-to-message | P1 |
| S4 | Search users and channels | P1 |
| S5 | **Results never include messages the user cannot read** | **P0 — security invariant** |
| S6 | Semantic ("find discussions about X") search mode | P2 |

### 5.8 Files

| ID | Requirement | Priority |
|---|---|---|
| F1 | Upload via drag-and-drop, paste, or file picker | P0 |
| F2 | Upload progress and cancellation | P1 |
| F3 | Size limit **5MB** (free-tier storage is 1GB) | P0 |
| F4 | Image thumbnails and a lightbox viewer | P1 |
| F5 | Downloads require a permission check | **P0 — security invariant** |
| F6 | Malicious file types rejected; content type verified, not trusted | P0 |
| F7 | ~~Virus scanning~~ — **cut**; ClamAV needs more RAM than the instance has ([security-model.md](./security-model.md) §9) | — |
| F8 | ~~A workspace file browser~~ — **cut** | — |

### 5.9 AI

| ID | Requirement | Priority |
|---|---|---|
| I1 | **Catch-up summary** — "what did I miss in #backend?", scoped to the user's unread window | P1 |
| I2 | **Workspace Q&A** — natural-language questions answered from message history, with citations | P1 |
| I3 | **Thread summary** for long threads | P1 |
| I4 | **Semantic search** | P1 |
| I5 | ~~**Action item extraction**~~ — **cut for v1**; most dependent on structured-output reliability, where free-tier models are weakest | — |
| I6 | **AI must never surface content the user cannot access** | **P0 — security invariant** |
| I7 | Every answer is cited; citations are clickable | P0 |
| I8 | AI can be disabled per workspace, and channels excluded from indexing | P1 |
| I9 | DMs are excluded from indexing by default | P0 |
| I10 | Per-workspace spend cap | P1 |

---

## 6. Non-functional requirements

| Category | Requirement |
|---|---|
| **Latency** | Message send p95 < 150ms · delivery < 200ms · scrollback page < 300ms · search < 500ms |
| **Availability** | Best-effort for a personal project. AI or queue unavailability degrades features, never messaging |
| **Scale target** | Personal-project scale: tens of users, one instance. The *architecture* supports far more (see [scalability.md](./scalability.md) §7), but nothing is built or tested beyond ~50 concurrent |
| **Durability** | No acknowledged message is ever lost. Daily backups with a **tested** restore |
| **Security** | See [security-model.md](./security-model.md). Tenant isolation is verified by an automated adversarial suite that gates merges |
| **Privacy** | Message content is sent to an LLM provider only for the AI features, only for authorized content, and only when AI is enabled. Embeddings never leave our infrastructure |
| **Accessibility** | Keyboard-navigable, screen-reader labelled, WCAG AA contrast |
| **Browsers** | Last 2 versions of Chrome, Firefox, Safari, Edge. Responsive down to 375px |
| **Observability** | Structured logs with request IDs · metrics · error tracking · health endpoints |

---

## 7. Success criteria

**Product**
- A new user can create a workspace, invite someone, and exchange messages in a channel in under
  3 minutes.
- Catch-up summaries are genuinely faster than reading the backlog.
- Workspace Q&A produces a cited, correct answer for most of the ~15-question golden set.

**Engineering** (the criteria that actually gate each phase)
- The cross-tenant isolation suite is green and blocks merges.
- Message-send p95 < 150ms under ~50 concurrent users.
- A mass reconnect recovers with zero message loss.
- No high or critical vulnerabilities.
- A new developer runs the full stack locally in under 10 minutes.
- **A complete environment rebuilds from migrations + secrets in under 30 minutes** — the
  failure that started this restart.

---

## 8. Constraints and assumptions

**Constraints**
- One part-time developer. Roughly **15–19 weeks** after the v1 scope cuts.
- **Greenfield.** No data to migrate, no environment to keep alive, no backward compatibility.
- **Infrastructure budget: $0.** Every service on its free tier — Supabase, Fly.io, Cloudflare
  Pages, Groq, and local embeddings. Full budget and limits in
  [free-tier-plan.md](./free-tier-plan.md).
- **One instance.** No Redis, no horizontal scaling, until a free-tier limit forces it.
- No Kubernetes. No microservices. One container, one optional second.
- The React frontend is carried forward, not rewritten.

**Assumptions**
- This is a personal project. Availability targets, workspace sizes, and message volumes are
  those of a handful of users, not an organization.
- Workspaces are ≤ 500 members, so `@channel` fan-out stays a single job.
- The Supabase free project is kept awake by a GitHub Actions cron
  ([free-tier-plan.md](./free-tier-plan.md) §2), so the 7-day pause never triggers.
- Postgres connection limits are managed via Supavisor transaction-mode pooling, which
  constrains the query layer (no prepared statements) — reflected in the Drizzle choice.
- **Free-tier terms change.** Every quota in the plan is verified before Phase 1, and the design
  consequences hold even when the numbers move.

**Resolved by the restart**
- ~~How much production data must the Phase 3 migration handle?~~ None. The migration
  workstream is deleted, along with the roadmap's previous highest risk.
- ~~Must existing users' experience be preserved?~~ There are no existing users.

**Open questions**
1. **Is Supabase Auth lock-in acceptable?** Postgres and Storage are portable; identity is not.
   Moving off Supabase Auth later means re-homing user records and forcing a password reset.
   This is the one decision here that is genuinely expensive to reverse.
2. **Same-origin or split-origin frontend?** Serving the React build from the same apex domain
   as `/api` preserves `sameSite=strict` and keeps CSRF a non-issue. A separate CDN origin
   forces `sameSite=none` plus explicit CSRF tokens — recommended against, but it is a
   deployment choice worth making deliberately ([target-architecture.md](./target-architecture.md) §10).
3. **Which AI features survive the free-tier context budget?** ~6k tokens instead of ~15k means
   fewer retrieved chunks per answer. Summaries and Q&A should hold up; **action-item extraction
   is the one at genuine risk**, because schema-conformant output is where open models trail.
   The golden-set evaluation ([ai-architecture.md](./ai-architecture.md) §6) answers this at
   Phase 7 — and cutting 7.6 is an acceptable outcome.

---

## 9. Release plan

| Milestone | Delivers | Phases |
|---|---|---|
| **M1 — Safe to build on** | New TS backend, Supabase project, auth proxy, validation, error handling, logging, tests. Feature parity with the original | 1 |
| **M2 — Teams** | Workspaces, members, roles, invites, **RLS policies** | 2 |
| **M3 — Collaboration** | Channels, threads, reactions, edit/delete, scrollback | 3 |
| **M4 — Production real-time** | Presence, typing, read state, reconnection, multi-instance | 4 |
| **M5 — Awareness** | Notifications, preferences, email | 5 |
| **M6 — Findable** | Search and file attachments | 6 |
| **M7 — Intelligence** | Summaries, Q&A, semantic search | 7 |
| **M8 — Operable** | Metrics, alerts, load testing, scale | 8 |
| **M9 — Hardened** | E2E tests, chaos drills, security review, docs | 9 |

**M1 ships at feature parity with the original app and that is correct.** Its value is the
substrate: a project that can be rebuilt from migrations and secrets, an authenticated socket
handshake, and a test harness. Every subsequent milestone is cheaper and safer because of it.

**M2 is where the product's central security property is established.** Row-Level Security is
what makes "a user from Workspace A cannot reach Workspace B" a database guarantee rather than a
code review convention, and everything built after M2 inherits it.

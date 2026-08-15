# Katta — Real-Time Architecture

> **Socket.IO, not Supabase Realtime** — decision and reasoning in
> [target-architecture.md](./target-architecture.md) §4.
> Greenfield build. The original 37-line implementation
> ([backend/src/lib/socket.js](../backend/src/lib/socket.js)) is replaced, not evolved; its
> failures (D1 unauthenticated, D9 single-device, D12 in-process, D14 O(N²) presence) are the
> design brief for what follows.

---

## 1. Principles

1. **Writes go over REST. The socket is a read/fan-out channel.** The original got this right
   and it is kept. Writes get status codes, retries, idempotency keys, body limits, and standard
   rate limiting for free. Only three client→server events exist, all fire-and-forget hints
   where loss is harmless.
2. **The socket carries no authority the REST layer does not.** Room membership derives from the
   same `channel_members` rows that RLS uses to authorize `GET /messages`. There is no path
   where a socket sees what an HTTP request would refuse.
3. **Every event is workspace-scoped and named `<domain>.<entity>.<action>`.**
4. **Assume every client will miss events.** Design for gap detection and replay, not for
   perfect delivery.
5. **Every shared-state concern sits behind an interface from Phase 1** — `PresenceStore`, the
   rate limiter, the typing registry. On free tier all three are in-process, because one instance
   runs and Redis would have no job ([free-tier-plan.md](./free-tier-plan.md) §5). Writing fan-out
   code that *assumes* a single process is how D12 happened the first time; writing it behind an
   interface makes Redis a constructor change whenever it is needed.

---

## 2. Connection lifecycle and authentication

```text
Client                          Server                        Supabase / Postgres / Redis
  │                               │                                  │
  ├─ io(url,{withCredentials})───▶│                                  │
  │  sb-access cookie sent auto   │                                  │
  │                               ├─ handshake middleware            │
  │                               │  1. parse `sb-access` cookie     │
  │                               │  2. verify JWT via JWKS (cached) │
  │                               │  3. reject on failure ───────────┤
  │                               │     next(new Error("UNAUTHORIZED"))
  │◀── connect ───────────────────┤ socket.data.claims = <verified>  │
  │                               │                                  │
  ├─ emit("workspace.join",       │                                  │
  │        {workspaceId}, ack) ──▶│                                  │
  │                               ├─ withRlsScope(claims): ─────────▶│ Postgres
  │                               │    select id from channels       │  RLS filters to
  │                               │    -- no where clause needed     │  readable rows
  │                               ├─ socket.join([                   │
  │                               │    `u:${userId}`,                │
  │                               │    `ws:${workspaceId}`,          │
  │                               │    ...channelIds.map(c=>`ch:${c}`)])
  │                               ├─ presence: SADD + ZADD ─────────▶│ Redis
  │                               ├─ broadcast presence.updated      │
  │◀── ack {ok, channels,         │                                  │
  │         seqs, presence} ──────┤                                  │
  │                               │                                  │
  │  ── compare local seqs vs ack.seqs → REST replay where gaps ──   │
```

### The handshake middleware

```ts
io.use(async (socket, next) => {
  try {
    const token = parseCookies(socket.handshake.headers.cookie)["sb-access"];
    if (!token) return next(new Error("UNAUTHORIZED"));

    const { payload } = await jwtVerify(token, supabaseJwks, {
      issuer: `${SUPABASE_URL}/auth/v1`,
    });

    socket.data.claims = payload;                 // sub = user id, verified
    socket.data.workspaces = new Map();
    next();
  } catch {
    next(new Error("UNAUTHORIZED"));              // never a 500
  }
});
```

**This is the D1 fix.** Identity comes from a cryptographically verified Supabase JWT in an
`httpOnly` cookie, never from `handshake.query`. The client cannot influence its own identity,
and because the cookie is `httpOnly`, the token is also unreadable by page JavaScript — strictly
better than a token passed in the handshake query, which leaks into URL logs.

The `httpOnly` cookie exists because auth is proxied through Express rather than run in the
browser ([target-architecture.md](./target-architecture.md) §6). **The socket design is the main
reason that proxy is worth building** — it makes REST and WebSocket share one credential.

**Token expiry mid-connection.** Supabase access tokens are ~1 hour. A socket authenticated with
a token that later expires would otherwise stay connected indefinitely. Mitigations:
- Re-verify every 15 minutes; disconnect on failure.
- The client refreshes proactively (the same interceptor the REST layer uses) and emits
  `session.refreshed`, which resets the socket's expiry clock.
- On logout, `io.in('u:'+userId).disconnectSockets()` — immediate, not eventual.

### Every socket query runs under RLS

Socket handlers use the same `withRlsScope` wrapper as HTTP handlers
([target-architecture.md](./target-architecture.md) §7). `workspace.join` does not filter
channels by membership in application code — it selects channels and the database returns only
the readable ones. **The socket layer and the REST layer are authorized by the same policies,
so they cannot drift apart.** That drift is the usual way a real-time layer ends up leaking.

---

## 3. Room strategy

| Room | Members | Carries |
|---|---|---|
| `u:{userId}` | all of one user's sockets, every device | notifications, read-state sync, forced logout |
| `ws:{workspaceId}` | connected members of a workspace | presence, channel created/updated |
| `ch:{channelId}` | connected members of a channel | messages, typing, reactions, **thread replies** |

Three room types, not four — thread rooms were cut (see below).

**Room membership is the authorization boundary.** A socket joins `ch:{id}` only if the
RLS-scoped channel query returned that channel. Private channel content is therefore never
emitted to a socket that lacks access — not filtered client-side, not sent and hidden. The whole
delivery surface is auditable by reading the join logic.

**Membership changes must move live sockets, not wait for a reconnect:**

```ts
// channel.member.added
io.in(`u:${userId}`).socketsJoin(`ch:${channelId}`);
// channel.member.removed  ← the security-critical direction
io.in(`u:${userId}`).socketsLeave(`ch:${channelId}`);
```

Both are adapter-aware and work across instances via Redis. The removal path is the one that
must never be missed: a user removed from a private channel who keeps receiving messages is a
live leak, and RLS does **not** save us here — RLS governs database reads, not socket fan-out
of an event the server already holds in memory.

**This is the one place where RLS is not a backstop**, and it is worth stating plainly so it
gets the test coverage it deserves ([security-model.md](./security-model.md) §7).

**Thread rooms (`th:{threadRootId}`) were cut for v1.** They would have meant a second room
lifecycle — joined on thread open, left on close — to avoid sending replies to channel members
who are not viewing the thread. At this scale that saves a handful of packets and costs a whole
mechanism, so `thread.reply.created` goes to `ch:{channelId}` and the client ignores replies for
threads it is not showing. Add the room type back if a channel ever has enough concurrent
thread activity to notice.

---

## 4. Event catalogue

### Client → Server (three, all hints)

| Event | Payload | Ack | Notes |
|---|---|---|---|
| `workspace.join` | `{ workspaceId }` | `{ ok, channels, seqs, presence }` | RLS-scoped channel load, room joins, head sequences for gap detection |
| `typing.start` | `{ channelId }` | — | Rate-limited 1/3s per channel. 8s TTL entry |
| `channel.read` | `{ channelId, seq }` | `{ ok, unread }` | `greatest()` update. Idempotent, safe out of order |

`typing.stop` deliberately does not exist — the TTL expires it. Explicit stop events are
unreliable (closed tabs, crashes, dropped connections) and TTL handles every case uniformly.
This is why stuck "X is typing…" indicators are impossible here.

Everything else — send, edit, delete, react — is REST. Sends need idempotency keys and body
limits; sockets provide neither.

### Server → Client

| Event | Room | Payload | Trigger |
|---|---|---|---|
| `message.created` | `ch:{id}` | message + `clientMsgId` | POST message |
| `message.updated` | `ch:{id}` | `{ id, body, editedAt, seq }` | PATCH message |
| `message.deleted` | `ch:{id}` | `{ id, channelId, seq }` | DELETE message |
| `message.reaction.added` | `ch:{id}` | `{ messageId, emoji, userId, count }` | POST reaction |
| `message.reaction.removed` | `ch:{id}` | `{ messageId, emoji, userId, count }` | DELETE reaction |
| `thread.reply.created` | `ch:{id}` | message + `replyCount` | POST in thread |
| `channel.created` | `ws:{id}` public / `u:{id}` private | channel | POST channel |
| `channel.updated` | `ch:{id}` | channel | PATCH channel |
| `channel.archived` | `ws:{id}` | `{ channelId }` | archive |
| `channel.member.added` | `ch:{id}` + `u:{id}` | `{ channelId, userId }` | join/invite |
| `channel.member.removed` | `ch:{id}` + `u:{id}` | `{ channelId, userId }` | leave/remove |
| `channel.read.updated` | `u:{id}` | `{ channelId, lastReadSeq, unread }` | cross-device read sync |
| `presence.updated` | `ws:{id}` | `{ userId, status, lastSeenAt }` | connect/disconnect/heartbeat |
| `typing.updated` | `ch:{id}` | `{ channelId, userIds[] }` | debounced current typers |
| `notification.created` | `u:{id}` | notification + `unreadTotal` | worker fan-out |
| `workspace.member.joined` | `ws:{id}` | member | invite accepted |
| `attachment.ready` | `u:{id}` | `{ messageId, path, thumbPath }` | worker finished |
| `error` | socket | `{ code, message, requestId }` | any handler failure |

**Naming notes.** `presence.updated` rather than `user.presence.updated` — the room already
scopes it. `typing.updated` carries **the current set of typers**, not `started`/`stopped`
deltas: an idempotent set is immune to lost stop events, whereas deltas are the classic source
of stuck indicators.

---

## 5. Fan-out path

```text
POST /api/v1/channels/:id/messages
   │
   ├─ rate limit → validate (zod) → authenticate → withRlsScope
   ├─ select public.send_message(...)     ← atomic seq + idempotency, one round trip
   │                                        (RLS enforces channel membership on insert)
   ├─ HTTP 201 {message}  ─────────────▶ sender (optimistic UI reconciles on clientMsgId)
   │
   ├─ realtime.emit("message.created", `ch:${channelId}`, message)
   │     └─ local sockets in that room  (+ Redis adapter fan-out once N > 1)
   │
   └─ queue.send("notification.fanout", { messageId })  ← async, off the request path
                                                          pg-boss: enqueued in the SAME
                                                          transaction as the insert
         │
         └─ worker (service_role): resolve mentions, DM targets, thread subscribers
              ├─ filter by muted_until and live presence
              ├─ insert notifications
              ├─ emit "notification.created" → u:{userId}
              └─ queue "email.send" for users offline > 5 min
```

**The sender receives the message twice** — once as the HTTP 201, once as `message.created`
(they are in `ch:{channelId}` too). That is correct and is the fix for D8: the sender's *other*
devices need the socket event. The client dedupes on `clientMsgId` then `id`, so the double
delivery is invisible. The original avoided duplication by never telling the sender at all,
which is exactly why multi-tab was broken.

**Notification fan-out is off the request path.** An `@channel` in a 200-person channel is 200
inserts and up to 200 emails; inline, that would make the sender wait and would couple message
sending to the email provider's availability.

**The worker uses `service_role`** because it acts on behalf of the system, not a user — it must
write notifications for people other than the requester. This is the deliberate, bounded RLS
bypass described in [database-design.md](./database-design.md) §5.3.

---

## 6. Presence

Replaces the in-process `userSocketMap` (D9, D12, D14) — not by moving it out of process, but by
**fixing its shape and putting it behind an interface**.

```ts
interface PresenceStore {
  addSocket(userId, socketId, workspaceIds): Promise<{ becameOnline: boolean }>;
  removeSocket(userId, socketId): Promise<{ becameOffline: boolean }>;
  heartbeat(userId, workspaceIds): Promise<void>;
  rosterFor(workspaceId): Promise<PresenceEntry[]>;
  sweep(): Promise<PresenceEntry[]>;          // returns reaped entries
}
```

```text
connect:
  sockets[userId].add(socketId)                 // a SET, not a single id
  lastSeen[workspaceId][userId] = now
  → if the set went 0→1, broadcast presence.updated{online} to ws:{workspaceId}

heartbeat (client every 25s):
  lastSeen[workspaceId][userId] = now

disconnect:
  sockets[userId].delete(socketId)
  → only if the set is now EMPTY, broadcast offline and persist profiles.last_seen_at

sweeper (every 30s):
  drop entries older than 60s → broadcast offline for anything reaped
```

**Two implementations, one interface:**

| | `InMemoryPresenceStore` (free tier) | `RedisPresenceStore` (when scaling) |
|---|---|---|
| Storage | `Map<userId, Set<socketId>>` | `SADD` / `ZADD` with TTLs |
| Sweeper | `setInterval` | `ZREMRANGEBYSCORE` under a Redis lock |
| Survives restart | No — every client reconnects anyway | No — TTL reaps |
| Multi-instance | **No** | Yes |

The in-process version is not a downgrade for a single instance: it is faster, has no network
hop, and has no command quota. Its *only* limitation is that it cannot span instances — which is
precisely the thing a one-instance deployment does not need
([free-tier-plan.md](./free-tier-plan.md) §5).

**What each element fixes:**

**What each element fixes — all of which work in either implementation:**

- **A set of socket IDs, not a single ID** → multi-device works. Two tabs, two entries; offline
  only when both close. (D9: the original's `{userId: socketId}` map meant the second tab evicted
  the first, and closing either marked the user offline while still connected.)
- **Deltas, not the full roster** → the roster is fetched once in the `workspace.join` ack;
  after that only `{userId, status}` changes are broadcast. (D14: the original re-broadcast the
  entire roster to everyone on every connect and disconnect.)
- **Timeout + sweeper** → a client that vanishes without a clean disconnect is reaped within 60s
  rather than showing online forever.
- **Per-workspace scoping** → you only see presence for people you share a workspace with.
- **Behind an interface** → the shape never leaks into call sites. (D12: the original's mistake
  was not that the map was in-process, but that `userSocketMap[userId]` appeared directly in the
  message controller, so nothing could be swapped without touching every caller.)

Only the last two rows of the comparison table above depend on Redis. **The behavioural fixes
for D9, D14, and D12 are all delivered on free tier**, in-process.

---

## 7. Reconnection and gap recovery

**"What happens if a user loses internet for 10 seconds?"** In the original: the socket
reconnects, and messages sent during the gap are simply absent until the user switches
conversations. Here:

```text
 t=0   client holds ch:X at seq 41
 t=1   network drops. socket.io backoff begins (1s, 2s, 4s … cap 10s)
 t=2   messages 42, 43, 44 are written by others. client receives none
 t=10  socket reconnects → handshake re-verifies the cookie
 t=10  client emits workspace.join
 t=10  ack: { seqs: { X: 44 } }
 t=10  local 41 < server 44  →  GAP
 t=10  GET /api/v1/channels/X/messages?after=41&limit=100
 t=10  merge by seq, dedupe by id, render
 t=10  UI exactly consistent
```

**Why the ack carries head sequences.** It turns reconnection from "hope nothing was missed"
into an arithmetic comparison. The client knows precisely which channels need replay, so a
reconnect costs one REST call for the active channel rather than a full refetch.

**This is the capability that ruled out Supabase Realtime** — there is no equivalent custom-ack
primitive, so the same guarantee would need extra REST round trips and more client state
([target-architecture.md](./target-architecture.md) §4).

**Bounded replay.** A gap larger than 200 messages discards the local buffer and does a fresh
page load instead — replaying 10,000 messages is slower and heavier than starting clean.

**Offline outbox.** Messages composed while disconnected sit in an outbox with their
`clientMsgId` already assigned and flush on reconnect. Because `send_message` is idempotent
([database-design.md](./database-design.md) §7), a message that actually did reach the server
before the drop is returned rather than duplicated.

**Why not `connectionStateRecovery`?** Socket.IO's built-in packet buffering is a useful fast
path, but it is best-effort, memory-bound, and does not survive an instance restart or redeploy.
It can be enabled *in addition to* sequence replay; it cannot be the correctness mechanism.
The `seq` comparison is authoritative.

---

## 8. Acknowledgements and error handling

```ts
socket.timeout(5000).emit("workspace.join", { workspaceId }, (err, res) => {
  if (err)     return scheduleRetry();      // ack timed out
  if (!res.ok) return handleError(res);     // server rejected
  hydrate(res);
});
```

Server handlers are wrapped so a throw never kills the connection and never leaks internals:

```ts
const handler = (name, fn) => async (payload, ack) => {
  const requestId = randomUUID();
  try {
    ack?.({ ok: true, ...(await fn(payload)) });
  } catch (err) {
    logger.error({ err, requestId, userId: socket.data.claims.sub, event: name });
    const safe = err instanceof AppError
      ? { code: err.code, message: err.message }
      : { code: "INTERNAL", message: "Something went wrong" };
    ack?.({ ok: false, ...safe, requestId });
    socket.emit("error", { ...safe, requestId });
  }
};
```

`requestId` matches the structured log line, so a user reporting "it said something went wrong"
is one grep from the stack trace ([scalability.md](./scalability.md) §8).

---

## 9. Socket rate limiting

Sockets bypass HTTP rate limiting entirely, which makes them the obvious abuse vector once HTTP
is protected. Per-socket token buckets (in-process; Redis-backed once more than one instance
runs, so the limits stay shared):

| Event | Limit |
|---|---|
| `typing.start` | 1 per 3s per channel |
| `channel.read` | 10 per 10s per channel |
| `workspace.join` | 10 per minute per socket |
| connections | 10 concurrent per user; the 11th evicts the oldest |

Exceeding a limit returns `{ ok: false, code: "RATE_LIMITED" }` rather than disconnecting —
disconnecting triggers the client's automatic reconnect and makes the problem worse.

The concurrent-socket cap also bounds the memory and presence cost of one abusive account.

---

## 10. Build order

Greenfield, so there is no legacy coexistence window and no dual-emit period. The layer is
built in the order that keeps each step independently testable.

**Phase 1 — authenticated skeleton.**
Handshake middleware, `u:{userId}` rooms, the ack/error wrapper, and an in-process
`PresenceStore`. No workspace concept yet. **The D1 regression test ships with it**: a socket
supplying a forged `handshake.query.userId` is authenticated as the cookie's user, or rejected.

**Phase 3 — channel rooms and message events.**
`workspace.join`, `ch:{id}` and `th:{id}` rooms, `message.*` and `channel.*` events, sequence
head sequences in the join ack.

**Phase 4 — production behaviour.**
Multi-device presence via `InMemoryPresenceStore`, typing, read receipts, reconnection with gap
replay, socket rate limiting, periodic re-authentication. **Everything users can perceive ships
here**, on one instance, with no Redis.

**Phase 8 — horizontal scale (only when needed).**
`RedisPresenceStore` swapped in, `io.adapter(createAdapter(pub, sub))` added, rate limiters moved
to Redis, second instance deployed, cross-instance test run. Because the interfaces were defined
in Phase 1 and used throughout Phase 4, this is a constructor change and one line of setup — not
a rewrite. On free tier it simply never happens ([free-tier-plan.md](./free-tier-plan.md) §5).

**Rollback at each step is a single deploy revert.** The Phase 8 adapter is config-gated, so
Redis can be disabled without a code change if it misbehaves.

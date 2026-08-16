# wave — Current Architecture Report

> Status: as-built, from commit `c19a77e` (branch `master`).
> Scope: every file in the repo was read. Nothing here is inferred from convention.

---

## ⚠️ Read this first — the project is restarting

The original MongoDB database and the deployment credentials are **gone**. There is no data to
migrate and no live environment to preserve. This document is therefore **no longer a migration
baseline** — it is three other things, all of which still matter:

1. **An inventory of what we keep.** The React frontend is being carried forward
   (§7, §10) — components, stores, theming, and the auth pages are all reused.
2. **A list of mistakes not to repeat.** The 25 debt items below are design errors that the
   rebuilt backend must not reproduce. Several (D1, D9, D12) describe patterns that are easy to
   write again by accident.
3. **A record of what the original got right** (§10). Those patterns are preserved deliberately,
   not rediscovered.

**What this changes downstream:** the database decision flips from MongoDB to Supabase/Postgres
([target-architecture.md](./target-architecture.md) §3), and the entire data-migration workstream
— previously the highest-risk item in the roadmap — is deleted. Debt items marked *(moot)* in
§9 disappear with the rewrite rather than needing a fix.

The backend described below is being **replaced**, not evolved. It is ~500 lines of data access
against a database that no longer exists.

---

## 1. Repository shape

```
wave/
├── package.json              # root: name "chai", build/start orchestration only
├── backend/
│   ├── .env                  # gitignored (verified) — 7 vars
│   └── src/
│       ├── index.js          # express wiring + SPA static serving
│       ├── lib/              # db, socket, cloudinary, jwt util
│       ├── controllers/      # auth, message
│       ├── middleware/       # auth (protectRoute)
│       ├── models/           # user, message
│       ├── routes/           # auth, message
│       └── seeds/            # user.seed.js (fully commented out — dead file)
└── frontend/
    └── src/
        ├── App.jsx           # routes
        ├── main.jsx          # BrowserRouter + StrictMode
        ├── pages/            # Home, Login, SignUp, Profile, Settings
        ├── components/       # ChatContainer, Sidebar, MessageInput, ChatHeader,
        │                     # Navbar, NoChatSelected, AuthImagePattern, skeletons/
        ├── store/            # useAuthStore, useChatStore, useThemeStore (Zustand)
        ├── lib/              # axios instance, formatMessageTime
        └── constants/        # daisyUI theme list
```

**Total: 22 source files, ~1,100 lines.** This is a small, single-purpose 1:1 DM app — not a
partially-built team platform. That is good news for the migration: there is very little to
unwind, and almost every existing file has a clear successor role.

---

## 2. Current architecture diagram

```text
                    ┌───────────────────────────────┐
                    │   Browser (React 18 + Vite)   │
                    │                               │
                    │  Zustand stores               │
                    │   ├── useAuthStore  (+socket) │
                    │   ├── useChatStore            │
                    │   └── useThemeStore           │
                    └───────┬───────────────┬───────┘
                            │               │
                 axios (withCredentials)   socket.io-client
                 REST /api/*               query: { userId }   ◄── UNAUTHENTICATED
                            │               │
                            ▼               ▼
        ┌───────────────────────────────────────────────────┐
        │      Single Node process  (backend/src/index.js)   │
        │                                                    │
        │  express app ──┬── /api/auth      (auth.route)      │
        │   (created in  ├── /api/messages  (message.route)   │
        │    lib/socket) └── GET *  → frontend/dist (prod)    │
        │                                                    │
        │  http.Server ──── socket.io Server                  │
        │                    └── userSocketMap {} ◄── IN-PROC │
        │                        (module-level object)        │
        └───────────────────────┬────────────────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
     ┌─────────────────┐                 ┌──────────────────┐
     │ MongoDB (Atlas) │                 │   Cloudinary     │
     │  users          │                 │  base64 uploads  │
     │  messages       │                 │  (server-side)   │
     └─────────────────┘                 └──────────────────┘
```

### Notable wiring detail

`express()` and `http.createServer()` are **both created inside `backend/src/lib/socket.js`**
and re-exported ([socket.js:5-6](../backend/src/lib/socket.js#L5-L6)), then imported by
[index.js:6](../backend/src/index.js#L6). So the socket module is the true composition root,
not `index.js`. This is unusual but harmless today; it becomes a problem when Socket.IO needs
config that depends on env parsing (the Redis adapter, auth middleware), because the import
order forces socket setup before `dotenv.config()` runs at [index.js:13](../backend/src/index.js#L13).

---

## 3. Current data model

Two collections. No relationships beyond `ObjectId` refs that are **never `populate()`d**.

```text
User                                Message
├── _id           ObjectId          ├── _id         ObjectId
├── email         String  unique    ├── senderId    ObjectId → User  (required)
├── fullName      String  required  ├── receiverId  ObjectId → User  (required)
├── password      String  min 6     ├── text        String   (optional, unbounded)
├── profilePic    String  ""        ├── image       String   (Cloudinary URL)
├── createdAt/updatedAt             └── createdAt/updatedAt
```

**Relationship model:** there is no conversation/thread entity. A "conversation" is
*derived at query time* by the `$or` in
[message.controller.js:24-29](../backend/src/controllers/message.controller.js#L24-L29):

```js
Message.find({ $or: [
  { senderId: myId,        receiverId: userToChatId },
  { senderId: userToChatId, receiverId: myId },
]})
```

**Indexes:** only two exist — the automatic `_id` on both collections, and the unique index
Mongoose creates from `email: { unique: true }`. There is **no index on `senderId` or
`receiverId`**, so every message fetch is a full collection scan. At 10k messages this is
invisible; at 1M it is a multi-second query.

**Validation gaps in the schema itself:**
- `email` has no `lowercase: true` / `trim: true`, so `A@Ex.com` and `a@ex.com` are two
  distinct accounts that both satisfy the unique index.
- `password` has `minlength: 6` on the schema, but the controller hashes *before* constructing
  the document, so the schema validator only ever sees a 60-char bcrypt hash — the rule is
  dead. The real check is the manual one at
  [auth.controller.js:13-15](../backend/src/controllers/auth.controller.js#L13-L15).
- `password` lacks `select: false`, so every future query must remember `.select("-password")`.
  Today exactly two places do; a third that forgets leaks hashes.
- `text` is unbounded — a client can store a 16MB message.

---

## 4. Current API

All routes are cookie-authenticated via `protectRoute` except the three auth entry points.

| Method | Path | Auth | Handler | Notes |
|---|---|---|---|---|
| POST | `/api/auth/signup` | — | `signup` | manual field validation, bcrypt cost 10 |
| POST | `/api/auth/login` | — | `login` | sets `jwt` httpOnly cookie |
| POST | `/api/auth/logout` | — | `logout` | clears cookie; **not** protected |
| PUT | `/api/auth/update-profile` | ✅ | `updateProfile` | base64 → Cloudinary |
| GET | `/api/auth/check` | ✅ | `checkAuth` | echoes `req.user` |
| GET | `/api/messages/users` | ✅ | `getUsersForSidebar` | **returns every user in the DB** |
| GET | `/api/messages/:id` | ✅ | `getMessages` | **entire history, no pagination** |
| POST | `/api/messages/send/:id` | ✅ | `sendMessage` | base64 image inline in JSON |

**Route-ordering hazard:** `GET /api/messages/:id` is registered after `/users`
([message.route.js:7-8](../backend/src/routes/message.route.js#L7-L8)), which is the correct
order — but the pattern is fragile. Any future literal segment added below `/:id` becomes
unreachable.

**SPA catch-all swallows API 404s:** `app.get("*")`
([index.js:32-35](../backend/src/index.js#L32-L35)) is registered after the API routers, so in
production a request to a misspelled `/api/...` path returns `index.html` with HTTP 200 instead
of a JSON 404. The frontend then tries to parse HTML as JSON.

---

## 5. Current Socket.IO architecture

The entire real-time layer is 37 lines ([lib/socket.js](../backend/src/lib/socket.js)).

**Connection lifecycle**

```text
client: io(BASE_URL, { query: { userId: authUser._id } })
   ↓
server: io.on("connection")
   ↓  userId = socket.handshake.query.userId       ← trusted verbatim, never verified
   ↓  userSocketMap[userId] = socket.id            ← in-process object
   ↓  io.emit("getOnlineUsers", Object.keys(map))  ← broadcast to EVERYONE
```

**Events**

| Direction | Event | Payload | Purpose |
|---|---|---|---|
| S→C | `getOnlineUsers` | `string[]` of userIds | full presence roster, re-broadcast on every connect/disconnect |
| S→C | `newMessage` | full `Message` doc | delivered to receiver socket only |

There are **zero** client→server events. The client never `emit`s anything; message sending
goes over REST and the server pushes the result out-of-band from
[message.controller.js:60-63](../backend/src/controllers/message.controller.js#L60-L63).
This REST-writes / socket-reads split is actually a sound foundation and should be kept.

**Rooms:** none. Delivery is by direct `io.to(socketId)`.

**Acknowledgements / retries / idempotency:** none.

**Reconnect behaviour:** socket.io-client reconnects automatically, and the handshake query
re-registers the user. But **messages sent during the disconnect window are lost from the UI**
until the user re-selects the conversation, because nothing replays missed events and
`getMessages` is only called on conversation switch
([ChatContainer.jsx:22-28](../frontend/src/components/ChatContainer.jsx#L22-L28)).

---

## 6. Current authentication flow

```text
POST /api/auth/login  { email, password }
   ↓
User.findOne({ email })  →  bcrypt.compare
   ↓
generateToken(user._id, res)          lib/utils.js
   ↓  jwt.sign({ userId }, JWT_SECRET, { expiresIn: "7d" })
   ↓  res.cookie("jwt", token, { httpOnly, sameSite: "strict",
   ↓                             secure: NODE_ENV !== "development",
   ↓                             maxAge: 7d })
   ↓
Browser stores httpOnly cookie  ─────────────────────────────┐
   ↓                                                          │
axios { withCredentials: true } → protectRoute               │
   ↓  jwt.verify → User.findById(userId).select("-password")  │
   ↓  req.user = user                                         │
                                                              │
Socket connection ────────────────────────────────────────────┘
   ✗ cookie is NOT read. userId comes from the query string.
```

The cookie choice is genuinely good — `httpOnly` + `sameSite: strict` + `secure` in prod is
the right default and defeats both XSS token theft and CSRF. **The socket layer then bypasses
it entirely.** That asymmetry is the single most important finding in this report.

---

## 7. Frontend architecture

- **React 18.3 + Vite 6, JavaScript (no TypeScript), ESM.**
- **Routing:** `react-router-dom` v7, 5 routes in [App.jsx:45-52](../frontend/src/App.jsx#L45-L52).
  Protection is inline ternaries (`authUser ? <Page/> : <Navigate to="/login"/>`), not a
  `<ProtectedRoute>` wrapper. `/settings` is deliberately public.
- **State:** three Zustand stores. `useAuthStore` holds *both* auth state and the socket
  instance and the presence roster. `useChatStore` reaches into `useAuthStore.getState()` for
  the socket ([useChatStore.js:50](../frontend/src/store/useChatStore.js#L50)) — a hidden
  cross-store coupling.
- **Server state is hand-cached in Zustand.** `getUsers`, `getMessages` write results into the
  store with bespoke `isXLoading` flags. There is no caching, deduping, retry, or
  invalidation — this is exactly the problem TanStack Query exists to solve.
- **API:** one shared `axiosInstance` with `withCredentials`. No response interceptor, so a
  401 does not trigger a logout or redirect; the user sees a toast and a broken screen.
- **Styling:** Tailwind 3 + daisyUI 4, 32 themes selectable, persisted to `localStorage` via
  `useThemeStore`. Applied as `data-theme` on a wrapper div.
- **Forms:** raw `useState` objects, manual validation
  (`SignUpPage` has a `validateForm()`), `react-hot-toast` for feedback. No form library.
- **Loading states:** skeleton components exist (`MessageSkeleton`, `SidebarSkeleton`) —
  a nice touch that is above the level of the rest of the code.
- **Error states:** every store `catch` does `toast.error(error.response.data.message)`. If the
  server returns a non-JSON error (413, 502, network failure), `error.response` is `undefined`
  and **the error handler itself throws**, replacing a useful message with an unhandled rejection.

---

## 8. Deployment & operations

| Concern | Current state |
|---|---|
| Build | Root `package.json` `build` → installs both workspaces, `vite build` |
| Start | `npm run start --prefix backend` → `node src/index.js` |
| Serving | In `NODE_ENV=production`, Express serves `frontend/dist` and a `*` fallback |
| Target | Single-process PaaS (Render/Railway shape). No `Procfile`/`render.yaml` committed |
| Docker | None |
| CI/CD | None. No `.github/` directory |
| Migrations | None. Schema changes are implicit |
| Logging | `console.log` only, unstructured, ~15 call sites. Several log `error.message` and discard the stack |
| Monitoring | None. No health check, no `/healthz`, no metrics |
| Tests | **None.** No test runner in either `package.json` |
| Lint | Frontend only (`eslint.config.js`). Backend has no linter |

**Config handling:** `dotenv.config()` at [index.js:13](../backend/src/index.js#L13) and again
inside [lib/cloudinary.js:5](../backend/src/lib/cloudinary.js#L5). No validation — a missing
`JWT_SECRET` doesn't fail at boot, it fails at the first login with a 500. `PORT` is
`process.env.PORT` with no fallback, so `server.listen(undefined)` picks a random port if unset.

**`.env` is correctly gitignored** (verified with `git check-ignore` and `git ls-files`) —
no secrets are in version control. Note the file uses `KEY =value` with a space before `=`,
which dotenv tolerates.

---

## 9. Technical debt

Ordered by severity. Every item is tied to a specific line — nothing here is speculative.

### Critical — security

**D1. Socket.IO identity is client-asserted.**
[socket.js:24](../backend/src/lib/socket.js#L24) reads `socket.handshake.query.userId` and
trusts it. Any browser can open a console and run:

```js
io("https://wave.example.com", { query: { userId: "<any user's ObjectId>" } })
```

…and will then receive every `newMessage` addressed to that user in real time. ObjectIds are
not secret — they are returned in full by `GET /api/messages/users` for every user in the
system. **This is a complete read-side authorization bypass for live messages**, and it must be
fixed before anything else in the roadmap.

**D2. `GET /api/messages/users` returns the entire user table.**
[message.controller.js:10](../backend/src/controllers/message.controller.js#L10). Every user
sees every other user's `_id`, `email`, `fullName`, and `profilePic`. Combined with D1, the
email list is also the target list. Multi-tenancy in Phase 2 fixes the shape of this, but the
email exposure should be fixed sooner.

**D3. No rate limiting anywhere.** `/api/auth/login` accepts unlimited attempts. bcrypt cost 10
also makes this a cheap CPU-exhaustion vector: a few hundred concurrent login attempts will
saturate the single Node process.

**D4. No `helmet` / security headers**, no CSP, no HSTS.

**D5. No input validation layer.** Bodies flow from `req.body` into Mongoose queries
unvalidated. The specific login-bypass version of NoSQL injection is *not* exploitable here
(sending `email: {"$ne": null}` returns a real user whose bcrypt comparison then fails), but
`text` is unbounded, `image` is an arbitrary string, and there is no schema enforcing anything.

### High — correctness bugs

**D6. `protectRoute` returns 500 for an expired or malformed token.**
`jwt.verify` *throws* on failure — it never returns falsy, so the `if (!decoded)` guard at
[auth.middleware.js:16](../backend/src/middleware/auth.middleware.js#L16) is dead code and
control lands in the `catch`, which returns
[500 "Internal Server error"](../backend/src/middleware/auth.middleware.js#L37-L39). Every user
whose 7-day token expires gets a 500 instead of a 401, and since the frontend has no 401
interceptor, they are stuck on a broken page until they manually clear cookies.

**D7. Images larger than ~75KB fail with an unreadable error.**
Images are read as base64 data URLs in the browser
([MessageInput.jsx:19-23](../frontend/src/components/MessageInput.jsx#L19-L23)) and POSTed
inside the JSON body. `express.json()` at [index.js:19](../backend/src/index.js#L19) uses the
default **100kb** limit (verified in `body-parser`), and base64 inflates by ~33%. Any photo
from a real camera is rejected with a 413 HTML page, which then crashes the frontend error
handler (see D11). This is the most user-visible bug in the app.

**D8. Sender's own devices never receive the socket echo.**
[message.controller.js:60-63](../backend/src/controllers/message.controller.js#L60-L63) emits
only to `receiverSocketId`. The sender's UI updates from the HTTP response
([useChatStore.js:40](../frontend/src/store/useChatStore.js#L40)), so a user with two tabs open
sees the message in one tab only.

**D9. One socket per user — second device silently evicts the first.**
`userSocketMap` is `{ userId: socketId }`
([socket.js:19](../backend/src/lib/socket.js#L19)). Opening a second tab overwrites the entry;
closing *either* tab runs `delete userSocketMap[userId]`
([socket.js:32](../backend/src/lib/socket.js#L32)) and broadcasts the user as offline while
they are still connected. Multi-device is broken by construction.

**D10. Token is issued before the user is persisted.**
[auth.controller.js:32-33](../backend/src/controllers/auth.controller.js#L32-L33) calls
`generateToken(newUser._id, res)` *then* `await newUser.save()`. If the save fails (duplicate
key race, validation, connection blip) the client walks away holding a valid 7-day JWT for a
user that does not exist. `protectRoute` degrades this to a 404 rather than a breach, but the
ordering is wrong.

**D11. The error handler throws.** `toast.error(error.response.data.message)` appears in 7
places across the two stores. On any network error or non-JSON response, `error.response` is
`undefined` → `TypeError` inside the `catch` → unhandled rejection, no toast.

### High — architecture & scalability

**D12. All real-time state is in-process.** `userSocketMap` lives in module scope. Running two
instances behind a load balancer means users connected to instance A cannot receive messages
from senders on instance B. **The app cannot be scaled horizontally at all today** — this is
the single biggest architectural constraint.

**D13. No pagination.** `getMessages` returns the full history of a conversation, unsorted
(relying on natural insertion order), with no index backing the query. Both a performance and
a memory problem, and it makes infinite scroll impossible without a rewrite of the endpoint.

**D14. Presence broadcast is O(N²).** Every connect and disconnect sends the full roster to
every connected client ([socket.js:28](../backend/src/lib/socket.js#L28)). With 1,000 users,
one reconnect storm produces 1,000 messages each containing 1,000 IDs.

**D15. No service layer.** Controllers talk directly to Mongoose *and* to Cloudinary *and* to
`io`. `sendMessage` does upload + persist + emit + respond in one function. There is no seam to
unit-test, and workspace authorization in Phase 2 would have to be duplicated into every
controller.

**D16. Composition root is inverted** — `app` and `server` are constructed in `lib/socket.js`
(§2), forcing socket configuration to happen before `dotenv.config()`.

### Medium

**D17. `"chai": "file:.."` is a self-referential dependency** in both
[backend/package.json:16](../backend/package.json#L16) and
[frontend/package.json:14](../frontend/package.json#L14) — each workspace depends on the repo
root, whose package is named `chai` (a leftover project name). It is unused by any import and
should be deleted; it makes `npm ci` and Docker layer caching behave unpredictably.

**D18. `logout` is unauthenticated** and clears the cookie with different attributes than it
was set with ([auth.controller.js:80](../backend/src/controllers/auth.controller.js#L80)).
Browsers match cookies on name/domain/path so it works today, but it will silently stop working
the moment a `path` or `domain` is introduced.

**D19. No token revocation.** A 7-day JWT with no refresh token, no `jti`, and no denylist
means logout is client-side only — a stolen token stays valid for its full lifetime.

**D20. Hardcoded CORS origins** in [index.js:22](../backend/src/index.js#L22) and
[socket.js:10](../backend/src/lib/socket.js#L10). Works only because production is same-origin.
Splitting the frontend onto a CDN would break real-time immediately.

**D21. `onlineUsers.length - 1`** at
[Sidebar.jsx:41](../frontend/src/components/Sidebar.jsx#L41) assumes the current user is always
in the roster; it renders "-1 online" during the pre-connection window.

**D22. `unsubscribeFromMessages` calls `socket.off("newMessage")` with no handler reference**
([useChatStore.js:64](../frontend/src/store/useChatStore.js#L64)), removing *all* listeners for
that event. Harmless with one subscriber; a latent bug the moment notifications also listen.

**D23. No message de-duplication on the client.** `messages: [...messages, newMessage]` appends
unconditionally. Any duplicate socket delivery (which reconnection *will* produce once
replay exists) renders twice, and React will warn on duplicate `key`s.

**D24. Dead code.** `backend/src/seeds/user.seed.js` is 100% commented out.
`frontend/src/components/ChatHeader.jsx` and `NoChatSelected.jsx` are fine, but the seed file
should be deleted or restored.

**D25. Zero tests, zero CI, zero health checks, unstructured logging.** Covered in §8.

---

## 10. What is actually good here

It matters for the roadmap that the following are *keepers*, not things to replace:

1. **The REST-write / socket-read split.** Writes go over HTTP and the socket is a pure
   fan-out channel. This is the right architecture and most tutorial chat apps get it wrong
   by emitting writes over the socket. Keep it.
2. **httpOnly + sameSite=strict + secure cookies.** Correct, and better than the
   `localStorage` token pattern most projects use. It extends cleanly to socket auth.
3. **Zustand + selective subscription.** Lightweight and adequate for client state.
4. **Skeleton loading components.** Already built, already used.
5. **daisyUI theming.** 32 themes with `localStorage` persistence — free polish.
6. **Clean folder separation** (routes / controllers / models / middleware / lib). It just
   needs a `services/` and `repositories/` layer added between controller and model.

---

## 11. Summary table — what carries forward

| Capability | Today | Fate in the rebuild |
|---|---|---|
| **React components** | ChatContainer, Sidebar, MessageInput, skeletons, auth pages | ✅ **Kept**, extended, converted to TS as touched |
| **daisyUI theming** | 32 themes, localStorage persistence | ✅ **Kept as-is** |
| **REST-write / socket-read split** | Correct (§10) | ✅ **Kept** — it is the target design |
| **httpOnly cookie transport** | Correct (§10) | ✅ **Kept** — preserved via an auth proxy ([security-model.md](./security-model.md) §2) |
| Auth (REST) | Own JWT + bcrypt | ⟳ **Replaced** by Supabase Auth behind an Express proxy |
| Auth (Socket) | **none — D1** | ➕ Built: cookie handshake verification |
| Authorization | none beyond "logged in" | ➕ Built: Postgres **RLS** + role permissions |
| Multi-tenancy | none | ➕ Built |
| Channels | none | ➕ Built (DMs become channels) |
| Messaging | 1:1 DM, create only | ⟳ Rebuilt: edit, delete, threads, reactions, mentions |
| Pagination | none — D13 | ➕ Built: `seq` cursor |
| Presence | in-proc map, single device — D9/D12 | ⟳ Rebuilt on Redis |
| Search | none | ➕ Built: Postgres FTS |
| Files | base64→Cloudinary, ~75KB cap — D7 | ⟳ Replaced: Supabase Storage, signed URLs |
| Jobs / queue | none | ➕ Built: pg-boss on the existing Postgres |
| Observability | `console.log` — D25 | ➕ Built: pino, metrics, health |
| Tests | none — D25 | ➕ Built: Vitest + local Supabase stack |
| Deploy | manual PaaS, credentials lost | ⟳ Rebuilt: Docker + CI/CD, fresh environment |
| Horizontal scale | **impossible** — D12 | ➕ Redis adapter + stateless API |

### Debt items that are moot in a rebuild

These describe bugs in code that is being replaced. They are listed so the same mistakes are
not made again, but they need no fix: **D6** (500-on-expired-token), **D8** (no sender echo),
**D10** (token issued before save), **D15** (no service layer), **D16** (inverted composition
root), **D17** (`chai` self-dependency), **D18** (unprotected logout), **D24** (dead seed file).

**D1 is no longer an active exploit** — nothing is deployed. It remains the single most
important design lesson in this document, because "read the user ID from the handshake query"
is the path of least resistance and is exactly what gets written again under time pressure.
The socket handshake design in [realtime-architecture.md](./realtime-architecture.md) §2 exists
to make sure it is not.

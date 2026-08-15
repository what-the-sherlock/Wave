# Katta

A team collaboration platform. See [`docs/`](docs/) for the full architecture, security model,
and phased roadmap — this file is just "how do I run it."

**Status:** Phase 1 (Foundation) — auth, profiles, and an authenticated real-time gateway.
Workspaces, channels, and messaging arrive in later phases (see
[docs/implementation-roadmap.md](docs/implementation-roadmap.md)).

## Stack

React + TypeScript · Express + TypeScript · Supabase (Postgres, Auth, Storage) · Socket.IO.
Runs entirely on free tiers — see [docs/free-tier-plan.md](docs/free-tier-plan.md).

## Prerequisites

- Node.js 22+
- Docker Desktop (for the local Supabase stack)
- [Supabase CLI](https://supabase.com/docs/guides/cli) — or just use `npx supabase`, no install needed

## Getting started

```bash
# 1. Install dependencies (root workspace covers both backend and frontend)
npm install

# 2. Start local Supabase (Postgres, Auth, Storage) — needs Docker running
npx supabase start

# 3. Apply migrations
npx supabase db push --local

# 4. Configure the backend
cp backend/.env.example backend/.env
# Fill in SUPABASE_ANON_KEY and SUPABASE_JWT_SECRET from the output of `supabase start`
# (or run `npx supabase status` to see them again)

# 5. Run it
npm run dev:backend    # http://localhost:5001
npm run dev:frontend   # http://localhost:5173
```

Open http://localhost:5173, sign up, and you're in.

## Common tasks

| Task | Command |
|---|---|
| Run backend tests | `npm test` (unit tests always run; integration tests self-skip if Supabase isn't up) |
| Lint everything | `npm run lint` |
| Typecheck everything | `npm run typecheck` |
| Reset the local database | `npx supabase db reset` |
| Stop the local Supabase stack | `npm run db:stop` |
| Supabase Studio (local DB browser) | http://localhost:54323 after `supabase start` |

## Project layout

```
backend/    Express + TypeScript API and Socket.IO gateway
frontend/   React + TypeScript SPA
supabase/   SQL migrations, seed data, local stack config
docs/       Architecture, security model, and the phased roadmap
```

## Why no `.env` is committed

`backend/.env` is gitignored on purpose — it holds local Supabase credentials. Losing an
environment once already restarted this project from scratch (see
[docs/current-architecture.md](docs/current-architecture.md)); the fix is that everything
needed to rebuild one — schema, policies, seed data — lives in `supabase/migrations/` and is
committed. `backend/.env.example` documents every variable.

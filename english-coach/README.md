# English Coach

Adaptive English speaking coach: realtime voice conversation → deterministic
analysis → learner memory → next session plan. LLMs observe and speak; a
deterministic learning engine owns all learning state.

See `../Docs/implementation-spec.md` for the design and
`../Docs/plans/2026-10-06-english-coach-implementation.md` for the build plan.

## Quickstart (no API key needed)

```bash
pnpm install
pnpm --filter @ec/api dev         # API on 127.0.0.1:3100 (PROVIDER=mock)
pnpm --filter @ec/web dev         # web client on http://127.0.0.1:5173
```

The SQLite database is created and seeded automatically when the API starts
(`apps/api/data/english-coach.db`), so no separate init step is needed. The web
server proxies `/v1` and `/ws` to the API, so the browser uses same-origin
requests (no CORS).

Open http://127.0.0.1:5173 → Start a session. In mock mode the "learner" side
is scripted (past-tense errors included) so the full analysis → memory →
planning pipeline runs end-to-end.

## Using the real OpenAI API

```bash
cp .env.example .env   # set OPENAI_API_KEY=sk-...
# PROVIDER=openai
```

Model IDs live in `packages/openai/src/models.ts` — they were pinned without
a key and MUST be re-verified against platform.openai.com/docs/models before
the first live run.

## Testing

```bash
pnpm test               # all unit + integration + e2e (mock provider)
```

## Layout

| Path | What |
| --- | --- |
| `apps/api` | Fastify API: session state machine, realtime bridge, WS protocol, job runner, analysis + planner workers |
| `apps/web` | Vite + React SPA (session, dashboard, goals) |
| `packages/domain` | Types, Zod schemas, canonical skill codes |
| `packages/db` | Drizzle/SQLite schema, migrations, seed |
| `packages/learning-engine` | Pure learning math (scoring, mastery, errors, difficulty, priority, planning) |
| `packages/openai` | Provider seam: mock + real OpenAI implementations |
| `packages/prompts` | Versioned prompt files + loader |

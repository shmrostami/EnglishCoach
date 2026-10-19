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
cp .env.example apps/api/.env   # set OPENAI_API_KEY=sk-...
# PROVIDER=openai
```

Model IDs live in `packages/openai/src/models.ts` — they were pinned without
a key and MUST be re-verified against platform.openai.com/docs/models before
the first live run.

## Local voice (no API key)

`PROVIDER=local` makes the coach run entirely on your machine: you speak,
faster-whisper transcribes, a local LLM (any OpenAI-compatible endpoint,
Ollama by default) writes the reply, and a local TTS engine speaks it aloud.

Setup (one-time):

```bash
python -m pip install -r packages/openai/requirements.txt
ollama pull llama3.2:3b
cp .env.example apps/api/.env    # then set PROVIDER=local
```

**Put the `.env` in `apps/api/`, not the repo root.** The loader resolves `.env`
against the API's working directory, so a root-level file is silently ignored and
the server stays on `PROVIDER=mock`. The same cwd is why `data/piper`,
`data/kokoro`, and the SQLite file are all relative to `apps/api`.

On first session the models download once: ~240 MB Whisper small into
the HuggingFace cache, and ~60 MB Piper voice into `apps/api/data/piper`.
Point the LLM elsewhere by editing `LLM_BASE_URL` / `LLM_MODEL` in `.env`.

### TTS engine

| Variable | Default | What it sets |
| --- | --- | --- |
| `TTS_ENGINE` | `piper` | `piper` or `kokoro` |
| `PIPER_VOICE` | `en_US-ryan-medium` | Piper voice |
| `PIPER_DATA_DIR` | `data/piper` | where Piper voices persist (auto-downloaded) |
| `KOKORO_VOICE` | `af_heart` | Kokoro voice (only when `TTS_ENGINE=kokoro`) |
| `KOKORO_DATA_DIR` | `data/kokoro` | where the Kokoro model files live |

Kokoro sounds cleaner than `en_US-ryan-medium` and runs at 24 kHz, but it is
**not** auto-downloaded. Put `kokoro-v1.0.onnx` (~325 MB) and
`voices-v1.0.bin` (~28 MB) in `KOKORO_DATA_DIR` (relative to `apps/api`) and
install the extra: `python -m pip install kokoro-onnx`. Missing files make TTS
fail with that path named — the coach's text still appears, and the session
continues.

### Other local-voice variables

| Variable | Default | What it sets |
| --- | --- | --- |
| `LLM_BASE_URL` | `http://localhost:11434/v1` | any OpenAI-compatible endpoint |
| `LLM_MODEL` | `llama3.2:3b` | the chat model |
| `LLM_API_KEY` | *(empty)* | most local servers ignore it |
| `WHISPER_MODEL` | `small` | STT size (small/base/tiny) |
| `PYTHON` | `python` | interpreter to spawn the sidecar |

Expect ~8–15 s from you stopping talking to the coach's voice (CPU). If a
session ends FAILED, the UI shows why: `stt_unavailable` (install the Python
deps / fix `PYTHON`), `voice_engine_lost` (the sidecar died, or a
transcribe request failed while it was alive), or `coach_unavailable` (LLM
endpoint unreachable after one retry, or it answered but returned no usable text).
A TTS-only failure is not a FAILED session: the coach's text lands and the audio
is skipped.

Known limits: end-of-session analysis/planning still run on the mock
provider, and Whisper may mis-transcribe non-English slips.

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

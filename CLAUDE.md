# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Next.js dev server (http://localhost:3000)
npm run build        # prisma generate && next build (build step Vercel runs)
npm start            # production server (after build)
npm run db:migrate   # prisma migrate dev --name init
npm run db:generate  # prisma generate (also runs automatically on postinstall)
```

There is no test runner, linter, or formatter configured for the main app. TypeScript is checked at build time (`tsc --noEmit` via Next.js).

Mobile (Expo, in `mobile/`) — separate project, not part of the Next.js build:

```bash
cd mobile && npm install
npx expo start                              # local dev
eas build --platform ios --profile preview  # cloud build for TestFlight
```

## Architecture

The product is a meeting transcription pipeline. Audio is **uploaded as it's recorded** in small chunks; transcription happens in the background; final AI analysis (summary, diarization, title, topics) is stitched at the end. The pipeline is engineered so a dropped connection, AI rate limit, or serverless timeout never loses audio or progress.

### Recording → transcription → finalize pipeline

1. **Create** — `POST /api/recordings/create` returns a new `Recording` row with `status: 'uploading'`.
2. **Chunked upload** — the client (`app/record/page.tsx` for web, `mobile/app/record.tsx` for iOS) rotates the `MediaRecorder` every **2 minutes** (`CHUNK_MS`) and `POST`s each chunk to `/api/recordings/[id]/append-chunk`. The chunk is stored as `Bytes` in the `ChunkBlob` table. Storing the raw audio (rather than transcribing inline) is what makes the upload phase immune to AI failures.
3. **Background per-chunk transcription** — `append-chunk` uses Vercel's `waitUntil` to transcribe the chunk *after* responding 200 OK. The transcript is written to a `ChunkTranscript` row tied to a `FinalizeJob`. By the time a meeting ends, almost all chunks are already transcribed.
4. **Finalize** — kicked off two ways:
   - **Client-driven**: `POST /api/recordings/[id]/finalize` when the user stops recording.
   - **Cron safety net**: `vercel.json` runs `GET /api/jobs/finalize` every 5 minutes (auth: `Bearer ${CRON_SECRET}`). It picks up any recording whose last chunk is >5 min old — that reliably means the session ended (active recordings upload every 2 min).
5. **Analysis** — once all chunks are transcribed, `analyzeAndCompleteRecording` runs in parallel: diarization, summary (overview/keyPoints/actionItems/decisions), title generation, topic sections. Speaker name identification runs after diarization.
6. **Backup** — `backupToAirtable` is fire-and-forget; failures must never break finalize.
7. **Cleanup** — on success, `ChunkBlob` rows are deleted; transcript + summary persist.

### Concurrency model (`lib/finalize-recording.ts`)

This is the trickiest part of the codebase. Multiple invocations (cron + user click + retry) can race to finalize the same recording. The mechanism:

- `FinalizeJob` has a `lockToken` + `lockUntil` (5-minute TTL). `acquireJobLock` uses `updateMany` with a `lockUntil < now` predicate so only one caller wins. Killed functions release the lock when `lockUntil` expires.
- `refreshJobLock` extends the lease while long work (analysis) is in progress.
- Per-chunk work is idempotent: `ChunkTranscript` has a `@@unique([jobId, chunkId])`, and `status: 'succeeded'` rows are skipped on retry.
- Chunks run `PARALLEL_CHUNKS = 5` at a time via `runConcurrent`.
- **Never load all chunk audio at once** — `chunkBlob.findMany` selects metadata only; `audioData` is fetched one chunk at a time. Long meetings can be hundreds of MB.
- `MAX_CHUNKS_PER_RUN = 100` caps per-invocation work; the cron picks up where it left off.
- `finalizeLegacy` is the fallback for deployments where the `FinalizeJob`/`ChunkTranscript` tables don't yet exist. `isMissingFinalizeTablesError` detects this. Keep both paths working when schema changes touch finalize logic.

### Transcription providers (`lib/ai.ts`, `lib/deepgram.ts`, `lib/transcribe-chunk.ts`)

Provider selection is environment-driven, with automatic fallback. Each provider also retries up to `MAX_CHUNK_ATTEMPTS = 4` with exponential backoff:

- **Deepgram** (preferred when `DEEPGRAM_API_KEY` is set) — gives speaker diarization for free; Claude diarization is skipped. Per-chunk speaker IDs are local integers; `alignSpeakersAcrossChunks` stitches them into consistent global `Speaker N` labels by assuming the first speaker of chunk N+1 is the last speaker of chunk N.
- **Groq** (preferred over OpenAI when `GROQ_API_KEY` is set) — free Whisper-large-v3-turbo via OpenAI-compatible API. If both Groq and OpenAI keys are set, OpenAI is used as automatic fallback on Groq rate limits.
- **OpenAI Whisper** — fallback. If no keys are set, the app returns demo transcripts (mock mode) instead of crashing.

When all chunks finish, `finalizeWithJobs` detects whether the segments are Deepgram-style (`speaker` is `number`) or Whisper-style and routes diarization accordingly.

### Claude usage

All Anthropic calls use **`claude-haiku-4-5-20251001`**. There are five distinct prompts in `lib/ai.ts`:

- `diarizeBatch` — labels Whisper segments with `Speaker N`, processed in batches of `DIARIZE_BATCH_SIZE = 100` so long meetings don't blow the context window. Gap/punctuation heuristics are encoded in the prompt; `fixOrphanSpeakers` repairs single-segment islands afterwards.
- `identifySpeakerNames` — only assigns a real name when highly confident (self-introduction or being addressed by name). Returns `{}` if uncertain.
- `generateTitle` — 3–4 word title; appended with the recording date in `analyzeAndCompleteRecording`.
- `generateTopics` — returns `[]` for short/single-subject meetings (requires ≥3 distinct topics).
- `analyzeTranscript` — overview/key points/action items/decisions. Transcript is truncated at `MAX_TRANSCRIPT_CHARS = 200_000`.

The global chat widget (`/api/chat`) loads up to 30 completed recordings into the system prompt, truncating each transcript to 3000 chars, and instructs Claude to emit `[MEETING:<id>]` tokens that the client renders as links.

When changing models, update the model ID in all six call sites consistently.

## Code conventions

- **Path alias**: `@/*` resolves to the repo root (see `tsconfig.json`). Use `@/lib/...`, `@/components/...`.
- **API routes**: every route under `app/api/` declares `export const dynamic = 'force-dynamic'`. Long-running routes also set `export const maxDuration` (and a matching entry in `vercel.json`).
- **ID validation**: recording IDs are CUIDs validated with `/^c[a-z0-9]{20,}$/` before any DB lookup. Reuse this regex; don't trust the URL param.
- **Prisma client**: import from `@/lib/db` (singleton with HMR-safe global). Don't `new PrismaClient()` directly.
- **Status enum** (string column, not Prisma enum): `'uploading' | 'processing' | 'completed' | 'failed'`. Transitions happen in `finalize-recording.ts`; don't update `status` ad hoc from API routes.
- **JSON-in-string columns**: `Transcript.segments`, `Summary.keyPoints`/`actionItems`/`decisions`/`topics`, `ChunkTranscript.segments` are all JSON serialised into `String`. Always `JSON.parse` with a try/catch — old rows may be malformed.
- **Mock mode**: many lib functions check `isMockAnthropic`/`isMockTranscription` and return placeholder data when keys look like the `.env.example` defaults. Preserve this when adding new AI calls so the dev experience works without keys.
- **Chunk size guard**: chunks <1000 bytes are treated as empty (browsers occasionally emit WebM cluster headers with no real audio). Don't remove this check.
- **TypeScript**: `strict: true`. `mobile/` and `prisma.config.ts` are excluded from the main tsconfig.

## Repo layout notes

- `app/` — Next.js App Router (web app). Server components by default; client components are explicitly `'use client'` (record page, chat widget, etc.).
- `lib/` — server-only helpers. `finalize-recording.ts` and `ai.ts` are the most important files in the repo.
- `components/` — shared React components.
- `prisma/schema.prisma` — single source of truth for DB shape. Migrations are gitignored (`prisma/migrations/`); production schema is managed via Supabase.
- `mobile/` — Expo/React Native iOS app. **Separate package.json**, separate `tsconfig.json`, separate build (EAS). Calls the deployed Vercel backend (`mobile/src/api.ts`). The web app's `npm run build` does **not** touch `mobile/`.
- `fireflies-clone/` — unrelated experimental project (React + Vite frontend, Python backend). Not part of the main app; don't modify it when working on FTC Transcribe.
- `scripts/generate-icons.mjs` — one-off PWA icon generator.

## Environment

Required for full functionality (see `.env.example`):

- `DATABASE_URL` — Supabase PostgreSQL.
- `ANTHROPIC_API_KEY` — required for summary/diarization/title/topics/chat.
- One of: `DEEPGRAM_API_KEY` (preferred — built-in diarization), `GROQ_API_KEY` (free Whisper), or `OPENAI_API_KEY`.
- `CRON_SECRET` — required in production; the `/api/jobs/finalize` cron rejects requests without `Authorization: Bearer ${CRON_SECRET}`.
- `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID` — optional backup; failures silently no-op.

Deployment is Vercel. The production URL is hardcoded in `mobile/src/api.ts` — update both places if it changes.

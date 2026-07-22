# FTC Transcribe Memory Index

Last consolidated: 2026-07-22 15:30 UTC (phases 2-6: DB pooler patterns verified, 20 topic files indexed)

## Status

**Main memory lives at**: `C:\Users\ryan.murphy\.claude\projects\c--Users-ryan-murphy-FTC---Transcribe\memory\`

This repo folder mirrors that location. Active topic files: 20. Memory stable.

## Consolidated Topics (indexed from .claude/projects)

| File | Summary | Updated |
|------|---------|---------|
| preferences | Topics first in output; cost-optimisation first; apply migrations autonomously | 2026-07-20 |
| corrections | N8N memory errors on large datasets; DB pooler gotchas | 2026-07-20 |
| decisions | Auto-fix pipeline; offline requirements; auth sync across apps | 2026-07-20 |
| wins | Chat resize handle validation; corner drag control UX | 2026-07-16 |
| project_voice_id | Sherpa-onnx voice-ID pipeline (10 topic files total) | 2026-07-17 |
| project_meeting_capture | Web MVP + Electron desktop; Teams notify; auth gap | 2026-07-17 |
| project_auth_architecture | Multi-user scoping; auto-claim flow; shared auth | 2026-07-17 |
| project_audio_playback | Archive/retrieval; can_play_audio flag | 2026-07-16 |

## Quick Reference — fastest hits

- **Real DB**: `ijeeghdxokfvlfarojlm` (MCP queries wrong DB — verify via `/api/debug/status`)
- **DB pooler**: `:6543?pgbouncer=true` (not `:5432` — exhausts at 15 clients)
- **estimateSeconds**: `lib/estimate.ts` (dependency-free, fast)
- **Schema check**: `lib/ensure-schema.ts` is NO-OP unless `RUN_SCHEMA_CHECK=1`
- **Post-deploy**: Wait 1-2 min (suspect cold start first)
- **Cost**: `/headroom` + OpenRouter for cheap tasks

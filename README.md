# FTC Transcribe

AI-powered meeting transcription app. Record meetings, get automatic transcripts with speaker labels, summaries, key points, action items, and decisions.

**Web app:** https://ftctranscribe-phi.vercel.app

---

## iOS App — Install Link (TestFlight)

> **Paste your TestFlight public link here once built:**
>
> `https://testflight.apple.com/join/XXXXXXXX`
>
> Anyone with this link can install the app directly on their iPhone — no App Store needed.
> The iOS app records in the background even when the screen is locked.

### How to build the iOS app

See [mobile/SETUP.md](mobile/SETUP.md) for full step-by-step instructions.

```bash
cd mobile
npm install
npm install -g eas-cli
eas login
eas build --platform ios --profile preview
```

---

## Stack

- **Frontend/Backend:** Next.js 14 (App Router), deployed on Vercel
- **Database:** Supabase (PostgreSQL via Prisma)
- **Transcription:** OpenAI Whisper (chunked, parallel)
- **AI summaries:** Anthropic Claude
- **Mobile:** Expo + React Native (iOS background recording)
- **Backup:** Airtable

## Features

- Chunked recording — audio saved in 2-minute segments, safe if connection drops
- Parallel transcription — 3 chunks processed simultaneously
- Speaker diarisation with colour-coded transcript
- Auto-generated summary: overview, key points, action items, decisions
- Folders to organise meetings
- Estimated processing time for queued recordings
- Delete recordings from home page
- Airtable backup after every completed recording
- PWA — installable from browser (Add to Home Screen)
- Native iOS app — records in background when screen locks

## Environment Variables

```
DATABASE_URL=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
AIRTABLE_API_KEY=        # optional — for Airtable backup
AIRTABLE_BASE_ID=        # optional — for Airtable backup
```

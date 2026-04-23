# FTC Transcribe — iOS App

Records meetings in the background even when your screen is locked.
Calls the same Vercel backend as the web app.

## Prerequisites

1. **Apple Developer account** — $99/year at developer.apple.com
   Needed to build for real devices and distribute via TestFlight.

2. **Expo account** — free at expo.dev

3. **Node.js** — already installed

## First-time setup

```bash
cd mobile
npm install
npm install -g eas-cli
eas login          # log in with your Expo account
```

## Build for iOS (TestFlight)

```bash
eas build --platform ios --profile preview
```

- This uploads your code to Expo's cloud build servers (no Mac needed)
- Takes ~10–15 minutes
- When done, Expo gives you a download link for the .ipa file
- Upload that .ipa to App Store Connect → TestFlight
- From TestFlight, generate a public install link to share

## Distribute via TestFlight

1. Go to appstoreconnect.apple.com
2. Create a new app (bundle ID: com.ftcgroup.transcribe)
3. Upload the .ipa from the EAS build
4. In TestFlight, create an External Testing group
5. Add a public link — anyone with that link can install directly

## What the app does differently from the web version

- Recording continues when screen locks (iOS background audio mode)
- No browser required — installs like a native app
- Same backend: all transcripts saved in Supabase, accessible on web too

## Update the backend URL

If your Vercel URL changes, update `src/api.ts`:
```
const BASE = 'https://your-new-url.vercel.app';
```

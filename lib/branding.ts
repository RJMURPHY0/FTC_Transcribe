// Display identity for sibling products in the estate, resolved at render.
//
// Stored data NEVER holds a display name. A voice sample learned from the
// dictation app persists `source: 'dictation'`, a stable machine id, and the
// name and logo are looked up here. A rebrand is then one environment variable
// on Vercel, not a data migration and not a hunt through JSX for a hardcoded
// string. Same split as lib/meeting-provider.ts, which keeps `teams` / `meet`
// as ids and resolves the badge separately.

export interface ProductBrand {
  /** Stable machine id. Persisted in the database. Never renamed. */
  id: string;
  /** Display name. Overridable per environment. */
  name: string;
  /** Public path to the logo used beside the name. */
  logo: string;
}

/** The push-to-talk dictation desktop app (currently FTC Whisper). */
export const DICTATION_APP: ProductBrand = {
  id: 'dictation',
  name: process.env.NEXT_PUBLIC_DICTATION_APP_NAME || 'FTC Whisper',
  logo: process.env.NEXT_PUBLIC_DICTATION_APP_LOGO || '/brand/dictation.png',
};

/** This app, for anywhere the product needs to name itself. */
export const TRANSCRIBE_APP: ProductBrand = {
  id: 'transcribe',
  name: process.env.NEXT_PUBLIC_APP_NAME || 'FTC Transcribe',
  logo: process.env.NEXT_PUBLIC_APP_LOGO || '/logo.png',
};

/**
 * Where a voice training sample came from, in words the user recognises.
 * Keyed by VoiceProfile.source, so adding a source means adding a line here
 * rather than editing the voice-setup page.
 */
export const VOICE_SOURCE_LABEL: Record<string, string> = {
  enrollment: 'Enrolled',
  dictation: DICTATION_APP.name,
  match: 'Auto-learned',
  relabel: 'From rename',
  auto: 'Self-intro',
};

/** Logo shown beside a sample's source badge, when that source has one. */
export const VOICE_SOURCE_LOGO: Record<string, string> = {
  dictation: DICTATION_APP.logo,
};

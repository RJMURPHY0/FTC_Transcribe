/**
 * Airtable backup — called after a recording is successfully finalized.
 *
 * Required env vars (set in Vercel dashboard):
 *   AIRTABLE_API_KEY   — personal access token from airtable.com/create/tokens
 *   AIRTABLE_BASE_ID   — the base ID (starts with "app…"), shown in the API docs URL
 *
 * The base needs one table called "Recordings" with these fields:
 *   Recording ID  (Single line text)
 *   Title         (Single line text)
 *   Date          (Date — or Single line text)
 *   Status        (Single line text)
 *   Overview      (Long text)
 *   Key Points    (Long text)
 *   Action Items  (Long text)
 *   Decisions     (Long text)
 *   Transcript    (Long text)
 *
 * The function is intentionally fire-and-forget — a backup failure must never
 * break the main finalize flow.
 */

import Airtable from 'airtable';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE_NAME       = 'Recordings';

function isConfigured(): boolean {
  return !!(
    AIRTABLE_API_KEY &&
    AIRTABLE_API_KEY !== 'your_airtable_api_key_here' &&
    AIRTABLE_BASE_ID &&
    AIRTABLE_BASE_ID !== 'your_airtable_base_id_here'
  );
}

export interface BackupPayload {
  recordingId:  string;
  title:        string;
  createdAt:    Date;
  status:       string;
  overview:     string;
  keyPoints:    string[];
  actionItems:  string[];
  decisions:    string[];
  fullText:     string;
}

/**
 * Upserts (create or update) one row in the Airtable "Recordings" table.
 * Safe to call multiple times — if the recording ID already exists, it updates.
 */
export async function backupToAirtable(payload: BackupPayload): Promise<void> {
  if (!isConfigured()) {
    // Silently skip — Airtable not configured
    return;
  }

  try {
    const base  = new Airtable({ apiKey: AIRTABLE_API_KEY! }).base(AIRTABLE_BASE_ID!);
    const table = base(TABLE_NAME);

    const fields = {
      'Recording ID':  payload.recordingId,
      'Title':         payload.title || 'Untitled',
      'Date':          payload.createdAt.toISOString().split('T')[0], // YYYY-MM-DD
      'Status':        payload.status,
      'Overview':      payload.overview,
      'Key Points':    payload.keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n'),
      'Action Items':  payload.actionItems.length > 0
                         ? payload.actionItems.map((a, i) => `${i + 1}. ${a}`).join('\n')
                         : '(none)',
      'Decisions':     payload.decisions.length > 0
                         ? payload.decisions.map((d, i) => `${i + 1}. ${d}`).join('\n')
                         : '(none)',
      'Transcript':    payload.fullText.slice(0, 100_000), // Airtable long-text limit
    };

    // Try to find an existing row with this Recording ID
    const existing = await table.select({
      filterByFormula: `{Recording ID} = '${payload.recordingId.replace(/'/g, '')}'`,
      maxRecords: 1,
    }).firstPage();

    if (existing.length > 0) {
      await table.update(existing[0].id, fields);
    } else {
      await table.create(fields);
    }
  } catch (err) {
    // Log but never throw — backup failure must not break the main flow
    console.warn('[airtable-backup] failed:', err instanceof Error ? err.message : err);
  }
}

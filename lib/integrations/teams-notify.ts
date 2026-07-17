import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.DATABASE_URL?.split("?")[0] || "";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
// Prefer the stable canonical domain; fall back to the per-deployment Vercel URL.
// (The previous form `A || B ? https://${B} : fallback` mis-grouped as `(A||B) ?
// https://${B} : fallback`, so it ignored NEXT_PUBLIC_APP_URL entirely and could
// emit `https://undefined` — breaking the "View Transcript" button in the card.)
const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://ftctranscribe-phi.vercel.app");

interface NotifyPayload {
  recordingId: string;
  title:       string;
  createdAt:   Date;
  overview:    string;
  keyPoints:   string[];
  actionItems: string[];
  decisions:   string[];
  durationSec: number;
}

function buildAdaptiveCard(p: NotifyPayload, appUrl: string): object {
  const date     = p.createdAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const duration = p.durationSec > 0
    ? `${Math.floor(p.durationSec / 60)}m ${p.durationSec % 60}s`
    : "";

  const facts = [
    { title: "Date", value: date },
    ...(duration ? [{ title: "Duration", value: duration }] : []),
  ];

  const bodyItems: object[] = [
    {
      type: "TextBlock",
      text: p.title,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    },
    {
      type: "FactSet",
      facts,
    },
    {
      type: "TextBlock",
      text: p.overview,
      wrap: true,
      spacing: "Medium",
    },
  ];

  if (p.keyPoints.length > 0) {
    bodyItems.push({
      type: "TextBlock",
      text: "**Key Points**",
      weight: "Bolder",
      spacing: "Medium",
    });
    p.keyPoints.slice(0, 5).forEach((pt) => {
      bodyItems.push({ type: "TextBlock", text: `• ${pt}`, wrap: true, spacing: "None" });
    });
  }

  if (p.actionItems.length > 0) {
    bodyItems.push({
      type: "TextBlock",
      text: "**Action Items**",
      weight: "Bolder",
      spacing: "Medium",
    });
    p.actionItems.slice(0, 5).forEach((item) => {
      bodyItems.push({ type: "TextBlock", text: `☐ ${item}`, wrap: true, spacing: "None" });
    });
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: bodyItems,
          actions: [
            {
              type: "Action.OpenUrl",
              title: "View Full Transcript",
              url: `${appUrl}/recordings/${p.recordingId}`,
            },
          ],
        },
      },
    ],
  };
}

export async function notifyTeamsChannel(payload: NotifyPayload): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY) return;

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Get webhook URLs from all microsoft_integrations rows (one per org)
  const { data: integrations } = await db
    .from("microsoft_integrations")
    .select("teams_webhook_url")
    .not("teams_webhook_url", "is", null);

  if (!integrations || integrations.length === 0) return;

  const card = buildAdaptiveCard(payload, APP_URL);

  await Promise.allSettled(
    integrations
      .filter((row) => row.teams_webhook_url)
      .map((row) =>
        fetch(row.teams_webhook_url!, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(card),
        }).catch((err) => console.error("[teams-notify] webhook post failed:", err))
      )
  );
}

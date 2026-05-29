const CONTACTS_API_URL = process.env.CONTACTS_API_URL || "";
const CROSS_APP_SECRET = process.env.CROSS_APP_SECRET || "";

export async function reportError(
  message: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  if (!CONTACTS_API_URL || !CROSS_APP_SECRET) return;
  try {
    await fetch(`${CONTACTS_API_URL}/api/log-error`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-app-secret": CROSS_APP_SECRET,
      },
      body: JSON.stringify({ message, context, source: "transcribe" }),
    });
  } catch {
    // Never throw — reporting must not break the app
  }
}

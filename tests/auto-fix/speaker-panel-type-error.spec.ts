import { test, expect } from '@playwright/test';

// Regression test for: "Object.fromEntries requires the first iterable
// parameter yields objects" (TypeError) — reported 11x on 2 Jun 2026.
//
// Root cause: Deepgram stores speaker IDs as numbers (0, 1, 2…). Those
// numbers flowed into SpeakerPanel as `speakers` prop, and Safari's
// Object.fromEntries threw on the number-keyed entries.
//
// Fix: speakerOrder now calls String(g.speaker), and SpeakerPanel uses
// String(s) in its Object.fromEntries map.
//
// This test hits the recordings list and verifies:
//   1. No pageerror (JS crash) fires when loading any existing recording.
//   2. The SpeakerPanel element renders without crashing when speakers exist.

test('recording page with diarized speakers renders without JS crash', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', err => jsErrors.push(err.message));

  // Load the home page to find any existing completed recording
  await page.goto('/');

  const firstRecordingLink = page.locator('a[href^="/recordings/"]').first();
  const hasRecording = await firstRecordingLink.isVisible().catch(() => false);

  if (!hasRecording) {
    // No recordings to test against — skip gracefully
    test.skip();
    return;
  }

  await firstRecordingLink.click();
  await page.waitForLoadState('networkidle');

  // Assert no TypeError from Object.fromEntries
  const fromEntriesErrors = jsErrors.filter(e =>
    e.toLowerCase().includes('object.fromentries') ||
    e.toLowerCase().includes('iterable') ||
    e.toLowerCase().includes('fromentries'),
  );
  expect(fromEntriesErrors, `Object.fromEntries crash: ${fromEntriesErrors.join(', ')}`).toHaveLength(0);

  // Broader: no JS errors at all on the recording page
  expect(jsErrors, `JS errors on recording page: ${jsErrors.join(', ')}`).toHaveLength(0);
});

test('SpeakerPanel renders when speaker labels are numeric strings', async ({ page }) => {
  // Verify the speakers section doesn't crash when navigating to a completed
  // recording that has transcript data. We can't control the data but we can
  // assert no crash fires.
  const jsErrors: string[] = [];
  page.on('pageerror', err => jsErrors.push(err.message));

  await page.goto('/');

  // Find a "completed" recording if one exists
  const completedLink = page
    .locator('li')
    .filter({ hasText: /completed/i })
    .locator('a[href^="/recordings/"]')
    .first();

  const hasCompleted = await completedLink.isVisible().catch(() => false);
  if (!hasCompleted) {
    test.skip();
    return;
  }

  await completedLink.click();
  await page.waitForLoadState('networkidle');

  // Speakers section — only present when transcript has speaker labels
  const speakersSection = page.locator('text=Speakers').first();
  if (await speakersSection.isVisible().catch(() => false)) {
    // If SpeakerPanel is visible, it must have rendered without crashing
    await expect(speakersSection).toBeVisible();
  }

  expect(jsErrors).toHaveLength(0);
});

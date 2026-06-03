import { test, expect } from '@playwright/test';

// These smoke tests run against the Vercel preview URL on every PR.
// They verify the app renders without JS errors and key pages are reachable.

test('home page loads without JS errors', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', err => jsErrors.push(err.message));

  await page.goto('/');
  await expect(page).toHaveTitle(/FTC/i);

  // "New Recording" button must be present
  await expect(page.getByRole('link', { name: /new recording/i })).toBeVisible();

  expect(jsErrors).toHaveLength(0);
});

test('record page loads without JS errors', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', err => jsErrors.push(err.message));

  await page.goto('/record');

  // Mic button must be rendered
  await expect(page.getByRole('button', { name: /start recording/i })).toBeVisible();

  expect(jsErrors).toHaveLength(0);
});

test('settings page loads', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', err => jsErrors.push(err.message));

  await page.goto('/settings');
  await expect(page).not.toHaveTitle(/404/i);

  expect(jsErrors).toHaveLength(0);
});

test('unknown route shows 404 or redirects gracefully', async ({ page }) => {
  const response = await page.goto('/this-route-does-not-exist-at-all');
  // Either a 404 status or a redirect to home — not a 500
  expect(response?.status()).not.toBe(500);
});

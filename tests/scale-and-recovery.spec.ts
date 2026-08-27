// Unit coverage for the rules that decide whether a meeting survives a bad
// chunk, who the worker serves next, and what the user is told about the wait.
//
// No browser and no database: every module under test here is deliberately
// dependency-free so this runs anywhere, including against a preview URL where
// nothing local is booted.
import { test, expect } from '@playwright/test';

import {
  PermanentAudioError,
  isPermanentAudioError,
  asPermanentAudioError,
} from '../lib/audio-errors';
import {
  backoffMs,
  interleaveByOwner,
  CRON_INTERVAL_MS,
  type QueuedJob,
} from '../lib/queue-policy';
import {
  estimateFinalizeSeconds,
  estimateSeconds,
  audioSecondsFrom,
  remainingSeconds,
  formatEta,
  FALLBACK_COST,
} from '../lib/estimate';
import { canAccessRecording, type AccessSubject } from '../lib/recording-access';

// ── The failure that started this ────────────────────────────────────────────

test.describe('permanent vs transient audio failures', () => {
  // The literal error that failed recording cmtbd1od3 on 27 Aug 2026.
  const REAL_FAILURE = '400 Audio file is too short. Minimum audio length is 0.1 seconds.';

  test('the real 27 Aug failure is classified permanent', () => {
    expect(isPermanentAudioError(new Error(REAL_FAILURE))).toBe(true);
    expect(isPermanentAudioError(Object.assign(new Error(REAL_FAILURE), { status: 400 }))).toBe(true);
  });

  test('provider hiccups stay retryable', () => {
    // These must NOT be swallowed as permanent: doing so silently drops audio.
    expect(isPermanentAudioError(Object.assign(new Error('rate limit'), { status: 429 }))).toBe(false);
    expect(isPermanentAudioError(Object.assign(new Error('bad gateway'), { status: 502 }))).toBe(false);
    expect(isPermanentAudioError(Object.assign(new Error('server error'), { status: 500 }))).toBe(false);
    expect(isPermanentAudioError(new Error('socket hang up'))).toBe(false);
    expect(isPermanentAudioError(new Error('fetch failed'))).toBe(false);
  });

  test('unprocessable request statuses are permanent', () => {
    for (const status of [400, 415, 422]) {
      expect(isPermanentAudioError(Object.assign(new Error('nope'), { status }))).toBe(true);
    }
  });

  test('non-errors do not throw the classifier', () => {
    expect(isPermanentAudioError(null)).toBe(false);
    expect(isPermanentAudioError(undefined)).toBe(false);
    expect(isPermanentAudioError('a string')).toBe(false);
  });

  test('asPermanentAudioError preserves the message and identity', () => {
    const wrapped = asPermanentAudioError(new Error(REAL_FAILURE));
    expect(wrapped).toBeInstanceOf(PermanentAudioError);
    expect(wrapped?.message).toBe(REAL_FAILURE);
    expect(asPermanentAudioError(new Error('socket hang up'))).toBeNull();
    // Already-permanent errors pass through rather than being re-wrapped.
    const original = new PermanentAudioError('too short');
    expect(asPermanentAudioError(original)).toBe(original);
  });
});

// ── Queue fairness and backoff ───────────────────────────────────────────────

test.describe('worker scheduling', () => {
  const job = (recordingId: string, userId: string | null, attempts = 0): QueuedJob =>
    ({ recordingId, userId, attempts });

  test('one account cannot occupy the whole run', () => {
    // Ten queued meetings for Ryan, one for Lee. Lee must still be served.
    const jobs = [
      ...Array.from({ length: 10 }, (_, i) => job(`ryan-${i}`, 'ryan')),
      job('lee-0', 'lee'),
    ];
    const batch = interleaveByOwner(jobs, 12, 2);
    expect(batch.filter(j => j.userId === 'ryan')).toHaveLength(2);
    expect(batch.filter(j => j.userId === 'lee')).toHaveLength(1);
  });

  test('a poison job cannot starve the queue', () => {
    // The 27 Aug shape: the oldest job is one that will fail again, and the
    // old worker would have spent both of its two slots on that account.
    const jobs = [
      job('poison', 'ryan', 16),
      job('ryan-next', 'ryan'),
      job('ryan-after', 'ryan'),
      job('lee-0', 'lee'),
      job('sam-0', 'sam'),
    ];
    const batch = interleaveByOwner(jobs, 12, 2);
    const owners = batch.map(j => j.userId);
    expect(owners).toContain('lee');
    expect(owners).toContain('sam');
    expect(batch.filter(j => j.userId === 'ryan')).toHaveLength(2);
  });

  test('priority order is preserved within an owner', () => {
    const jobs = [job('a', 'u'), job('b', 'u'), job('c', 'u')];
    expect(interleaveByOwner(jobs, 12, 2).map(j => j.recordingId)).toEqual(['a', 'b']);
  });

  test('the run limit is respected', () => {
    const jobs = Array.from({ length: 40 }, (_, i) => job(`r-${i}`, `user-${i}`));
    expect(interleaveByOwner(jobs, 12, 2)).toHaveLength(12);
  });

  test('unowned jobs are grouped, not treated as one per row', () => {
    const jobs = [job('a', null), job('b', null), job('c', null), job('d', 'u')];
    const batch = interleaveByOwner(jobs, 12, 2);
    expect(batch.filter(j => j.userId === null)).toHaveLength(2);
  });

  test('backoff grows then holds', () => {
    expect(backoffMs(1)).toBe(5 * 60_000);
    expect(backoffMs(2)).toBe(10 * 60_000);
    expect(backoffMs(3)).toBe(20 * 60_000);
    expect(backoffMs(4)).toBe(40 * 60_000);
    expect(backoffMs(5)).toBe(80 * 60_000);
    // Held rather than growing without bound.
    expect(backoffMs(50)).toBe(80 * 60_000);
    // Never negative or zero, however odd the input.
    expect(backoffMs(0)).toBeGreaterThan(0);
  });

  test('even the FIRST backoff outlasts the cron interval', () => {
    // The whole point, and the thing an earlier 1-minute base got wrong: a
    // backoff shorter than the gap between runs is invisible, because the job
    // is eligible again by the time anything next looks. That is how one
    // recording took a worker slot sixteen times over.
    for (const attempt of [1, 2, 3, 4, 5]) {
      expect(backoffMs(attempt)).toBeGreaterThanOrEqual(CRON_INTERVAL_MS);
    }
  });
});

// ── What the user is told about the wait ─────────────────────────────────────

test.describe('finalize estimates', () => {
  // Measured on production, 27 Aug 2026.
  const MEASURED = { perChunkS: 38.6, analysisS: 12.9, parallel: 8 };

  test('a fully pre-transcribed recording is a short fixed tail', () => {
    // The common case: background transcription kept up, nothing outstanding.
    const eta = estimateFinalizeSeconds(0, MEASURED);
    expect(eta).toBeLessThan(60);
  });

  test('predicts the two real recordings within a factor of two', () => {
    // Deliberately a factor-of-two band, not a tight percentage. There are
    // exactly two recordings on record carrying the timestamps this can be
    // checked against, and tuning constants until n=2 lands inside 25% would
    // be fitting noise. A factor of two is what the data actually supports,
    // and it is already an order of magnitude better than what it replaced.
    const within2x = (predicted: number, actual: number) =>
      predicted >= actual / 2 && predicted <= actual * 2;

    // Lee's meeting: 30 chunks outstanding at finalize, took 257s.
    expect(within2x(estimateFinalizeSeconds(30, MEASURED), 257)).toBe(true);
    // Ryan's 26 Aug meeting: all 68 chunks already done, took 48s.
    expect(within2x(estimateFinalizeSeconds(0, MEASURED), 48)).toBe(true);
  });

  test('beats the old model by an order of magnitude on the failing case', () => {
    // The old model showed "about 88 min" (5280s) for the 27 Aug recording.
    // Whatever we now say, it must be nowhere near that.
    const now = estimateFinalizeSeconds(45, MEASURED);
    expect(now).toBeLessThan(5280 / 5);
  });

  test('scales with outstanding work, not meeting length', () => {
    // The old ratio model made these two identical. They are not: the number
    // of chunks left to transcribe is what costs time.
    const allDone = estimateFinalizeSeconds(0, MEASURED);
    const nonePreDone = estimateFinalizeSeconds(45, MEASURED);
    expect(nonePreDone).toBeGreaterThan(allDone * 3);
  });

  test('parallelism is applied in whole batches', () => {
    const one = estimateFinalizeSeconds(1, MEASURED);
    const full = estimateFinalizeSeconds(8, MEASURED);
    expect(full).toBe(one);                              // same single batch
    expect(estimateFinalizeSeconds(9, MEASURED)).toBeGreaterThan(full);
  });

  test('estimateSeconds subtracts work already done', () => {
    expect(estimateSeconds(45, 45, MEASURED)).toBe(estimateFinalizeSeconds(0, MEASURED));
    expect(estimateSeconds(45, 0, MEASURED)).toBe(estimateFinalizeSeconds(45, MEASURED));
    // Over-counting must not produce a negative estimate.
    expect(estimateSeconds(10, 99, MEASURED)).toBeGreaterThan(0);
  });

  test('audio length comes from the offsets, not a flat 120s guess', () => {
    // Ryan's 27 Aug recording: 45 chunks, last offset 1893s, real length ~1937s.
    const measured = audioSecondsFrom(0, 1893, 45);
    expect(measured).toBeGreaterThan(1900);
    expect(measured).toBeLessThan(1990);
    // The old fallback claimed 45 x 120 = 5400s.
    expect(measured).toBeLessThan(5400 / 2);
  });

  test('a written duration always wins over the estimate', () => {
    expect(audioSecondsFrom(1615, 1571, 30)).toBe(1615);
  });

  test('audio length degrades sanely with no offsets', () => {
    expect(audioSecondsFrom(0, null, 4)).toBe(180);
    expect(audioSecondsFrom(0, null, 0)).toBe(0);
    // A single chunk has no spacing to infer from and must not divide by zero.
    expect(Number.isFinite(audioSecondsFrom(0, 40, 1))).toBe(true);
  });

  test('remaining time never reaches zero while work is outstanding', () => {
    expect(remainingSeconds(10, MEASURED, 0)).toBeGreaterThan(0);
    // Run has overshot its estimate: degrade to "nearly there", not to 0.
    expect(remainingSeconds(1, MEASURED, 99_999)).toBeGreaterThanOrEqual(5);
  });

  test('the cold-start default is honest rather than pessimistic', () => {
    // The old FALLBACK_RATIO of 1.2 produced ~20x overestimates on a new
    // account. The default now has to land in the same order of magnitude as
    // the measurements it will be replaced by.
    const cold = estimateFinalizeSeconds(30, FALLBACK_COST);
    const measured = estimateFinalizeSeconds(30, MEASURED);
    expect(cold).toBeGreaterThan(measured * 0.5);
    expect(cold).toBeLessThan(measured * 2);
  });

  test('eta formatting reads as English', () => {
    expect(formatEta(30)).toBe('less than a minute');
    expect(formatEta(60)).toBe('about 1 min');
    expect(formatEta(270)).toBe('about 5 min');
    expect(formatEta(0)).toBe('');
  });
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

test.describe('canAccessRecording', () => {
  const user = (over: Partial<AccessSubject> = {}): AccessSubject => ({
    id: 'ryan', canSeeAll: false, isSuperAdmin: false, orgId: 'org-a', ...over,
  });

  test('owners reach their own recordings', () => {
    expect(canAccessRecording({ userId: 'ryan', orgId: 'org-a' }, user())).toBe(true);
  });

  test('one user cannot read another user in the same org without canSeeAll', () => {
    expect(canAccessRecording({ userId: 'lee', orgId: 'org-a' }, user())).toBe(false);
  });

  test('canSeeAll reaches colleagues', () => {
    expect(canAccessRecording({ userId: 'lee', orgId: 'org-a' }, user({ canSeeAll: true }))).toBe(true);
  });

  test('canSeeAll stops at the tenant boundary', () => {
    // The reason orgId exists: an admin at one customer must not be able to
    // read another customer's meetings.
    expect(canAccessRecording({ userId: 'lee', orgId: 'org-b' }, user({ canSeeAll: true }))).toBe(false);
  });

  test('an admin with no org of their own reaches no one else', () => {
    expect(canAccessRecording({ userId: 'lee', orgId: 'org-a' }, user({ canSeeAll: true, orgId: null }))).toBe(false);
  });

  test('an untenanted recording is not readable by other orgs admins', () => {
    expect(canAccessRecording({ userId: 'lee', orgId: null }, user({ canSeeAll: true }))).toBe(false);
  });

  test('the super admin is the single deliberate exception', () => {
    expect(canAccessRecording({ userId: 'lee', orgId: 'org-b' }, user({ canSeeAll: true, isSuperAdmin: true }))).toBe(true);
  });

  test('unclaimed legacy rows stay reachable', () => {
    expect(canAccessRecording({ userId: null, orgId: null }, user())).toBe(true);
  });

  test('anonymous callers are refused', () => {
    expect(canAccessRecording({ userId: null, orgId: null }, null)).toBe(false);
    expect(canAccessRecording({ userId: 'ryan', orgId: 'org-a' }, null)).toBe(false);
  });
});

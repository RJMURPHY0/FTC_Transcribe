// Auto-fix orchestration: error → identify files → Claude fix+test → GitHub PR
//
// Required env vars:
//   ANTHROPIC_API_KEY  — already set (used by the rest of the app)
//   GITHUB_PAT         — classic PAT with `repo` scope
//   AUTOFIX_REPO_TRANSCRIBE — e.g. "RJMURPHY0/Transcription-"
//   AUTOFIX_REPO_CONTACTS   — e.g. "RJMURPHY0/FTC-Contacts" (optional)

import Anthropic from '@anthropic-ai/sdk';
import {
  getRepoFilePaths,
  getFileContent,
  getDefaultBranchSha,
  createBranch,
  upsertFile,
  createPullRequest,
} from '@/lib/github-client';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Maps source app name → GitHub repo.
// FTC Contacts reports errors with source "frontend" | "chat" | "api".
// FTC Transcribe reports with source "transcribe".
function repoForSource(source: string): string | null {
  if (source === 'transcribe') return process.env.AUTOFIX_REPO_TRANSCRIBE ?? 'RJMURPHY0/FTC_Transcribe';
  if (source === 'contacts' || source === 'frontend' || source === 'chat' || source === 'api') {
    return process.env.AUTOFIX_REPO_CONTACTS ?? null;
  }
  return null;
}

// Source-code file extensions we want Claude to see
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.prisma', '.sql']);
function isSourceFile(p: string) {
  const dot = p.lastIndexOf('.');
  return dot !== -1 && SOURCE_EXTS.has(p.slice(dot));
}

// ── Step 1: ask Claude which files are most relevant ──────────────────────

async function identifyRelevantFiles(
  errorMsg: string,
  allPaths: string[],
): Promise<string[]> {
  const sourcePaths = allPaths.filter(isSourceFile);

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `A production error was reported from a Next.js 14 / TypeScript app:

Error: ${errorMsg}

Given the file paths below, return the 4-6 paths most likely to contain or cause this bug.
Focus on source files — prefer TypeScript/TSX over config files.
Return ONLY a JSON array of paths: ["path/a.ts", "path/b.tsx", ...]

File paths:
${sourcePaths.slice(0, 400).join('\n')}`,
    }],
  });

  const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
  try {
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as string[];
    // Only return paths that actually exist in the repo
    const pathSet = new Set(allPaths);
    return parsed.filter(p => pathSet.has(p)).slice(0, 6);
  } catch {
    return [];
  }
}

// ── Step 2: ask Claude to generate fix + Playwright test ──────────────────

interface FixResult {
  rootCause: string;
  confidence: 'high' | 'medium' | 'low';
  files: Array<{ path: string; content: string }>;
  test: { path: string; content: string } | null;
  prTitle: string;
  prBody: string;
}

async function generateFix(
  errorMsg: string,
  errorContext: Record<string, unknown>,
  source: string,
  fileContents: Array<{ path: string; content: string }>,
): Promise<FixResult | null> {
  const filesBlock = fileContents
    .map(f => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are an expert Next.js / TypeScript bug fixer. A production error was auto-detected.

## Error
Source app: ${source}
Message: ${errorMsg}
Context: ${JSON.stringify(errorContext)}

## Relevant source files
${filesBlock}

## Your task
1. Identify the root cause.
2. Produce the minimal fix — change only what's necessary.
3. Write a Playwright test (using @playwright/test) that would have FAILED before the fix and PASSES after.
   - The test should use page.on('pageerror', ...) to catch JS crashes where appropriate.
   - Place it in: tests/auto-fix/<slug>.spec.ts

Return ONLY valid JSON (no markdown fences, no extra text):
{
  "rootCause": "<one or two sentences>",
  "confidence": "high" | "medium" | "low",
  "files": [
    { "path": "<repo-relative path>", "content": "<complete new file content>" }
  ],
  "test": {
    "path": "tests/auto-fix/<slug>.spec.ts",
    "content": "<complete Playwright test file>"
  },
  "prTitle": "fix(<scope>): <short description>",
  "prBody": "## Root Cause\\n<explanation>\\n\\n## Changes\\n<bullet list>\\n\\n## Test\\n<what the Playwright test verifies>"
}

Rules:
- If confidence is "low" (you cannot identify the exact cause), still return the JSON but set files=[] and test=null.
- Always return complete file contents — never partial diffs or snippets.
- The test must import from '@playwright/test' and use the standard test/expect API.`,
    }],
  });

  const text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';

  // Strip accidental markdown fences
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    return JSON.parse(clean) as FixResult;
  } catch {
    console.error('[auto-fix] Failed to parse Claude response:', text.slice(0, 500));
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface AutoFixInput {
  errorMsg: string;
  errorContext: Record<string, unknown>;
  source: string;
}

export interface AutoFixOutput {
  status: 'opened' | 'skipped' | 'failed';
  prUrl?: string;
  reason?: string;
}

export async function runAutoFix(input: AutoFixInput): Promise<AutoFixOutput> {
  const { errorMsg, errorContext, source } = input;

  const repo = repoForSource(source);
  if (!repo) {
    return { status: 'skipped', reason: `No repo configured for source "${source}"` };
  }

  if (!process.env.GITHUB_PAT) {
    return { status: 'failed', reason: 'GITHUB_PAT not configured' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: 'failed', reason: 'ANTHROPIC_API_KEY not configured' };
  }

  try {
    // 1. Get all file paths in the repo
    const allPaths = await getRepoFilePaths(repo);

    // 2. Ask Claude (haiku, cheap) which files to inspect
    const relevantPaths = await identifyRelevantFiles(errorMsg, allPaths);
    if (relevantPaths.length === 0) {
      return { status: 'skipped', reason: 'Could not identify relevant files' };
    }

    // 3. Fetch those files from GitHub
    const fileContents = await Promise.all(
      relevantPaths.map(async p => ({
        path: p,
        content: await getFileContent(repo, p).catch(() => '// Could not fetch file'),
      })),
    );

    // 4. Ask Claude (sonnet) to generate fix + test
    const fix = await generateFix(errorMsg, errorContext, source, fileContents);
    if (!fix) {
      return { status: 'failed', reason: 'Claude did not return a valid JSON response' };
    }
    if (fix.confidence === 'low' || fix.files.length === 0) {
      return { status: 'skipped', reason: `Low confidence fix: ${fix.rootCause}` };
    }

    // 5. Create a branch on GitHub
    const { branch: baseBranch, sha: baseSha } = await getDefaultBranchSha(repo);
    const slug = errorMsg.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const timestamp = Date.now();
    const branchName = `auto-fix/${slug}-${timestamp}`;
    await createBranch(repo, branchName, baseSha);

    // 6. Commit each fixed file
    for (const file of fix.files) {
      await upsertFile(
        repo,
        branchName,
        file.path,
        file.content,
        `fix: ${fix.prTitle.replace(/^fix[^:]*:\s*/i, '')}`,
      );
    }

    // 7. Commit the Playwright test
    if (fix.test) {
      await upsertFile(
        repo,
        branchName,
        fix.test.path,
        fix.test.content,
        `test: add regression test for auto-fix`,
      );
    }

    // 8. Open the PR
    const prBody = [
      fix.prBody,
      '',
      '---',
      `> 🤖 Auto-generated by the error-log auto-fix pipeline`,
      `> **Error:** \`${errorMsg.slice(0, 200)}\``,
      `> **Source:** ${source}`,
      `> **Confidence:** ${fix.confidence}`,
    ].join('\n');

    const prUrl = await createPullRequest(
      repo,
      fix.prTitle,
      prBody,
      branchName,
      baseBranch,
    );

    return { status: 'opened', prUrl };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown error';
    console.error('[auto-fix] orchestration failed:', reason);
    return { status: 'failed', reason };
  }
}

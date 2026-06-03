// GitHub REST API helpers used by the auto-fix pipeline.
// Requires GITHUB_PAT env var — a classic PAT with `repo` scope, or a
// fine-grained token with Contents (read+write) and Pull Requests (write).

const BASE = 'https://api.github.com';

function headers() {
  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_PAT env var is not set');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function ghFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { ...options, headers: { ...headers(), ...(options?.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} ${path}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

// ── File tree ──────────────────────────────────────────────────────────────

export async function getRepoFilePaths(repo: string): Promise<string[]> {
  // Get the default branch's HEAD SHA
  const repoData = await ghFetch(`/repos/${repo}`) as { default_branch: string };
  const branch   = repoData.default_branch;
  const refData  = await ghFetch(`/repos/${repo}/git/ref/heads/${branch}`) as { object: { sha: string } };
  const sha      = refData.object.sha;

  // Recursive tree — gives every file path in one call
  const tree = await ghFetch(`/repos/${repo}/git/trees/${sha}?recursive=1`) as {
    tree: Array<{ path: string; type: string }>;
    truncated: boolean;
  };

  return tree.tree
    .filter(item => item.type === 'blob')
    .map(item => item.path)
    // Exclude vendored/generated paths
    .filter(p => !p.startsWith('node_modules/') && !p.startsWith('.next/') && !p.endsWith('.lock'));
}

// ── File content ───────────────────────────────────────────────────────────

export async function getFileContent(repo: string, path: string): Promise<string> {
  const data = await ghFetch(`/repos/${repo}/contents/${encodeURIComponent(path)}`) as {
    content: string;
    encoding: string;
  };
  if (data.encoding !== 'base64') throw new Error(`Unexpected encoding: ${data.encoding}`);
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

// ── Default branch SHA ─────────────────────────────────────────────────────

export async function getDefaultBranchSha(repo: string): Promise<{ branch: string; sha: string }> {
  const repoData = await ghFetch(`/repos/${repo}`) as { default_branch: string };
  const branch   = repoData.default_branch;
  const refData  = await ghFetch(`/repos/${repo}/git/ref/heads/${branch}`) as { object: { sha: string } };
  return { branch, sha: refData.object.sha };
}

// ── Branch ─────────────────────────────────────────────────────────────────

export async function createBranch(repo: string, branchName: string, fromSha: string): Promise<void> {
  await ghFetch(`/repos/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
  });
}

// ── Commit a file ──────────────────────────────────────────────────────────

export async function upsertFile(
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  // Get existing SHA if the file already exists (needed for updates)
  let existingSha: string | undefined;
  try {
    const existing = await ghFetch(`/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`) as { sha: string };
    existingSha = existing.sha;
  } catch {
    // File doesn't exist yet — that's fine
  }

  await ghFetch(`/repos/${repo}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });
}

// ── Pull request ───────────────────────────────────────────────────────────

export async function createPullRequest(
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string,
): Promise<string> {
  const pr = await ghFetch(`/repos/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title, body, head, base }),
  }) as { html_url: string };
  return pr.html_url;
}

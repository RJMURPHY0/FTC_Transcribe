// Build gate: Prisma bypasses RLS, so canAccessRecording() is the ONLY
// per-user boundary in this app. Every surface that loads one recording by id
// must call it (or carry an explicit exemption comment) — a forgotten check
// leaks other users' meetings. Runs before `next build`, so a violation fails
// the deploy rather than shipping.
//
// Covers BOTH the API routes under app/api/recordings/[id] and the pages under
// app/recordings/[id]. Pages were outside the gate until 27 Aug 2026, and the
// recording detail page had consequently never had an access check at all:
// any signed-in user who knew an id could read the whole meeting. A gate that
// polices one kind of file and not the other is a gate with a door beside it.
//
// To exempt a file that genuinely needs no per-recording check, add a comment:
//   // access-check-exempt: <why>
const { readdirSync, readFileSync, statSync, existsSync } = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');

// [dir, filenames that load a recording and therefore must check]
const GUARDED = [
  [path.join(APP, 'api', 'recordings', '[id]'), new Set(['route.ts', 'route.tsx'])],
  [path.join(APP, 'recordings', '[id]'), new Set(['page.tsx', 'page.ts'])],
];

function walk(dir, names) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, names));
    else if (names.has(name)) out.push(p);
  }
  return out;
}

const files = [];
for (const [dir, names] of GUARDED) {
  if (existsSync(dir)) files.push(...walk(dir, names));
}

const failures = files.filter((file) => {
  const src = readFileSync(file, 'utf8');
  return !src.includes('canAccessRecording(') && !src.includes('access-check-exempt:');
});

if (failures.length > 0) {
  console.error('Per-recording access check missing (call canAccessRecording or add an access-check-exempt comment):');
  for (const f of failures) console.error(`  ${path.relative(path.join(__dirname, '..'), f)}`);
  process.exit(1);
}
console.log(`ok: ${files.length} per-recording surfaces enforce access control`);

// Build gate: Prisma bypasses RLS, so canAccessRecording() in each route is
// the ONLY per-user boundary. Every route under app/api/recordings/[id] must
// call it (or carry an explicit exemption comment) — a forgotten check leaks
// other users' meetings. Runs before `next build`, so a violation fails the
// deploy rather than shipping.
//
// To exempt a route that genuinely needs no per-recording check, add a comment:
//   // access-check-exempt: <why>
const { readdirSync, readFileSync, statSync } = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'app', 'api', 'recordings', '[id]');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name === 'route.ts' || name === 'route.tsx') out.push(p);
  }
  return out;
}

const routes = walk(ROOT);
const failures = routes.filter((file) => {
  const src = readFileSync(file, 'utf8');
  return !src.includes('canAccessRecording(') && !src.includes('access-check-exempt:');
});

if (failures.length > 0) {
  console.error('Per-recording access check missing (call canAccessRecording or add an access-check-exempt comment):');
  for (const f of failures) console.error(`  ${path.relative(path.join(__dirname, '..'), f)}`);
  process.exit(1);
}
console.log(`ok: ${routes.length} per-recording routes enforce access control`);

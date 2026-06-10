// Uses @prisma/client to run a raw SQL migration
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load DATABASE_URL from .env.local
const env = readFileSync(resolve('.env.local'), 'utf8');
for (const line of env.split('\n')) {
  const [k, ...rest] = line.split('=');
  if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
}

const prisma = new PrismaClient();
try {
  await prisma.$executeRawUnsafe(`ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web'`);
  console.log('Column added (or already existed).');
} finally {
  await prisma.$disconnect();
}

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST() {
  const recording = await prisma.recording.create({
    data: {
      title: `Recording – ${new Date().toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })}`,
      status: 'uploading',
    },
  });
  return NextResponse.json({ id: recording.id });
}

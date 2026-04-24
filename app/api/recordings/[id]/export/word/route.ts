import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import type { TopicSection } from '@/lib/ai';

export const dynamic = 'force-dynamic';

const CUID_RE = /^c[a-z0-9]{20,}$/;

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function h2(text: string) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 360, after: 160 } });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid recording ID.' }, { status: 400 });
  }

  const recording = await prisma.recording
    .findUnique({ where: { id: params.id }, include: { summary: true } })
    .catch(() => null);

  if (!recording?.summary) {
    return NextResponse.json({ error: 'No summary found.' }, { status: 404 });
  }

  function safeJson<T>(v: string | null | undefined, fallback: T): T {
    if (!v) return fallback;
    try { return JSON.parse(v); } catch { return fallback; }
  }

  const s = recording.summary;
  const keyPoints:   string[]       = safeJson(s.keyPoints,   []);
  const actionItems: string[]       = safeJson(s.actionItems, []);
  const decisions:   string[]       = safeJson(s.decisions,   []);
  const topics:      TopicSection[] = safeJson(s.topics,      []);

  const children: Paragraph[] = [
    // Title
    new Paragraph({
      text: recording.title,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 120 },
    }),
    // Date
    new Paragraph({
      children: [new TextRun({
        text: new Date(recording.createdAt).toLocaleDateString('en-GB', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        }),
        color: '888888',
      })],
      spacing: { after: 400 },
    }),
    // Summary
    h2('Summary'),
    new Paragraph({ text: s.overview, spacing: { after: 240 } }),
  ];

  if (keyPoints.length > 0) {
    children.push(h2('Key Points'));
    keyPoints.forEach(p =>
      children.push(new Paragraph({ text: p, bullet: { level: 0 } })),
    );
    children.push(new Paragraph({ spacing: { after: 160 } }));
  }

  if (actionItems.length > 0) {
    children.push(h2('Action Items'));
    actionItems.forEach((item, i) =>
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${i + 1}.  `, bold: true }),
          new TextRun({ text: item }),
        ],
      })),
    );
    children.push(new Paragraph({ spacing: { after: 160 } }));
  }

  if (decisions.length > 0 && decisions[0] !== 'None') {
    children.push(h2('Decisions'));
    decisions.forEach(d =>
      children.push(new Paragraph({
        children: [
          new TextRun({ text: '\u2713  ', bold: true }),
          new TextRun({ text: d }),
        ],
      })),
    );
    children.push(new Paragraph({ spacing: { after: 160 } }));
  }

  if (topics.length > 0) {
    children.push(h2('Topics'));
    topics.forEach(t =>
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${formatTimestamp(t.time)}  `, bold: true }),
          new TextRun({ text: t.title }),
        ],
      })),
    );
  }

  const doc    = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  const safe   = recording.title.replace(/[^a-z0-9 ]/gi, '_');

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${safe}.docx"`,
    },
  });
}

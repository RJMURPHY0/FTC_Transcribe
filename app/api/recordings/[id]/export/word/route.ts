import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '@/lib/db';
import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  AlignmentType, BorderStyle, ShadingType,
  convertInchesToTwip,
} from 'docx';
import type { TopicSection } from '@/lib/ai';

export const dynamic = 'force-dynamic';

const CUID_RE = /^c[a-z0-9]{20,}$/;

// FTC brand colours — 6-char hex only (Word rejects 8-char ARGB)
const ORANGE = 'f39200';
const DARK   = '4e4e4c';
const MID    = '888888';
const LIGHT  = 'dadada';
const WHITE  = 'ffffff';

// FTC brand fonts
const FONT_HEADING = 'Avenir Black';
const FONT_BODY    = 'Avenir Roman';

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function safeJson<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

// ── Document building blocks ──────────────────────────────────────────────────

function logoParagraph(): Paragraph | null {
  try {
    const logoPath = join(process.cwd(), 'public', 'logo.png');
    const data = readFileSync(logoPath);
    return new Paragraph({
      children: [
        new ImageRun({
          data,
          transformation: { width: 120, height: 45 },
          type: 'png',
        }),
      ],
      spacing: { before: 0, after: 160 },
    });
  } catch {
    return null;
  }
}

function headerBar(title: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: 'FTC TRANSCRIBE', bold: true, color: WHITE, size: 20, characterSpacing: 120, font: FONT_HEADING }),
      new TextRun({ text: '   |   ', color: WHITE, size: 20, font: FONT_HEADING }),
      new TextRun({ text: title.toUpperCase(), color: WHITE, size: 17, characterSpacing: 60, font: FONT_HEADING }),
    ],
    shading: { type: ShadingType.SOLID, color: ORANGE, fill: ORANGE },
    spacing: { before: 0, after: 0 },
    indent: { left: 360, right: 360 },
  });
}

function recordingTitle(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, color: DARK, size: 44, font: FONT_HEADING })],
    spacing: { before: 360, after: 100 },
  });
}

function dateRow(date: Date): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: date.toLocaleDateString('en-GB', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        }),
        color: MID,
        size: 19,
        font: FONT_BODY,
      }),
    ],
    spacing: { after: 300 },
  });
}

function divider(): Paragraph {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LIGHT, space: 0 } },
    spacing: { before: 0, after: 280 },
  });
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: text.toUpperCase(), bold: true, color: ORANGE, size: 19, characterSpacing: 80, font: FONT_HEADING }),
    ],
    spacing: { before: 400, after: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: LIGHT, space: 4 } },
  });
}

function bodyText(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, color: DARK, size: 22, font: FONT_BODY })],
    spacing: { after: 120 },
    alignment: AlignmentType.JUSTIFIED,
  });
}

function bulletPoint(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: '●  ', color: ORANGE, size: 20, font: FONT_HEADING }),
      new TextRun({ text, color: DARK, size: 22, font: FONT_BODY }),
    ],
    indent: { left: 360 },
    spacing: { after: 120 },
  });
}

function numberedItem(n: number, text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `${n}.  `, bold: true, color: ORANGE, size: 22, font: FONT_HEADING }),
      new TextRun({ text, color: DARK, size: 22, font: FONT_BODY }),
    ],
    indent: { left: 360 },
    spacing: { after: 120 },
  });
}

function checkItem(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: '✓  ', bold: true, color: ORANGE, size: 22, font: FONT_HEADING }),
      new TextRun({ text, color: DARK, size: 22, font: FONT_BODY }),
    ],
    indent: { left: 360 },
    spacing: { after: 120 },
  });
}

function topicItem(t: TopicSection): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: formatTimestamp(t.time) + '   ', bold: true, color: ORANGE, size: 20, font: FONT_HEADING }),
      new TextRun({ text: t.title, color: DARK, size: 22, font: FONT_BODY }),
    ],
    indent: { left: 360 },
    spacing: { after: 120 },
  });
}

function spacer(after = 80): Paragraph {
  return new Paragraph({ spacing: { after } });
}

function footerParagraph(date: Date): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: `Generated by FTC Transcribe  ·  ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
        color: LIGHT,
        size: 16,
        italics: true,
        font: FONT_BODY,
      }),
    ],
    alignment: AlignmentType.CENTER,
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: LIGHT, space: 6 } },
    spacing: { before: 600, after: 0 },
  });
}

// ── Route handler ─────────────────────────────────────────────────────────────

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

  const s = recording.summary;
  const keyPoints:   string[]       = safeJson(s.keyPoints,   []);
  const actionItems: string[]       = safeJson(s.actionItems, []);
  const decisions:   string[]       = safeJson(s.decisions,   []);
  const topics:      TopicSection[] = safeJson(s.topics,      []);

  const children: Paragraph[] = [];

  // Logo (optional — skipped if file missing)
  const logo = logoParagraph();
  if (logo) children.push(logo);

  children.push(
    headerBar(recording.title),
    recordingTitle(recording.title),
    dateRow(recording.createdAt),
    divider(),
  );

  if (s.overview) {
    children.push(sectionHeading('Summary'));
    children.push(bodyText(s.overview));
    children.push(spacer(160));
  }

  if (keyPoints.length > 0) {
    children.push(sectionHeading('Key Points'));
    keyPoints.forEach(p => children.push(bulletPoint(p)));
    children.push(spacer(160));
  }

  if (actionItems.length > 0) {
    children.push(sectionHeading('Action Items'));
    actionItems.forEach((item, i) => children.push(numberedItem(i + 1, item)));
    children.push(spacer(160));
  }

  if (decisions.length > 0 && decisions[0] !== 'None') {
    children.push(sectionHeading('Decisions'));
    decisions.forEach(d => children.push(checkItem(d)));
    children.push(spacer(160));
  }

  if (topics.length > 0) {
    children.push(sectionHeading('Topics Discussed'));
    topics.forEach(t => children.push(topicItem(t)));
    children.push(spacer(160));
  }

  children.push(footerParagraph(recording.createdAt));

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top:    convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left:   convertInchesToTwip(1.25),
            right:  convertInchesToTwip(1.25),
          },
        },
      },
      children,
    }],
  });

  let buffer: Buffer;
  try {
    buffer = await Packer.toBuffer(doc);
  } catch (err) {
    console.error('[word-export] Packer error:', err);
    return NextResponse.json({ error: 'Failed to generate document.' }, { status: 500 });
  }

  const safe = recording.title.replace(/[^a-z0-9 ]/gi, '_').trim() || 'meeting-notes';

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${safe}.docx"`,
      'Cache-Control':       'no-store',
    },
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { prisma } from '@/lib/db';
import React from 'react';
import {
  Document, Page, Text, View, Image, StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { TopicSection } from '@/lib/ai';

export const dynamic = 'force-dynamic';
// PDF generation is CPU-intensive — use Node.js runtime (default), not Edge
export const runtime = 'nodejs';

const CUID_RE = /^c[a-z0-9]{20,}$/;

// FTC brand colours
const ORANGE = '#f39200';
const DARK   = '#4e4e4c';
const MID    = '#888888';
const LIGHT  = '#dadada';
const WHITE  = '#ffffff';
const NEAR_WHITE = '#f8f8f8';

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    backgroundColor: WHITE,
    paddingTop: 48,
    paddingBottom: 56,
    paddingHorizontal: 56,
    fontSize: 11,
    color: DARK,
  },
  logo: { width: 100, height: 38, marginBottom: 12 },
  headerBar: {
    backgroundColor: ORANGE,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerText: { color: WHITE, fontSize: 9, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2 },
  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', color: DARK, marginBottom: 4 },
  date: { fontSize: 10, color: MID, marginBottom: 16 },
  divider: { borderBottomWidth: 1, borderBottomColor: LIGHT, marginBottom: 20 },
  sectionHeading: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: ORANGE,
    letterSpacing: 1,
    textTransform: 'uppercase',
    borderBottomWidth: 1,
    borderBottomColor: LIGHT,
    paddingBottom: 4,
    marginBottom: 8,
    marginTop: 20,
  },
  bodyText: { fontSize: 11, color: DARK, lineHeight: 1.6, marginBottom: 8 },
  bulletRow: { flexDirection: 'row', marginBottom: 5, paddingLeft: 8 },
  bullet: { fontSize: 11, color: ORANGE, marginRight: 6, width: 10 },
  bulletText: { flex: 1, fontSize: 11, color: DARK, lineHeight: 1.5 },
  numberedRow: { flexDirection: 'row', marginBottom: 5, paddingLeft: 8 },
  numLabel: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: ORANGE, marginRight: 6, width: 16 },
  checkRow: { flexDirection: 'row', marginBottom: 5, paddingLeft: 8 },
  checkMark: { fontSize: 11, color: ORANGE, marginRight: 6, width: 12 },
  topicRow: { flexDirection: 'row', marginBottom: 5, paddingLeft: 8, alignItems: 'center' },
  topicTime: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: ORANGE, width: 36, marginRight: 8 },
  topicTitle: { flex: 1, fontSize: 11, color: DARK },
  transcriptBox: { backgroundColor: NEAR_WHITE, borderRadius: 4, padding: 10, marginTop: 4 },
  segRow: { marginBottom: 8 },
  segMeta: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  segSpeaker: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: ORANGE, marginRight: 8 },
  segTime: { fontSize: 8, color: MID },
  segText: { fontSize: 10, color: DARK, lineHeight: 1.5 },
  footer: {
    borderTopWidth: 1,
    borderTopColor: LIGHT,
    marginTop: 32,
    paddingTop: 10,
    fontSize: 9,
    color: LIGHT,
    textAlign: 'center',
    fontFamily: 'Helvetica-Oblique',
  },
});

function fmt(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function safeJson<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

// ── PDF document definition ────────────────────────────────────────────────────

interface DocProps {
  title: string;
  createdAt: Date;
  overview: string;
  keyPoints: string[];
  actionItems: string[];
  decisions: string[];
  topics: TopicSection[];
  segments: Array<{ speaker: string; start: number; text: string }>;
  logoData: Buffer | null;
}

function TranscribePDF({
  title, createdAt, overview, keyPoints, actionItems, decisions, topics, segments, logoData,
}: DocProps) {
  const dateStr = createdAt.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const genDate = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    React.createElement(Document, {},
      React.createElement(Page, { size: 'A4', style: styles.page },

        /* Logo */
        logoData && React.createElement(Image, {
          src: { data: logoData, format: 'png' as const },
          style: styles.logo,
        }),

        /* Orange header bar */
        React.createElement(View, { style: styles.headerBar },
          React.createElement(Text, { style: styles.headerText },
            `FTC TRANSCRIBE   |   ${title.toUpperCase()}`
          ),
        ),

        /* Title + date + divider */
        React.createElement(Text, { style: styles.title }, title),
        React.createElement(Text, { style: styles.date }, dateStr),
        React.createElement(View, { style: styles.divider }),

        /* Overview */
        overview && React.createElement(View, {},
          React.createElement(Text, { style: styles.sectionHeading }, 'Summary'),
          React.createElement(Text, { style: styles.bodyText }, overview),
        ),

        /* Key Points */
        keyPoints.length > 0 && React.createElement(View, {},
          React.createElement(Text, { style: styles.sectionHeading }, 'Key Points'),
          ...keyPoints.map((p, i) =>
            React.createElement(View, { key: i, style: styles.bulletRow },
              React.createElement(Text, { style: styles.bullet }, '●'),
              React.createElement(Text, { style: styles.bulletText }, p),
            )
          ),
        ),

        /* Action Items */
        actionItems.length > 0 && React.createElement(View, {},
          React.createElement(Text, { style: styles.sectionHeading }, 'Action Items'),
          ...actionItems.map((item, i) =>
            React.createElement(View, { key: i, style: styles.numberedRow },
              React.createElement(Text, { style: styles.numLabel }, `${i + 1}.`),
              React.createElement(Text, { style: styles.bulletText }, item),
            )
          ),
        ),

        /* Decisions */
        decisions.length > 0 && decisions[0] !== 'None' && React.createElement(View, {},
          React.createElement(Text, { style: styles.sectionHeading }, 'Decisions'),
          ...decisions.map((d, i) =>
            React.createElement(View, { key: i, style: styles.checkRow },
              React.createElement(Text, { style: styles.checkMark }, '✓'),
              React.createElement(Text, { style: styles.bulletText }, d),
            )
          ),
        ),

        /* Topics */
        topics.length > 0 && React.createElement(View, {},
          React.createElement(Text, { style: styles.sectionHeading }, 'Topics Discussed'),
          ...topics.map((t, i) =>
            React.createElement(View, { key: i, style: styles.topicRow },
              React.createElement(Text, { style: styles.topicTime }, fmt(t.time)),
              React.createElement(Text, { style: styles.topicTitle }, t.title),
            )
          ),
        ),

        /* Transcript */
        segments.length > 0 && React.createElement(View, {},
          React.createElement(Text, { style: styles.sectionHeading }, 'Transcript'),
          React.createElement(View, { style: styles.transcriptBox },
            ...segments.map((seg, i) =>
              React.createElement(View, { key: i, style: styles.segRow },
                React.createElement(View, { style: styles.segMeta },
                  React.createElement(Text, { style: styles.segSpeaker }, seg.speaker),
                  React.createElement(Text, { style: styles.segTime }, fmt(seg.start)),
                ),
                React.createElement(Text, { style: styles.segText }, seg.text.trim()),
              )
            ),
          ),
        ),

        /* Footer */
        React.createElement(Text, { style: styles.footer },
          `Generated by FTC Transcribe  ·  ${genDate}`
        ),
      )
    )
  );
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid recording ID.' }, { status: 400 });
  }

  const recording = await prisma.recording
    .findUnique({ where: { id: params.id }, include: { summary: true, transcript: true } })
    .catch(() => null);

  if (!recording) {
    return NextResponse.json({ error: 'Recording not found.' }, { status: 404 });
  }

  const s = recording.summary;
  const keyPoints:   string[]       = safeJson(s?.keyPoints,   []);
  const actionItems: string[]       = safeJson(s?.actionItems, []);
  const decisions:   string[]       = safeJson(s?.decisions,   []);
  const topics:      TopicSection[] = safeJson(s?.topics,      []);
  const rawSegs = safeJson<Array<{ speaker: string; start: number; end: number; text: string }>>(
    recording.transcript?.segments, []
  );

  // Merge consecutive same-speaker segments for a cleaner transcript in the PDF
  const segments = rawSegs.reduce<Array<{ speaker: string; start: number; text: string }>>((acc, seg) => {
    const last = acc[acc.length - 1];
    if (last && last.speaker === seg.speaker) {
      acc[acc.length - 1] = { ...last, text: last.text + ' ' + seg.text.trim() };
    } else {
      acc.push({ speaker: seg.speaker, start: seg.start, text: seg.text.trim() });
    }
    return acc;
  }, []);

  let logoData: Buffer | null = null;
  try {
    logoData = await readFile(join(process.cwd(), 'public', 'logo.png'));
  } catch { /* logo optional */ }

  let buffer: Buffer;
  try {
    buffer = await renderToBuffer(
      React.createElement(TranscribePDF, {
        title: recording.title,
        createdAt: recording.createdAt,
        overview: s?.overview ?? '',
        keyPoints,
        actionItems,
        decisions,
        topics,
        segments,
        logoData,
      })
    );
  } catch (err) {
    console.error('[pdf-export] render error:', err);
    return NextResponse.json({ error: 'Failed to generate PDF.' }, { status: 500 });
  }

  const safe = recording.title.replace(/[^a-z0-9 ]/gi, '_').trim() || 'meeting-notes';

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${safe}.pdf"`,
      'Cache-Control':       'no-store',
    },
  });
}

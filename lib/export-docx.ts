// Word (.docx) rendering of a meeting document.
//
// The house style is Document Studio's (see lib/doc-house-style.ts): charcoal
// masthead band, 3px orange accent rule, h1 over a hairline, section headings
// as full-width orange bars, sub-headings over a thin orange rule, and
// zebra-striped two-column spec tables for timestamped data.

import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  Table, TableRow, TableCell, WidthType, TableLayoutType,
  AlignmentType, BorderStyle, ShadingType,
  convertInchesToTwip,
} from 'docx';
import type { TopicSection } from '@/lib/ai';
import { formatDue } from '@/lib/action-items';
import {
  DOC, hex6, FONT_HEADING, FONT_BODY, MASTHEAD, SECTION_LABELS,
  formatClock, formatLongDate, formatShortDate,
} from '@/lib/doc-house-style';
import { hasDecisions, type MeetingDoc } from '@/lib/export-doc';

// Word wants bare 6-char hex, no '#'
const ORANGE  = hex6(DOC.orange);
const HEADER  = hex6(DOC.header);
const HEADING = hex6(DOC.heading);
const TEXT    = hex6(DOC.text);
const SOFT    = hex6(DOC.soft);
const ZEBRA   = hex6(DOC.zebra);
const RULE    = hex6(DOC.rule);
const WHITE   = hex6(DOC.white);

// docx sizes are half-points: 22 = 11pt body, the base of the house scale.
const SIZE_TITLE = 38;   // 19pt — h1
const SIZE_BAR   = 20;   // 10pt — section heading inside the orange bar
const SIZE_BODY  = 22;   // 11pt
const SIZE_META  = 19;   // 9.5pt — dates, due labels
const SIZE_FOOT  = 16;   // 8pt

type Block = Paragraph | Table;

// ── Building blocks ───────────────────────────────────────────────────────────

function logoParagraph(data: Buffer): Paragraph {
  return new Paragraph({
    children: [new ImageRun({ data, transformation: { width: 132, height: 57 }, type: 'png' })],
    spacing: { before: 0, after: 200 },
  });
}

/** Charcoal masthead band — the product name, then this document's kind. */
function mastheadBand(): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: MASTHEAD, bold: true, color: WHITE, size: SIZE_BAR, characterSpacing: 140, font: FONT_HEADING }),
      new TextRun({ text: '   |   ', color: WHITE, size: SIZE_BAR, font: FONT_HEADING }),
      new TextRun({ text: 'MEETING NOTES', color: WHITE, size: SIZE_BAR, characterSpacing: 100, font: FONT_HEADING }),
    ],
    shading: { type: ShadingType.SOLID, color: HEADER, fill: HEADER },
    spacing: { before: 0, after: 0, line: 300 },
    indent: { left: 200, right: 200 },
  });
}

/** The 3px orange accent rule directly under the band. */
function accentRule(): Paragraph {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: ORANGE, space: 0 } },
    spacing: { before: 0, after: 340 },
  });
}

/** h1 — document title, over a 2px orange rule. */
function documentTitle(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, color: HEADING, size: SIZE_TITLE, font: FONT_HEADING })],
    spacing: { before: 0, after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 16, color: ORANGE, space: 6 } },
  });
}

function dateRow(date: Date): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: formatLongDate(date), color: SOFT, size: SIZE_META, font: FONT_BODY })],
    spacing: { before: 60, after: 120 },
  });
}

/** h2 — full-width orange bar, white caps. Document Studio's "bar" style. */
function sectionBar(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: text.toUpperCase(), bold: true, color: WHITE, size: SIZE_BAR, characterSpacing: 100, font: FONT_HEADING }),
    ],
    shading: { type: ShadingType.SOLID, color: ORANGE, fill: ORANGE },
    spacing: { before: 400, after: 200, line: 280 },
    indent: { left: 200, right: 200 },
  });
}

function bodyText(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, color: TEXT, size: SIZE_BODY, font: FONT_BODY })],
    spacing: { after: 120, line: 300 },
    alignment: AlignmentType.JUSTIFIED,
  });
}

function bulletPoint(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: '●  ', color: ORANGE, size: SIZE_BODY, font: FONT_HEADING }),
      new TextRun({ text, color: TEXT, size: SIZE_BODY, font: FONT_BODY }),
    ],
    indent: { left: 360, hanging: 200 },
    spacing: { after: 140, line: 290 },
  });
}

/**
 * A done item is struck through. `strike` is Word's own character property, so
 * un-ticking one in the document is the strikethrough button on the Home
 * ribbon (Ctrl+D → Strikethrough) — no find-and-replace needed.
 */
function numberedItem(n: number, text: string, due: string | null | undefined, done: boolean): Paragraph {
  const dueLabel = formatDue(due);
  return new Paragraph({
    children: [
      new TextRun({ text: `${n}.  `, bold: true, color: ORANGE, size: SIZE_BODY, font: FONT_HEADING, strike: done }),
      new TextRun({ text, color: done ? SOFT : TEXT, size: SIZE_BODY, font: FONT_BODY, strike: done }),
      new TextRun({
        text: dueLabel ? `   (Due ${dueLabel})` : '   (No date set)',
        color: SOFT, size: SIZE_META, italics: true, font: FONT_BODY, strike: done,
      }),
    ],
    indent: { left: 360, hanging: 200 },
    spacing: { after: 140, line: 290 },
  });
}

function checkItem(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: '✓  ', bold: true, color: ORANGE, size: SIZE_BODY, font: FONT_HEADING }),
      new TextRun({ text, color: TEXT, size: SIZE_BODY, font: FONT_BODY }),
    ],
    indent: { left: 360, hanging: 200 },
    spacing: { after: 140, line: 290 },
  });
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' } as const;
const CELL_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };
// Hairline outline so the zebra block reads as one table rather than as
// loose striped rows. Outside only — internal gridlines stay off.
const TABLE_EDGE = { style: BorderStyle.SINGLE, size: 4, color: hex6(DOC.tableLine) } as const;

/**
 * Topics as a zebra-striped two-column spec table — Document Studio turns any
 * "short label + detail" pair into one of these rather than a bullet list.
 */
function topicsTable(topics: TopicSection[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    columnWidths: [1100, 8100],
    borders: {
      top: TABLE_EDGE, bottom: TABLE_EDGE, left: TABLE_EDGE, right: TABLE_EDGE,
      insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
    },
    rows: topics.map((t, i) => {
      const fill = i % 2 === 1 ? ZEBRA : WHITE;
      const cell = (children: TextRun[]) => new TableCell({
        children: [new Paragraph({ children, spacing: { before: 70, after: 70 } })],
        shading: { type: ShadingType.SOLID, color: fill, fill },
        borders: CELL_BORDERS,
        margins: { top: 40, bottom: 40, left: 160, right: 160 },
      });
      return new TableRow({
        children: [
          cell([new TextRun({ text: formatClock(t.time), bold: true, color: ORANGE, size: SIZE_META, font: FONT_HEADING })]),
          cell([new TextRun({ text: t.title, color: TEXT, size: SIZE_BODY, font: FONT_BODY })]),
        ],
      });
    }),
  });
}

function spacer(after = 160): Paragraph {
  return new Paragraph({ spacing: { after } });
}

function footerParagraph(date: Date): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: `Generated by FTC Transcribe  ·  ${formatShortDate(date)}`,
        color: SOFT, size: SIZE_FOOT, italics: true, font: FONT_BODY,
      }),
    ],
    alignment: AlignmentType.CENTER,
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 8 } },
    spacing: { before: 600, after: 0 },
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function buildMeetingDocx(doc: MeetingDoc, logo: Buffer | null): Promise<Buffer> {
  const children: Block[] = [];

  if (logo) children.push(logoParagraph(logo));
  children.push(
    mastheadBand(),
    accentRule(),
    documentTitle(doc.title),
    dateRow(doc.createdAt),
  );

  // Section order mirrors the AI Notes panel on screen — see SECTION_ORDER in
  // lib/doc-house-style.ts.
  if (doc.topics.length > 0) {
    children.push(sectionBar(SECTION_LABELS.topics), topicsTable(doc.topics), spacer());
  }

  if (doc.overview) {
    children.push(sectionBar(SECTION_LABELS.summary), bodyText(doc.overview), spacer());
  }

  if (doc.actionItems.length > 0) {
    children.push(sectionBar(SECTION_LABELS.actionItems));
    doc.actionItems.forEach((item, i) =>
      children.push(numberedItem(i + 1, item, doc.actionDue[i], doc.actionChecked.has(i))));
    children.push(spacer());
  }

  if (doc.keyPoints.length > 0) {
    children.push(sectionBar(SECTION_LABELS.keyPoints));
    doc.keyPoints.forEach(p => children.push(bulletPoint(p)));
    children.push(spacer());
  }

  if (hasDecisions(doc.decisions)) {
    children.push(sectionBar(SECTION_LABELS.decisions));
    doc.decisions.forEach(d => children.push(checkItem(d)));
    children.push(spacer());
  }

  children.push(footerParagraph(doc.createdAt));

  const document = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top:    convertInchesToTwip(0.9),
            bottom: convertInchesToTwip(0.9),
            left:   convertInchesToTwip(1),
            right:  convertInchesToTwip(1),
          },
        },
      },
      children,
    }],
  });

  return Packer.toBuffer(document);
}

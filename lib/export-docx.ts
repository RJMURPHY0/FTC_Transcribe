// Word (.docx) rendering of a meeting document.
//
// The house style is Document Studio's (see lib/doc-house-style.ts): charcoal
// masthead band, 3px orange accent rule, h1 over a hairline, section headings
// as full-width orange bars, sub-headings over a thin orange rule, and
// zebra-striped two-column spec tables for timestamped data.

import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  Table, TableRow, TableCell, WidthType, TableLayoutType,
  AlignmentType, BorderStyle, ShadingType, LineRuleType, VerticalAlign,
  convertInchesToTwip,
  type IRunOptions,
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
// 18pt, a point under the PDF's 19: Word sets the same string fractionally
// wider than @react-pdf does, which was enough to wrap a title that fits on one
// line in the PDF. The point back buys the headroom without changing the look.
const SIZE_TITLE = 36;
const SIZE_BAR   = 20;   // 10pt — section heading inside the orange bar
const SIZE_BODY  = 22;   // 11pt
const SIZE_META  = 19;   // 9.5pt — the date under the title
const SIZE_DUE   = 18;   // 9pt — due labels, matching the PDF's dueText
const SIZE_FOOT  = 16;   // 8pt

// Letter-spacing (tracking) — docx `characterSpacing` is in TWENTIETHS OF A
// POINT, not points. The all-caps masthead and section bars get a light 1.2–1.4pt
// of tracking (matching the PDF); the earlier 100–140 here meant 5–7pt, which
// blew the caps apart. Do not raise these into three digits.
const TRACK      = 24;   // 1.2pt — section bars
const TRACK_WIDE = 28;   // 1.4pt — masthead

// Page margins in twips (20 per point), mirroring the PDF's page padding.
// A4 is 11906 twips wide, so 1040 a side leaves a 9826-twip content column.
const PAGE_TOP     = 840;   // 42pt
const PAGE_SIDE    = 1040;  // 52pt
const CONTENT_W    = 11906 - PAGE_SIDE * 2;

// Vertical padding inside a colour band, and the gaps around a section bar.
// Twips: 120 = 6pt, matching the PDF's paddingVertical on the same bars.
const BAND_PAD_Y     = 120;
const GAP_BEFORE_BAR = 260;
const GAP_AFTER_BAR  = 120;

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' } as const;
const CELL_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };
// Hairline outline so the zebra block reads as one table rather than as
// loose striped rows. Outside only — internal gridlines stay off.
const TABLE_EDGE = { style: BorderStyle.SINGLE, size: 4, color: hex6(DOC.tableLine) } as const;

type Block = Paragraph | Table;

// Every run is created through this so `noProof` is always set: it tells Word
// not to spell/grammar-check the run. Without it Word draws red/blue proofing
// squiggles under the first word of every bullet (each note is a sentence
// fragment), which makes an otherwise clean document look marked-up on screen.
// The squiggles never print, but they shouldn't be there at all.
const run = (opts: IRunOptions) => new TextRun({ noProof: true, ...opts });

// Round list marker (U+2022). The heavy display weight (Avenir Black) is left
// off the marker glyphs deliberately — a bullet/tick set in a display font
// substitutes to an inconsistent glyph in web viewers (Google Docs, previews);
// in the body font it renders as the same small filled dot / check everywhere.
const BULLET = '•';
const TICK   = '✓';

// ── Building blocks ───────────────────────────────────────────────────────────

function logoParagraph(data: Buffer): Paragraph {
  return new Paragraph({
    children: [new ImageRun({ data, transformation: { width: 132, height: 57 }, type: 'png' })],
    spacing: { before: 0, after: 200 },
  });
}

/**
 * A full-width colour band with real vertical padding.
 *
 * Word's paragraph shading only fills the line box — it ignores space before
 * and after — so a shaded paragraph gives a bar barely taller than its text,
 * and "at least" line spacing pushes the text to the bottom of the band
 * instead of centring it. A one-cell borderless table is the only construct
 * that gives CSS-style padding with vertically-centred text, so the bars match
 * the PDF's `paddingVertical`.
 */
function colourBand(fill: string, children: TextRun[], padY = BAND_PAD_Y): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: {
      top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
      insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
    },
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            children: [new Paragraph({
              children,
              spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO },
            })],
            shading: { type: ShadingType.SOLID, color: fill, fill },
            borders: CELL_BORDERS,
            margins: { top: padY, bottom: padY, left: 160, right: 160 },
            verticalAlign: VerticalAlign.CENTER,
          }),
        ],
      }),
    ],
  });
}

/** Charcoal masthead band — the product name, then this document's kind. */
function mastheadBand(): Table {
  return colourBand(HEADER, [
    run({ text: MASTHEAD, bold: true, color: WHITE, size: SIZE_BAR, characterSpacing: TRACK_WIDE, font: FONT_HEADING }),
    run({ text: '   |   ', color: WHITE, size: SIZE_BAR, font: FONT_HEADING }),
    run({ text: 'MEETING NOTES', color: WHITE, size: SIZE_BAR, characterSpacing: TRACK_WIDE, font: FONT_HEADING }),
  ]);
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
    children: [run({ text, bold: true, color: HEADING, size: SIZE_TITLE, font: FONT_HEADING })],
    spacing: { before: 0, after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 16, color: ORANGE, space: 6 } },
  });
}

function dateRow(date: Date): Paragraph {
  return new Paragraph({
    children: [run({ text: formatLongDate(date), color: SOFT, size: SIZE_META, font: FONT_BODY })],
    spacing: { before: 60, after: 120 },
  });
}

/**
 * h2 — full-width orange bar, white caps. Document Studio's "bar" style.
 * Returned with its own leading gap because a table can't carry space-before.
 */
function sectionBar(text: string): Block[] {
  return [
    gap(GAP_BEFORE_BAR),
    colourBand(ORANGE, [
      run({ text: text.toUpperCase(), bold: true, color: WHITE, size: SIZE_BAR, characterSpacing: TRACK, font: FONT_HEADING }),
    ]),
    gap(GAP_AFTER_BAR),
  ];
}

function bodyText(text: string): Paragraph {
  return new Paragraph({
    children: [run({ text, color: TEXT, size: SIZE_BODY, font: FONT_BODY })],
    spacing: { after: 120, line: 300 },
    alignment: AlignmentType.JUSTIFIED,
  });
}

function bulletPoint(text: string): Paragraph {
  return new Paragraph({
    children: [
      run({ text: `${BULLET}  `, color: ORANGE, size: SIZE_BODY, font: FONT_BODY }),
      run({ text, color: TEXT, size: SIZE_BODY, font: FONT_BODY }),
    ],
    indent: { left: 360, hanging: 200 },
    spacing: { after: 140, line: 290 },
  });
}

/**
 * An action item: the numbered line, then its due date on its own line beneath
 * (matching the PDF, which sets the due label as a separate muted line rather
 * than a bracketed tail).
 *
 * A done item is struck through. `strike` is Word's own character property, so
 * un-ticking one in the document is the strikethrough button on the Home
 * ribbon (Ctrl+D → Strikethrough) — no find-and-replace needed.
 */
function numberedItem(n: number, text: string, due: string | null | undefined, done: boolean): Paragraph[] {
  const dueLabel = formatDue(due);
  return [
    new Paragraph({
      children: [
        run({ text: `${n}.  `, bold: true, color: ORANGE, size: SIZE_BODY, font: FONT_HEADING, strike: done }),
        run({ text, color: done ? SOFT : TEXT, size: SIZE_BODY, font: FONT_BODY, strike: done }),
      ],
      indent: { left: 360, hanging: 200 },
      spacing: { after: 20, line: 290 },
      keepNext: true,
    }),
    new Paragraph({
      children: [run({
        text: dueLabel ? `Due ${dueLabel}` : 'No date set',
        color: SOFT, size: SIZE_DUE, italics: true, font: FONT_BODY, strike: done,
      })],
      indent: { left: 360 },
      spacing: { after: 140, line: 240 },
    }),
  ];
}

function checkItem(text: string): Paragraph {
  return new Paragraph({
    children: [
      run({ text: `${TICK}  `, bold: true, color: ORANGE, size: SIZE_BODY, font: FONT_BODY }),
      run({ text, color: TEXT, size: SIZE_BODY, font: FONT_BODY }),
    ],
    indent: { left: 360, hanging: 200 },
    spacing: { after: 140, line: 290 },
  });
}

/**
 * Topics as a zebra-striped two-column spec table — Document Studio turns any
 * "short label + detail" pair into one of these rather than a bullet list.
 */
function topicsTable(topics: TopicSection[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    // Sums to the content width so the fixed layout doesn't renormalise and
    // the table lines up with the section bars above it.
    columnWidths: [1040, CONTENT_W - 1040],
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
          cell([run({ text: formatClock(t.time), bold: true, color: ORANGE, size: SIZE_META, font: FONT_HEADING })]),
          cell([run({ text: t.title, color: TEXT, size: SIZE_BODY, font: FONT_BODY })]),
        ],
      });
    }),
  });
}

function spacer(after = 160): Paragraph {
  return new Paragraph({ spacing: { after } });
}

/**
 * A precise vertical gap. An empty paragraph normally contributes a full line
 * of its own font's height, which is far too much next to a band; pinning the
 * line to 1pt makes the gap exactly `after` twips.
 */
function gap(after: number): Paragraph {
  return new Paragraph({ spacing: { before: 0, after, line: 20, lineRule: LineRuleType.EXACT } });
}

function footerParagraph(date: Date): Paragraph {
  return new Paragraph({
    children: [
      run({
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
    children.push(...sectionBar(SECTION_LABELS.topics), topicsTable(doc.topics), spacer());
  }

  if (doc.overview) {
    children.push(...sectionBar(SECTION_LABELS.summary), bodyText(doc.overview), spacer());
  }

  if (doc.actionItems.length > 0) {
    children.push(...sectionBar(SECTION_LABELS.actionItems));
    doc.actionItems.forEach((item, i) =>
      children.push(...numberedItem(i + 1, item, doc.actionDue[i], doc.actionChecked.has(i))));
    children.push(spacer());
  }

  if (doc.keyPoints.length > 0) {
    children.push(...sectionBar(SECTION_LABELS.keyPoints));
    doc.keyPoints.forEach(p => children.push(bulletPoint(p)));
    children.push(spacer());
  }

  if (hasDecisions(doc.decisions)) {
    children.push(...sectionBar(SECTION_LABELS.decisions));
    doc.decisions.forEach(d => children.push(checkItem(d)));
    children.push(spacer());
  }

  children.push(footerParagraph(doc.createdAt));

  const document = new Document({
    sections: [{
      properties: {
        page: {
          // Same margins as the PDF (42pt top, 52pt elsewhere) so both formats
          // get the identical content width — with a wider margin the title
          // wrapped to two lines in Word and one in the PDF.
          margin: { top: PAGE_TOP, bottom: PAGE_SIDE, left: PAGE_SIDE, right: PAGE_SIDE },
        },
      },
      children,
    }],
  });

  return Packer.toBuffer(document);
}

// PDF rendering of a meeting document — the same house style as the .docx
// exporter (lib/export-docx.ts), so the two downloads are the same document in
// two file formats.

import React from 'react';
import {
  Document, Page, Text, View, Image, Svg, Path, StyleSheet, renderToBuffer,
} from '@react-pdf/renderer';
import { formatDue } from '@/lib/action-items';
import {
  DOC, MASTHEAD, SECTION_LABELS,
  formatClock, formatLongDate, formatShortDate,
} from '@/lib/doc-house-style';
import { hasDecisions, type MeetingDoc } from '@/lib/export-doc';

// @react-pdf ships no Avenir, so the house heading/body pair maps onto the
// metric-similar built-in Helvetica — the same substitution Word makes on a
// machine without Avenir installed.
const HEAD   = 'Helvetica-Bold';
const BODY   = 'Helvetica';
const ITALIC = 'Helvetica-Oblique';

const styles = StyleSheet.create({
  page: {
    fontFamily: BODY,
    backgroundColor: DOC.white,
    paddingTop: 42,
    paddingBottom: 52,
    paddingHorizontal: 52,
    fontSize: 11,
    color: DOC.text,
  },

  // ── Masthead ──
  logo: { width: 116, height: 50, marginBottom: 14 },
  mastheadBand: {
    backgroundColor: DOC.header,
    paddingVertical: 9,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  mastheadText: { color: DOC.white, fontSize: 9, fontFamily: HEAD, letterSpacing: 1.4 },
  accentRule: { height: 3, backgroundColor: DOC.orange, marginBottom: 22 },

  // ── Title block ──
  title: { fontSize: 19, fontFamily: HEAD, color: DOC.heading, marginBottom: 7, lineHeight: 1.2 },
  titleRule: { height: 2, backgroundColor: DOC.orange, marginBottom: 7 },
  date: { fontSize: 9.5, color: DOC.soft },

  // ── h2 — full-width orange bar with white caps ──
  sectionBar: {
    backgroundColor: DOC.orange,
    borderRadius: 3,
    paddingVertical: 7,
    paddingHorizontal: 12,
    marginTop: 22,
    marginBottom: 12,
  },
  sectionBarText: {
    color: DOC.white, fontSize: 9, fontFamily: HEAD, letterSpacing: 1.2, textTransform: 'uppercase',
  },

  // ── Body blocks ──
  bodyText:   { fontSize: 11, color: DOC.text, lineHeight: 1.55, marginBottom: 8 },
  // No `alignItems` here on purpose: with anything other than the default
  // stretch, yoga measures the wrapping `flex: 1` child at a single line and
  // consecutive rows print on top of each other.
  bulletRow:  { flexDirection: 'row', marginBottom: 7, paddingLeft: 6 },
  // Direct child of a row — needs flex to claim the space beside the mark.
  bulletText: { flex: 1, fontSize: 11, color: DOC.text, lineHeight: 1.5 },
  // Inside the action item's column wrapper. Must NOT carry flex: in a column
  // parent, `flex: 1` makes yoga measure the text at one line and consecutive
  // rows print on top of each other.
  itemText:   { fontSize: 11, color: DOC.text, lineHeight: 1.5 },
  numLabel:   { fontSize: 11, fontFamily: HEAD, color: DOC.orange, marginRight: 7, width: 16 },
  dueText:    { fontSize: 9, color: DOC.soft, fontFamily: ITALIC, marginTop: 2 },
  // A done action item is struck through and greyed back, matching the ticked
  // state of the checklist on screen.
  doneText:   { color: DOC.soft, textDecoration: 'line-through' },
  doneLabel:  { color: DOC.soft, textDecoration: 'line-through' },
  // The standard-14 fonts are WinAnsi-encoded, so "●" and "✓" render as a
  // fallback glyph. Both marks are drawn instead, which also keeps them
  // pixel-aligned with the text baseline.
  markCol:    { width: 9, marginRight: 8, marginTop: 4.5, alignItems: 'center' },
  dot:        { width: 4.5, height: 4.5, borderRadius: 2.25, backgroundColor: DOC.orange },
  tick:       { width: 9, height: 9, marginTop: 0.5 },

  // ── Topics — zebra-striped two-column spec table ──
  // Hairline outline so the block reads as one table, no internal gridlines.
  topicTable:  { borderWidth: 1, borderColor: DOC.tableLine, borderRadius: 3 },
  topicRow:    { flexDirection: 'row', paddingVertical: 5, paddingHorizontal: 8 },
  topicRowAlt: { backgroundColor: DOC.zebra },
  topicTime:   { fontSize: 9, fontFamily: HEAD, color: DOC.orange, width: 38, marginRight: 10, marginTop: 1 },
  topicTitle:  { flex: 1, fontSize: 11, color: DOC.text, lineHeight: 1.4 },

  footer: {
    borderTopWidth: 1,
    borderTopColor: DOC.rule,
    marginTop: 30,
    paddingTop: 10,
    fontSize: 8,
    color: DOC.soft,
    textAlign: 'center',
    fontFamily: ITALIC,
  },
});

const el = React.createElement;

/** h2 — orange bar. `wrap: false` keeps a heading off the foot of a page. */
function sectionBar(label: string) {
  return el(View, { style: styles.sectionBar, wrap: false },
    el(Text, { style: styles.sectionBarText }, label),
  );
}

/** Drawn bullet — see the note on `markCol` above. */
const dotMark = () => el(View, { style: styles.markCol }, el(View, { style: styles.dot }));

/** Drawn tick — same reason. */
const tickMark = () => el(View, { style: styles.markCol },
  el(Svg, { style: styles.tick, viewBox: '0 0 12 12' },
    el(Path, {
      d: 'M1.5 6.4 L4.4 9.3 L10.5 2.6',
      stroke: DOC.orange,
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      fill: 'none',
    }),
  ),
);

function MeetingPDF({ doc, logo }: { doc: MeetingDoc; logo: Buffer | null }) {
  return (
    el(Document, {},
      el(Page, { size: 'A4', style: styles.page },

        /* Masthead: dark wordmark, charcoal band, orange accent rule */
        logo && el(Image, { src: { data: logo, format: 'png' as const }, style: styles.logo }),
        el(View, { style: styles.mastheadBand },
          el(Text, { style: styles.mastheadText }, `${MASTHEAD}   |   MEETING NOTES`),
        ),
        el(View, { style: styles.accentRule }),

        /* Title block */
        el(Text, { style: styles.title }, doc.title),
        el(View, { style: styles.titleRule }),
        el(Text, { style: styles.date }, formatLongDate(doc.createdAt)),

        /* Section order mirrors the AI Notes panel on screen:
           topics · summary · action items · key points · decisions */

        doc.topics.length > 0 && el(View, {},
          sectionBar(SECTION_LABELS.topics),
          el(View, { style: styles.topicTable },
            ...doc.topics.map((t, i) =>
              el(View, { key: i, style: i % 2 === 1 ? [styles.topicRow, styles.topicRowAlt] : styles.topicRow, wrap: false },
                el(Text, { style: styles.topicTime }, formatClock(t.time)),
                el(Text, { style: styles.topicTitle }, t.title),
              )
            ),
          ),
        ),

        doc.overview && el(View, {},
          sectionBar(SECTION_LABELS.summary),
          el(Text, { style: styles.bodyText }, doc.overview),
        ),

        doc.actionItems.length > 0 && el(View, {},
          sectionBar(SECTION_LABELS.actionItems),
          ...doc.actionItems.map((item, i) => {
            const done = doc.actionChecked.has(i);
            return el(View, { key: i, style: styles.bulletRow, wrap: false },
              el(Text, { style: styles.numLabel }, `${i + 1}.`),
              el(View, { style: { flex: 1 } },
                el(Text, { style: done ? [styles.itemText, styles.doneText] : styles.itemText }, item),
                el(Text, { style: done ? [styles.dueText, styles.doneLabel] : styles.dueText },
                  formatDue(doc.actionDue[i]) ? `Due ${formatDue(doc.actionDue[i])}` : 'No date set'),
              ),
            );
          }),
        ),

        doc.keyPoints.length > 0 && el(View, {},
          sectionBar(SECTION_LABELS.keyPoints),
          ...doc.keyPoints.map((p, i) =>
            el(View, { key: i, style: styles.bulletRow, wrap: false },
              dotMark(),
              el(Text, { style: styles.bulletText }, p),
            )
          ),
        ),

        hasDecisions(doc.decisions) && el(View, {},
          sectionBar(SECTION_LABELS.decisions),
          ...doc.decisions.map((d, i) =>
            el(View, { key: i, style: styles.bulletRow, wrap: false },
              tickMark(),
              el(Text, { style: styles.bulletText }, d),
            )
          ),
        ),

        el(Text, { style: styles.footer },
          `Generated by FTC Transcribe  ·  ${formatShortDate(new Date())}`
        ),
      )
    )
  );
}

export function renderMeetingPdf(doc: MeetingDoc, logo: Buffer | null): Promise<Buffer> {
  // Called directly rather than via createElement: renderToBuffer wants an
  // element whose props are DocumentProps, which is what MeetingPDF returns.
  return renderToBuffer(MeetingPDF({ doc, logo }));
}

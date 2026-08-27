'use client';

// The single renderer for every assistant reply in the meeting chat.
//
// A line-by-line parser rather than a markdown library, so the output is plain
// React elements — no dangerouslySetInnerHTML, no sanitiser. It mirrors the main
// app's ChatMarkdown (numbered items get a circular brand badge, bullets get a
// brand dot) and adds the one thing this surface needs: every list item and
// paragraph is a click target that jumps to the moment it came from in the
// transcript, using the same focus channel the notes column already uses.
//
// House style:
//   · numbered lists get a circular orange badge, not a bare "1."
//   · bullets get a soft brand dot
//   · a clickable line shows a jump affordance and highlights on hover
//   · the transcript block it points at flashes (see .transcript-hit)

import { Fragment, type ReactNode } from 'react';

const NUMBERED_RE = /^\s*(\d{1,2})[.)]\s+(.+)$/;
const BULLET_RE = /^\s*[-*•]\s+(.+)$/;
const HEADING_RE = /^\s*(#{1,4})\s+(.+)$/;
/** Bold and inline code, matched in one pass. No links: the chat has none. */
const INLINE_RE = /(\*\*(?:[^*]|\*(?!\*))+?\*\*)|(`[^`]+?`)/g;

function InlineText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(<Fragment key={key++}>{text.slice(cursor, index)}</Fragment>);
    const [raw, bold, code] = match;
    if (bold) {
      parts.push(<strong key={key++} className="font-semibold">{bold.slice(2, -2)}</strong>);
    } else if (code) {
      parts.push(<code key={key++} className="px-1 py-0.5 rounded bg-black/20 text-[0.92em] font-mono break-words">{code.slice(1, -1)}</code>);
    }
    cursor = index + raw.length;
  }
  if (cursor < text.length) parts.push(<Fragment key={key++}>{text.slice(cursor)}</Fragment>);
  return <>{parts}</>;
}

type Block =
  | { type: 'p'; lines: string[] }
  | { type: 'h'; level: number; text: string }
  | { type: 'ol'; items: Array<{ n: string; text: string }> }
  | { type: 'ul'; items: string[] };

/** Group raw lines into blocks so lists render as one unit with correct spacing. */
function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  for (const line of lines) {
    if (!line.trim()) {
      if (blocks.length && blocks[blocks.length - 1].type === 'p') {
        blocks.push({ type: 'p', lines: [] });
      }
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const numbered = NUMBERED_RE.exec(line);
    if (numbered) {
      const last = blocks[blocks.length - 1];
      if (last?.type === 'ol') last.items.push({ n: numbered[1], text: numbered[2].trim() });
      else blocks.push({ type: 'ol', items: [{ n: numbered[1], text: numbered[2].trim() }] });
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const last = blocks[blocks.length - 1];
      if (last?.type === 'ul') last.items.push(bullet[1].trim());
      else blocks.push({ type: 'ul', items: [bullet[1].trim()] });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.type === 'p') last.lines.push(line.trim());
    else blocks.push({ type: 'p', lines: [line.trim()] });
  }
  return blocks.filter((b) => b.type !== 'p' || b.lines.length > 0);
}

/** A line is worth citing only if it carries enough distinctive words for the
 *  transcript matcher to land on the right block — one or two words paraphrased
 *  from a summary would jump somewhere arbitrary, which is worse than no jump. */
function isCitable(text: string): boolean {
  return text.replace(/[^a-z0-9]+/gi, ' ').trim().split(/\s+/).filter((w) => w.length > 2).length >= 3;
}

// A small "jump to transcript" arrow, revealed on hover of a citable row.
const JumpIcon = () => (
  <svg className="chat-jump-icon w-3 h-3 shrink-0 opacity-0 transition-opacity" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
  </svg>
);

export interface ChatMarkdownProps {
  content: string;
  /** Jump to this text's source in the transcript. Absent → lines are static. */
  onCite?: (text: string) => void;
}

export function ChatMarkdown({ content, onCite }: ChatMarkdownProps) {
  const blocks = parseBlocks(content ?? '');
  const inline = (t: string) => <InlineText text={t} />;

  // Wraps a line's text node in a click target when a citation is possible.
  const citable = (text: string, node: ReactNode): ReactNode => {
    if (!onCite || !isCitable(text)) return node;
    return (
      <span
        role="button"
        tabIndex={0}
        title="Jump to this in the transcript"
        onClick={() => onCite(text)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCite(text); } }}
        className="chat-cite group/cite inline-flex items-start gap-1 cursor-pointer rounded hover:text-brand transition-colors"
      >
        <span className="min-w-0">{node}</span>
        <JumpIcon />
      </span>
    );
  };

  return (
    <div className="space-y-1.5">
      {blocks.map((block, i) => {
        if (block.type === 'h') {
          return <p key={i} className="text-sm font-semibold text-ftc-gray leading-relaxed pt-0.5">{inline(block.text)}</p>;
        }
        if (block.type === 'ol') {
          return (
            <div key={i} className="space-y-2 my-1.5">
              {block.items.map((item, j) => (
                <div key={j} className="flex gap-2.5">
                  <span className="text-[11px] font-bold h-5 w-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 leading-none text-brand bg-brand/10">
                    {item.n}
                  </span>
                  <span className="text-sm leading-relaxed min-w-0">{citable(item.text, inline(item.text))}</span>
                </div>
              ))}
            </div>
          );
        }
        if (block.type === 'ul') {
          return (
            <div key={i} className="space-y-2 my-1.5 ml-0.5">
              {block.items.map((item, j) => (
                <div key={j} className="flex gap-2.5">
                  <span className="mt-[7px] shrink-0 h-1.5 w-1.5 rounded-full bg-brand/60" aria-hidden="true" />
                  <span className="text-sm leading-relaxed min-w-0">{citable(item, inline(item))}</span>
                </div>
              ))}
            </div>
          );
        }
        return (
          <p key={i} className="text-sm leading-relaxed">
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {citable(line, inline(line))}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

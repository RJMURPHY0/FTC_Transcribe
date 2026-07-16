'use client';

import { useRef, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import PlaybackBar, { type PlaybackBarHandle } from './PlaybackBar';

interface RawSegment {
  speaker: string;
  start:   number;
  end:     number;
  text:    string;
}

interface MergedGroup {
  speaker:  string;
  start:    number;
  end:      number;
  text:     string;
  rawIdxs:  number[]; // original indices in the raw array
}

interface Props {
  recordingId:  string;
  rawSegments:  RawSegment[];
  speakerOrder: string[];
  hasAudio:     boolean;
}

const SPEAKER_COLOURS = [
  { label: 'text-blue-400',    dot: 'bg-blue-400',    border: 'border-blue-400/20',    bg: 'bg-blue-400/5'    },
  { label: 'text-violet-400',  dot: 'bg-violet-400',  border: 'border-violet-400/20',  bg: 'bg-violet-400/5'  },
  { label: 'text-emerald-400', dot: 'bg-emerald-400', border: 'border-emerald-400/20', bg: 'bg-emerald-400/5' },
  { label: 'text-amber-400',   dot: 'bg-amber-400',   border: 'border-amber-400/20',   bg: 'bg-amber-400/5'   },
  { label: 'text-rose-400',    dot: 'bg-rose-400',    border: 'border-rose-400/20',    bg: 'bg-rose-400/5'    },
];

function fmt(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function mergeSegments(segs: RawSegment[]): MergedGroup[] {
  return segs.reduce<MergedGroup[]>((acc, seg, i) => {
    const last = acc[acc.length - 1];
    if (last && last.speaker === String(seg.speaker)) {
      acc[acc.length - 1] = {
        ...last,
        text:    last.text + ' ' + seg.text.trim(),
        end:     seg.end,
        rawIdxs: [...last.rawIdxs, i],
      };
    } else {
      acc.push({ speaker: String(seg.speaker), start: seg.start, end: seg.end, text: seg.text.trim(), rawIdxs: [i] });
    }
    return acc;
  }, []);
}

export default function TranscriptPlayer({ recordingId, rawSegments, speakerOrder, hasAudio }: Props) {
  const router       = useRouter();
  const playerRef    = useRef<PlaybackBarHandle>(null);
  const [activeIdx,  setActiveIdx]  = useState<number>(-1);
  const [menuOpen,   setMenuOpen]   = useState<number | null>(null); // group index
  const [reassigning, setReassigning] = useState(false);

  const groups = useMemo(() => mergeSegments(rawSegments), [rawSegments]);

  const handleTimeUpdate = (t: number) => {
    const idx = groups.findLastIndex(g => g.start <= t);
    setActiveIdx(idx);
  };

  const handleGroupClick = (start: number) => {
    playerRef.current?.openAndSeek(start);
  };

  const handleReassign = async (groupIdx: number, newSpeaker: string) => {
    setMenuOpen(null);
    setReassigning(true);
    try {
      await fetch(`/api/recordings/${recordingId}/transcript-segment`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ segmentIndices: groups[groupIdx].rawIdxs, newSpeaker }),
      });
      router.refresh();
    } catch { /* ignore */ }
    finally { setReassigning(false); }
  };

  return (
    <div className="space-y-3">
      {/* Full-recording playback — fixed bar along the bottom of the page */}
      {hasAudio && (
        <PlaybackBar
          ref={playerRef}
          recordingId={recordingId}
          onTimeUpdate={handleTimeUpdate}
        />
      )}

      {/* Transcript blocks */}
      <div className="rounded-2xl border border-surface-border bg-surface-card p-5 space-y-4">
        {groups.map((group, i) => {
          const cidx   = speakerOrder.indexOf(group.speaker);
          const c      = SPEAKER_COLOURS[(cidx >= 0 ? cidx : 0) % SPEAKER_COLOURS.length];
          const active = i === activeIdx;
          const isMenuOpen = menuOpen === i;
          const otherSpeakers = speakerOrder.filter(s => s !== group.speaker);

          return (
            <div
              key={i}
              className={`relative rounded-xl border px-4 py-3 transition-all duration-150
                ${c.border} ${c.bg}
                ${active ? 'ring-2 ring-brand/60' : ''}`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${c.dot}`} />
                <span
                  className={`text-xs font-semibold ${c.label} ${hasAudio ? 'cursor-pointer' : ''}`}
                  onClick={() => hasAudio && handleGroupClick(group.start)}
                >
                  {group.speaker}
                </span>
                <span className="text-[10px] text-ftc-mid tabular-nums">{fmt(group.start)}</span>
                <div className="ml-auto relative">
                  <button
                    type="button"
                    title="Reassign speaker"
                    onClick={e => { e.stopPropagation(); setMenuOpen(isMenuOpen ? null : i); }}
                    className="p-1 rounded-lg text-surface-muted hover:text-ftc-mid transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                      <circle cx="5"  cy="12" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="19" cy="12" r="1.5" />
                    </svg>
                  </button>

                  {/* Reassign dropdown */}
                  {isMenuOpen && otherSpeakers.length > 0 && (
                    <div className="absolute right-0 top-7 z-10 min-w-[120px] rounded-xl border border-surface-border bg-surface-card shadow-lg overflow-hidden">
                      <p className="text-[10px] text-surface-muted px-3 py-1.5 border-b border-surface-border">Reassign to</p>
                      {otherSpeakers.map(sp => (
                        <button
                          key={sp}
                          type="button"
                          disabled={reassigning}
                          onClick={() => handleReassign(i, sp)}
                          className="w-full text-left text-xs text-ftc-gray px-3 py-2 hover:bg-surface-raised transition-colors"
                        >
                          {sp}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <p
                className={`text-sm text-ftc-gray leading-relaxed ${hasAudio ? 'cursor-pointer' : ''}`}
                onClick={() => hasAudio && handleGroupClick(group.start)}
              >
                {group.text.trim()}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

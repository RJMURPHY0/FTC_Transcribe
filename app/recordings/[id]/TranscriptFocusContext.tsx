'use client';

// Cross-column channel that lets any summary line (a key point, action item,
// decision or topic) ask the transcript to scroll to and briefly highlight the
// block it came from. Dispatchers live in the notes and chat columns; the sole
// subscriber is TranscriptPlayer. Kept deliberately tiny: a single "focus
// request" bumped by a nonce so clicking the same line twice re-fires.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export type FocusRequest =
  | { kind: 'text'; value: string; nonce: number }
  // `seek` moves the audio player too. Set only for a ?t= deep link, where
  // landing on the moment is the whole point of following the link; a topic
  // click just scrolls, as it always has.
  | { kind: 'time'; value: number; seek?: boolean; nonce: number };

interface TranscriptFocusValue {
  request: FocusRequest | null;
  /** True only when a segmented transcript is present (so jumping does something). */
  enabled: boolean;
  focusText: (value: string) => void;
  focusTime: (seconds: number, seek?: boolean) => void;
}

const noop = () => {};
const Ctx = createContext<TranscriptFocusValue>({
  request: null,
  enabled: false,
  focusText: noop,
  focusTime: noop,
});

export function useTranscriptFocus(): TranscriptFocusValue {
  return useContext(Ctx);
}

export function TranscriptFocusProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [request, setRequest] = useState<FocusRequest | null>(null);
  const nonce = useRef(0);

  const focusText = useCallback((value: string) => {
    const v = value.trim();
    if (!enabled || !v) return;
    setRequest({ kind: 'text', value: v, nonce: ++nonce.current });
  }, [enabled]);

  const focusTime = useCallback((seconds: number, seek = false) => {
    if (!enabled || !Number.isFinite(seconds)) return;
    setRequest({ kind: 'time', value: seconds, seek, nonce: ++nonce.current });
  }, [enabled]);

  // ?t=<seconds> deep link, fired once the transcript is ready. Read off
  // window rather than useSearchParams: that hook forces the whole subtree
  // into a Suspense/CSR bailout, and this is a one-shot read on mount.
  const consumed = useRef(false);
  useEffect(() => {
    if (!enabled || consumed.current) return;
    const raw = new URLSearchParams(window.location.search).get('t');
    if (raw === null) return;
    consumed.current = true;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    focusTime(seconds, true);
  }, [enabled, focusTime]);

  return (
    <Ctx.Provider value={{ request, enabled, focusText, focusTime }}>
      {children}
    </Ctx.Provider>
  );
}

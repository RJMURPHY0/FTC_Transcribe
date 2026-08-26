'use client';

// Cross-column channel that lets any summary line (a key point, action item,
// decision or topic) ask the transcript to scroll to and briefly highlight the
// block it came from. Dispatchers live in the notes and chat columns; the sole
// subscriber is TranscriptPlayer. Kept deliberately tiny: a single "focus
// request" bumped by a nonce so clicking the same line twice re-fires.

import { createContext, useCallback, useContext, useRef, useState } from 'react';

export type FocusRequest =
  | { kind: 'text'; value: string; nonce: number }
  | { kind: 'time'; value: number; nonce: number };

interface TranscriptFocusValue {
  request: FocusRequest | null;
  /** True only when a segmented transcript is present (so jumping does something). */
  enabled: boolean;
  focusText: (value: string) => void;
  focusTime: (seconds: number) => void;
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

  const focusTime = useCallback((seconds: number) => {
    if (!enabled || !Number.isFinite(seconds)) return;
    setRequest({ kind: 'time', value: seconds, nonce: ++nonce.current });
  }, [enabled]);

  return (
    <Ctx.Provider value={{ request, enabled, focusText, focusTime }}>
      {children}
    </Ctx.Provider>
  );
}

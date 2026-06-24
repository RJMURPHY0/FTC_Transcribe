'use client';

// Shared action-items store so the Action Items panel and the chat checklist
// stay in sync live. Holds the item text, due dates (parallel array) and the
// set of completed indices, and persists every change to the summary API.

import { createContext, useContext, useState, useCallback } from 'react';
import { normaliseDue } from '@/lib/action-items';

interface ActionItemsState {
  items:   string[];
  due:     (string | null)[];
  checked: Set<number>;
  toggleChecked: (index: number) => void;
  setDue:        (index: number, iso: string | null) => void;
  replaceItems:  (nextItems: string[]) => void;
}

const Ctx = createContext<ActionItemsState | null>(null);

export function useActionItems(): ActionItemsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useActionItems must be used within ActionItemsProvider');
  return ctx;
}

export function ActionItemsProvider({
  recordingId,
  initialItems,
  initialDue,
  initialChecked,
  children,
}: {
  recordingId:    string;
  initialItems:   string[];
  initialDue:     (string | null)[];
  initialChecked: number[];
  children:       React.ReactNode;
}) {
  const [items,   setItems]   = useState<string[]>(initialItems);
  const [due,     setDueArr]  = useState<(string | null)[]>(
    initialItems.map((_, i) => normaliseDue(initialDue[i])),
  );
  const [checked, setChecked] = useState<Set<number>>(() => new Set(initialChecked));

  // Fire-and-forget persistence — the UI is already updated optimistically.
  const persist = useCallback((body: Record<string, unknown>) => {
    fetch(`/api/recordings/${recordingId}/summary`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {/* silent — non-critical */});
  }, [recordingId]);

  const toggleChecked = useCallback((index: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      persist({ actionItemsChecked: Array.from(next) });
      return next;
    });
  }, [persist]);

  const setDue = useCallback((index: number, iso: string | null) => {
    setDueArr((prev) => {
      const next = [...prev];
      next[index] = normaliseDue(iso);
      persist({ actionItemsDue: next });
      return next;
    });
  }, [persist]);

  // Replace the item list (text edits). Preserve each item's due date and
  // checked state by matching on identical text — edited wording resets them.
  const replaceItems = useCallback((nextItems: string[]) => {
    const nextDue: (string | null)[] = [];
    const nextChecked = new Set<number>();
    nextItems.forEach((text, i) => {
      const oldIdx = items.indexOf(text);
      nextDue[i] = oldIdx !== -1 ? due[oldIdx] ?? null : null;
      if (oldIdx !== -1 && checked.has(oldIdx)) nextChecked.add(i);
    });
    setItems(nextItems);
    setDueArr(nextDue);
    setChecked(nextChecked);
    persist({
      actionItems: nextItems,
      actionItemsDue: nextDue,
      actionItemsChecked: Array.from(nextChecked),
    });
  }, [items, due, checked, persist]);

  return (
    <Ctx.Provider value={{ items, due, checked, toggleChecked, setDue, replaceItems }}>
      {children}
    </Ctx.Provider>
  );
}

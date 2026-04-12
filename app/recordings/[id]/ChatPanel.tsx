'use client';

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  'What were the key decisions made?',
  'Who has action items and what are they?',
  'Summarise the main points in bullet form',
  'What topics were left unresolved?',
];

export default function ChatPanel({ recordingId }: { recordingId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const send = async (text = input) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = { role: 'user', content: trimmed };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch(`/api/recordings/${recordingId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, history: messages }),
      });
      const data = await res.json() as { reply?: string; error?: string };
      const reply = data.reply ?? data.error ?? 'Something went wrong.';
      setMessages([...nextHistory, { role: 'assistant', content: reply }]);
    } catch {
      setMessages([...nextHistory, { role: 'assistant', content: 'Network error — please try again.' }]);
    } finally {
      setLoading(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Shared inner content used in both normal and fullscreen modes
  const inner = (
    <>
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-surface-border flex items-center gap-2.5 flex-shrink-0">
        <div className="w-2 h-2 rounded-full bg-brand" />
        <h3 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid">
          Ask about this meeting
        </h3>
        <div className="ml-auto flex items-center gap-2">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setMessages([])}
              className="text-xs text-ftc-mid hover:text-ftc-gray transition-colors touch-manipulation"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setFullscreen((f) => !f)}
            className="text-ftc-mid hover:text-ftc-gray transition-colors"
            aria-label={fullscreen ? 'Exit fullscreen' : 'Expand'}
          >
            {fullscreen ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
            )}
          </button>
          {fullscreen && (
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="text-ftc-mid hover:text-ftc-gray transition-colors"
              aria-label="Close"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
        {messages.length === 0 && (
          <div className="flex flex-col gap-4 h-full">
            <div className="flex flex-col items-center justify-center gap-3 py-6">
              <div className="w-12 h-12 rounded-full bg-brand/10 border border-brand/20 flex items-center justify-center">
                <svg className="w-6 h-6 text-brand" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-ftc-gray">Ask anything about this meeting</p>
                <p className="text-xs text-ftc-mid mt-0.5">Claude will answer using the transcript and notes</p>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="text-left text-xs px-3.5 py-2.5 rounded-xl border border-surface-border bg-surface-raised text-ftc-mid hover:border-brand/40 hover:text-ftc-gray transition-all touch-manipulation"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex items-end gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-6 h-6 rounded-full bg-brand/15 border border-brand/20 flex items-center justify-center flex-shrink-0 mb-0.5">
                <span className="text-[9px] font-bold text-brand">AI</span>
              </div>
            )}
            <div className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
              msg.role === 'user'
                ? 'btn-brand text-white rounded-br-sm'
                : 'bg-surface-raised text-ftc-gray rounded-bl-sm border border-surface-border'
            }`}>
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex items-end gap-2 justify-start">
            <div className="w-6 h-6 rounded-full bg-brand/15 border border-brand/20 flex items-center justify-center flex-shrink-0 mb-0.5">
              <span className="text-[9px] font-bold text-brand">AI</span>
            </div>
            <div className="bg-surface-raised border border-surface-border rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-ftc-mid animate-bounce bounce-delay-0" />
              <div className="w-1.5 h-1.5 rounded-full bg-ftc-mid animate-bounce bounce-delay-120" />
              <div className="w-1.5 h-1.5 rounded-full bg-ftc-mid animate-bounce bounce-delay-240" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-surface-border flex-shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about this meeting…"
            rows={1}
            disabled={loading}
            className="flex-1 bg-surface-raised border border-surface-border rounded-xl px-3 py-2.5 text-sm text-ftc-gray placeholder:text-ftc-mid outline-none focus:border-brand resize-none transition-colors disabled:opacity-50 leading-relaxed"
          />
          <button
            type="button"
            onClick={() => send()}
            disabled={!input.trim() || loading}
            className="btn-brand p-2.5 rounded-xl text-white disabled:opacity-40 flex-shrink-0 transition-opacity"
            aria-label="Send message"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        </div>
        <p className="text-[10px] text-ftc-mid mt-1.5 text-center">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </>
  );

  // Fullscreen: portal directly into document.body — escapes all ancestor overflow/stacking constraints
  if (fullscreen && mounted) {
    return createPortal(
      <>
        <div
          className="fixed inset-0 bg-black/85 chat-fullscreen-backdrop"
          onClick={() => setFullscreen(false)}
        />
        <div
          className="fixed inset-4 rounded-2xl border border-surface-border bg-surface-card shadow-2xl flex flex-col chat-fullscreen-panel"
        >
          {inner}
        </div>
      </>,
      document.body,
    );
  }

  // Normal inline panel
  return (
    <div className="rounded-2xl border border-surface-border bg-surface-card flex flex-col chat-panel-default-height">
      {inner}
    </div>
  );
}

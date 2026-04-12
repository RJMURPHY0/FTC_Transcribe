'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  mentionedIds?: string[];
}

const SUGGESTIONS = [
  'What did we discuss last week?',
  'Find all action items across meetings',
  'What decisions have been made recently?',
  'Search for what a specific person said',
];

export default function GlobalChatWidget() {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
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
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = (await res.json()) as { reply?: string; error?: string; mentionedIds?: string[] };
      const reply = data.reply ?? data.error ?? 'Something went wrong.';
      setMessages([...nextHistory, {
        role: 'assistant',
        content: reply,
        mentionedIds: data.mentionedIds ?? [],
      }]);
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

  // Strip [MEETING:id] tags from display text
  const cleanText = (text: string) => text.replace(/\[MEETING:[^\]]+\]/g, '').trim();

  return (
    <>
      {/* Chat panel */}
      {open && (
        <div
          className={`fixed z-50 border border-surface-border bg-surface-card shadow-2xl flex flex-col overflow-hidden transition-all duration-200 ${
            fullscreen
              ? 'inset-4 rounded-2xl'
              : 'bottom-20 right-4 w-80 sm:w-96 rounded-2xl'
          }`}
          style={fullscreen ? undefined : { height: '500px' }}
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-surface-border flex items-center gap-2 flex-shrink-0 bg-surface-raised">
            <div className="flex-1 min-w-0 flex items-center">
              <img src="/chatbot-logo.png" alt="FTC Chat Bot" style={{ height: '36px', objectFit: 'contain' }} />
            </div>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => setMessages([])}
                className="text-[10px] text-ftc-mid hover:text-ftc-gray transition-colors"
              >
                Clear
              </button>
            )}
            {/* Fullscreen toggle */}
            <button
              type="button"
              onClick={() => setFullscreen((f) => !f)}
              className="text-ftc-mid hover:text-ftc-gray transition-colors ml-1"
              aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
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
            <button
              type="button"
              onClick={() => { setOpen(false); setFullscreen(false); }}
              className="text-ftc-mid hover:text-ftc-gray transition-colors ml-1"
              aria-label="Close"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
            {messages.length === 0 && (
              <div className="flex flex-col gap-3 h-full">
                <div className="text-center pt-4 pb-2">
                  <p className="text-sm font-medium text-ftc-gray">Search all your meetings</p>
                  <p className="text-xs text-ftc-mid mt-1">Ask anything — I'll find the right meeting</p>
                </div>
                <div className="flex flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      className="text-left text-xs px-3 py-2.5 rounded-xl border border-surface-border bg-surface-raised text-ftc-mid hover:border-brand/40 hover:text-ftc-gray transition-all touch-manipulation"
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
                  <div className="w-6 h-6 rounded-full btn-brand flex items-center justify-center flex-shrink-0 mb-0.5">
                    <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
                    </svg>
                  </div>
                )}
                <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'btn-brand text-white rounded-br-sm'
                    : 'bg-surface-raised text-ftc-gray rounded-bl-sm border border-surface-border'
                }`}>
                  <p className="whitespace-pre-wrap">{cleanText(msg.content)}</p>
                  {msg.mentionedIds && msg.mentionedIds.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-surface-border/50 flex flex-col gap-1">
                      {msg.mentionedIds.map((id) => (
                        <Link
                          key={id}
                          href={`/recordings/${id}`}
                          onClick={() => setOpen(false)}
                          className="flex items-center gap-1.5 text-xs text-brand hover:text-brand-dark transition-colors font-medium"
                        >
                          <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                          </svg>
                          Open meeting →
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {loading && (
              <div className="flex items-end gap-2 justify-start">
                <div className="w-6 h-6 rounded-full btn-brand flex items-center justify-center flex-shrink-0 mb-0.5">
                  <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
                  </svg>
                </div>
                <div className="bg-surface-raised border border-surface-border rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-ftc-mid animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-ftc-mid animate-bounce" style={{ animationDelay: '120ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-ftc-mid animate-bounce" style={{ animationDelay: '240ms' }} />
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-3 border-t border-surface-border flex-shrink-0">
            <div className="flex items-end gap-2">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search meetings…"
                rows={1}
                disabled={loading}
                className="flex-1 bg-surface-raised border border-surface-border rounded-xl px-3 py-2 text-sm text-ftc-gray placeholder:text-ftc-mid outline-none focus:border-brand resize-none disabled:opacity-50 leading-relaxed transition-colors"
              />
              <button
                type="button"
                onClick={() => send()}
                disabled={!input.trim() || loading}
                className="btn-brand p-2.5 rounded-xl text-white disabled:opacity-40 flex-shrink-0 transition-opacity"
                aria-label="Send"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating button — hidden when fullscreen so it doesn't cover the input */}
      {!fullscreen && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="fixed bottom-4 right-4 z-50 w-14 h-14 rounded-full btn-brand shadow-xl flex items-center justify-center touch-manipulation transition-transform active:scale-95"
          aria-label={open ? 'Close chat' : 'Open chat'}
        >
          {open ? (
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
            </svg>
          )}
        </button>
      )}
    </>
  );
}

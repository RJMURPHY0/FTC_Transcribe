'use client';

import React, { useEffect, useRef, useState, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

// ─── Glow enable/disable (shared with the Contacts CRM convention) ────────────
// Cards read this from localStorage so the effect can be toggled globally, and
// re-read on the `ftc-glow-change` event. Default ON. Server components can drop
// a card in without threading state; pass `enabled` to override per-card.

const GLOW_KEY = 'ftc_list_glow';

export function isGlowEnabled(): boolean {
  try {
    return localStorage.getItem(GLOW_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Flip the global card glow on/off and notify every mounted card. */
export function setGlowEnabled(on: boolean) {
  try {
    localStorage.setItem(GLOW_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('ftc-glow-change'));
}

function useGlowEnabled(override?: boolean): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (override !== undefined) return;
    const read = () => setOn(isGlowEnabled());
    read();
    window.addEventListener('ftc-glow-change', read);
    return () => window.removeEventListener('ftc-glow-change', read);
  }, [override]);
  return override !== undefined ? override : on;
}

// ─── Shared border-glow CSS ───────────────────────────────────────────────────
// Uses --glow-radius / --glow-border-size to avoid colliding with Tailwind's
// rounded-* radii. Ported verbatim from the Contacts CRM.

const beforeAfterStyles = `
  [data-glow]::before,
  [data-glow]::after {
    pointer-events: none;
    content: "";
    position: absolute;
    inset: calc(var(--glow-border-size) * -1);
    border: var(--glow-border-size) solid transparent;
    border-radius: calc(var(--glow-radius) * 1px);
    background-attachment: fixed;
    background-size: calc(100% + (2 * var(--glow-border-size))) calc(100% + (2 * var(--glow-border-size)));
    background-repeat: no-repeat;
    background-position: 50% 50%;
    mask: linear-gradient(transparent, transparent), linear-gradient(white, white);
    mask-clip: padding-box, border-box;
    mask-composite: intersect;
  }
  [data-glow]::before {
    background-image: radial-gradient(
      calc(var(--spotlight-size) * 0.75) calc(var(--spotlight-size) * 0.75) at
      calc(var(--x, -9999) * 1px) calc(var(--y, -9999) * 1px),
      hsl(var(--hue, 36) calc(var(--saturation, 95) * 1%) calc(var(--lightness, 55) * 1%) / var(--border-spot-opacity, 0.85)), transparent 100%
    );
  }
  [data-glow]::after {
    background-image: radial-gradient(
      calc(var(--spotlight-size) * 0.5) calc(var(--spotlight-size) * 0.5) at
      calc(var(--x, -9999) * 1px) calc(var(--y, -9999) * 1px),
      hsl(0 100% 100% / var(--border-light-opacity, 0)), transparent 100%
    );
  }
  [data-glow-inner] {
    position: absolute;
    inset: 0;
    will-change: filter;
    opacity: var(--outer, 1);
    border-radius: calc(var(--glow-radius) * 1px);
    filter: blur(calc(var(--glow-border-size) * 10));
    background: none;
    pointer-events: none;
  }
  [data-glow-inner]::before {
    inset: -10px;
    border-width: 10px;
  }
`;

// ─── SpotlightCard ────────────────────────────────────────────────────────────
// on=true  → cursor spotlight + orange accent bar + border glow
// on=false → plain Card + accent bar only (no glow effects whatsoever)

interface SpotlightCardProps extends React.ComponentPropsWithoutRef<typeof Card> {
  spotlightColor?: string;
  accentColor?: string;
  hue?: number;
  /** Force the glow on/off. Omit to follow the global toggle (localStorage). */
  enabled?: boolean;
  /** Suppress the 3px left accent bar unless the card is `active`. Default on —
   *  list cards stay clean at rest and only mark the left edge when selected. */
  hideAccentBar?: boolean;
  /** Persistent "selected" highlight — a bracket round the card's left edge. */
  active?: boolean;
}

const CornerBracket = ({ color, active = false }: { color: string; active?: boolean }) => (
  <div
    aria-hidden
    className={cn(
      'pointer-events-none absolute -left-0.5 top-0 bottom-0 w-6 rounded-l-[inherit] z-20',
      active ? 'border-l-4' : 'border-l-[3px]',
    )}
    style={{ borderColor: color, filter: active ? `drop-shadow(0 0 5px ${color}aa)` : undefined }}
  />
);

export const SpotlightCard = React.forwardRef<HTMLDivElement, SpotlightCardProps>(
  ({ children, className, spotlightColor = 'rgba(243,146,0,0.32)', accentColor = '#f39200',
     hue = 36, enabled, hideAccentBar = true, active = false, onMouseMove, onMouseEnter, onMouseLeave,
     style: propStyle, ...props }, forwardedRef) => {

    const on = useGlowEnabled(enabled);
    const cardRef = useRef<HTMLDivElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);

    const setRef = (el: HTMLDivElement | null) => {
      (cardRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    };

    const showMarker = !!accentColor && (!hideAccentBar || active);

    // OFF: plain static Card — no spotlight, no cursor glow. A subtle CSS border
    // hover keeps cards feeling tappable; selected state keeps its tint + bracket.
    if (!on) {
      const hex = accentColor?.startsWith('#') ? accentColor : '#f39200';
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const activeBg = `rgba(${r},${g},${b},0.08)`;
      return (
        <Card
          ref={setRef}
          className={cn('relative transition-colors hover:border-surface-muted', className)}
          style={{ backgroundColor: active ? activeBg : undefined, ...propStyle }}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          {...props}
        >
          {showMarker && <CornerBracket color={hex} active={active} />}
          <div className="relative z-10">{children}</div>
        </Card>
      );
    }

    const accentHex = accentColor?.startsWith('#') ? accentColor : '#f39200';
    const ar = parseInt(accentHex.slice(1, 3), 16);
    const ag = parseInt(accentHex.slice(3, 5), 16);
    const ab = parseInt(accentHex.slice(5, 7), 16);
    const accentBorder  = `rgba(${ar},${ag},${ab},0.22)`;
    const accentShadow  = `0 0 0 1px rgba(${ar},${ag},${ab},0.45), 0 0 18px rgba(${ar},${ag},${ab},0.12)`;
    const accentHoverBg = `rgba(${ar},${ag},${ab},0.04)`;
    const activeBg      = `rgba(${ar},${ag},${ab},0.08)`;

    // --glow-radius matches rounded-2xl (1rem = 16px), +1 for the -1px inset.
    const glowVars = {
      '--glow-radius': '17',
      '--glow-border-size': '1px',
      '--spotlight-size': '260px',
      '--hue': String(hue),
      '--saturation': '95',
      '--lightness': '55',
      '--border-spot-opacity': '0.85',
      '--border-light-opacity': '0',
      '--x': '-9999',
      '--y': '-9999',
      borderColor: accentBorder,
      backgroundColor: active ? activeBg : undefined,
      transition: 'box-shadow 150ms, background-color 150ms',
      ...propStyle,
    } as React.CSSProperties;

    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: beforeAfterStyles }} />
        <Card
          ref={setRef}
          data-glow=""
          className={cn('relative', className)}
          style={glowVars}
          onMouseMove={(e) => {
            if (cardRef.current) {
              cardRef.current.style.setProperty('--x', e.clientX.toFixed(2));
              cardRef.current.style.setProperty('--y', e.clientY.toFixed(2));
              if (overlayRef.current) {
                const rect = cardRef.current.getBoundingClientRect();
                overlayRef.current.style.background = `radial-gradient(220px circle at ${e.clientX - rect.left}px ${e.clientY - rect.top}px, ${spotlightColor}, transparent 65%)`;
              }
            }
            onMouseMove?.(e);
          }}
          onMouseEnter={(e) => {
            if (overlayRef.current) overlayRef.current.style.opacity = '1';
            if (cardRef.current) {
              cardRef.current.style.boxShadow = accentShadow;
              cardRef.current.style.backgroundColor = active ? activeBg : accentHoverBg;
            }
            onMouseEnter?.(e);
          }}
          onMouseLeave={(e) => {
            if (overlayRef.current) overlayRef.current.style.opacity = '0';
            if (cardRef.current) {
              cardRef.current.style.setProperty('--x', '-9999');
              cardRef.current.style.setProperty('--y', '-9999');
              cardRef.current.style.boxShadow = '';
              cardRef.current.style.backgroundColor = active ? activeBg : '';
            }
            onMouseLeave?.(e);
          }}
          {...props}
        >
          {/* Inner overflow-hidden clips the spotlight without clipping ::before/::after */}
          <div className="absolute inset-0 overflow-hidden rounded-[inherit] pointer-events-none">
            <div
              ref={overlayRef}
              className="absolute inset-0"
              style={{
                opacity: 0,
                transition: 'opacity 120ms',
                background: `radial-gradient(220px circle at 50% 50%, ${spotlightColor}, transparent 65%)`,
              }}
            />
          </div>
          {showMarker && <CornerBracket color={accentHex} active={active} />}
          <div className="relative z-10">{children}</div>
        </Card>
      </>
    );
  }
);
SpotlightCard.displayName = 'SpotlightCard';

// ─── GlowCard ─────────────────────────────────────────────────────────────────
// Stat-card border glow that tracks the pointer across the viewport.

interface GlowCardProps {
  children: ReactNode;
  className?: string;
  glowColor?: 'blue' | 'purple' | 'green' | 'red' | 'orange';
  /** Exact glow hue (0-360). When set, overrides the preset with a SOLID hue. */
  hue?: number;
  /** Force the glow on/off. Omit to follow the global toggle (localStorage). */
  enabled?: boolean;
  backdrop?: string;
}

const glowColorMap = {
  blue:   { base: 220, spread: 200 },
  purple: { base: 280, spread: 300 },
  green:  { base: 120, spread: 200 },
  red:    { base: 0,   spread: 200 },
  orange: { base: 36,  spread: 0   },
};

const GlowCard: React.FC<GlowCardProps> = ({
  children,
  className = '',
  glowColor = 'orange',
  hue,
  enabled,
  backdrop,
}) => {
  const on = useGlowEnabled(enabled);
  const cardRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!on) return;
    const syncPointer = (e: PointerEvent) => {
      const { clientX: x, clientY: y } = e;
      if (cardRef.current) {
        cardRef.current.style.setProperty('--x', x.toFixed(2));
        cardRef.current.style.setProperty('--xp', (x / window.innerWidth).toFixed(2));
        cardRef.current.style.setProperty('--y', y.toFixed(2));
        cardRef.current.style.setProperty('--yp', (y / window.innerHeight).toFixed(2));
      }
    };
    document.addEventListener('pointermove', syncPointer);
    return () => document.removeEventListener('pointermove', syncPointer);
  }, [on]);

  const preset = glowColorMap[glowColor];
  const base = hue !== undefined ? hue : preset.base;
  const spread = hue !== undefined ? 0 : preset.spread;

  const backdropStyles = {
    '--backdrop': backdrop ?? 'hsl(0 0% 60% / 0.06)',
    '--backup-border': 'var(--backdrop)',
    '--glow-border-width': '2',
    '--glow-border-size': 'calc(var(--glow-border-width, 2) * 1px)',
    '--glow-radius': '17',
    backgroundColor: 'var(--backdrop, transparent)',
    border: 'var(--glow-border-size) solid var(--backup-border)',
    position: 'relative' as const,
  } as React.CSSProperties;

  if (!on) {
    return (
      <div ref={cardRef} style={backdropStyles} className={`rounded-2xl relative ${className}`}>
        {children}
      </div>
    );
  }

  const inlineStyles = {
    ...backdropStyles,
    '--base': base,
    '--spread': spread,
    '--size': '220',
    '--outer': '1',
    '--spotlight-size': 'calc(var(--size, 150) * 1px)',
    '--hue': 'calc(var(--base) + (var(--xp, 0) * var(--spread, 0)))',
    backgroundImage: `radial-gradient(
      var(--spotlight-size) var(--spotlight-size) at
      calc(var(--x, 0) * 1px) calc(var(--y, 0) * 1px),
      hsl(var(--hue, 210) calc(var(--saturation, 100) * 1%) calc(var(--lightness, 70) * 1%) / var(--bg-spot-opacity, 0.10)), transparent
    )`,
    backgroundSize: 'calc(100% + (2 * var(--glow-border-size))) calc(100% + (2 * var(--glow-border-size)))',
    backgroundPosition: '50% 50%',
    backgroundAttachment: 'fixed',
    touchAction: 'none' as const,
  } as React.CSSProperties;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: beforeAfterStyles }} />
      <div
        ref={cardRef}
        data-glow
        style={inlineStyles}
        className={`rounded-2xl relative ${className}`}
      >
        <div ref={innerRef} data-glow-inner />
        {children}
      </div>
    </>
  );
};

export { GlowCard };

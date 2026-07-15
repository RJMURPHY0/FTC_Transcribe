import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ── Theme-aware tokens ──
        // Values are RGB channel triples set in globals.css per [data-theme].
        // The rgb(var(--x) / <alpha-value>) form keeps Tailwind opacity
        // modifiers (bg-surface/80, border-brand/50, …) working in both themes.
        // Page / surface backgrounds — warm charcoal (dark) / warm off-white (light)
        surface: {
          DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)',        // page bg
          card:    'rgb(var(--c-surface-card) / <alpha-value>)',   // card
          raised:  'rgb(var(--c-surface-raised) / <alpha-value>)', // elevated / filled input
          border:  'rgb(var(--c-surface-border) / <alpha-value>)', // border
          muted:   'rgb(var(--c-surface-muted) / <alpha-value>)',  // subtle border / faint text
          dark:    'rgb(var(--c-surface-dark) / <alpha-value>)',   // FTC dark grey
        },
        // FTC primary orange — same accent in both themes
        brand: {
          light:   'rgb(var(--c-brand-light) / <alpha-value>)',
          DEFAULT: 'rgb(var(--c-brand) / <alpha-value>)',
          dark:    'rgb(var(--c-brand-dark) / <alpha-value>)',
        },
        // FTC neutral text greys
        ftc: {
          gray:    'rgb(var(--c-ftc-gray) / <alpha-value>)',  // primary text
          mid:     'rgb(var(--c-ftc-mid) / <alpha-value>)',   // muted text
          dark:    'rgb(var(--c-ftc-dark) / <alpha-value>)',  // FTC dark charcoal
        },
      },
      boxShadow: {
        brand:        '0 4px 20px rgba(243,146,0,0.28)',
        'brand-lg':   '0 4px 36px rgba(243,146,0,0.45)',
        'record-on':  '0 0 36px rgba(239,68,68,0.38), 0 8px 28px rgba(239,68,68,0.25)',
        'record-off': '0 0 36px rgba(243,146,0,0.38), 0 8px 28px rgba(243,146,0,0.25)',
      },
    },
  },
  plugins: [],
};

export default config;

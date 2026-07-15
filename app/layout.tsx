import type { Metadata, Viewport } from 'next';
import './globals.css';
import GlobalChatWidget from '@/components/GlobalChatWidget';
import ServiceWorkerRegistrar from '@/components/ServiceWorkerRegistrar';

export const metadata: Metadata = {
  title: 'FTC Transcribe – AI Meeting Notes',
  description: 'Record any conversation and get an instant transcript, summary, and action items powered by AI.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'FTC Transcribe',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#030712',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Set theme before first paint to avoid a flash. Default is dark;
            only switches to light when the user has chosen it (key: ftc-theme). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('ftc-theme');document.documentElement.classList.toggle('dark',t!=='light')}catch(e){}`,
          }}
        />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=4" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png?v=4" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon.png?v=4" />
      </head>
      <body className="min-h-screen">
        {children}
        <GlobalChatWidget />
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}

/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV === 'development';

const securityHeaders = [
  { key: 'X-Content-Type-Options',    value: 'nosniff' },
  { key: 'X-Frame-Options',           value: 'DENY' },
  { key: 'X-XSS-Protection',          value: '1; mode=block' },
  { key: 'Referrer-Policy',           value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy',        value: 'camera=(), geolocation=(), microphone=(self)' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      isDev
        ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
        : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' https://api.anthropic.com https://api.groq.com https://api.openai.com https://ijeeghdxokfvlfarojlm.supabase.co",
      "font-src 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  },
];

// Voice-ID native deps: keep out of the webpack bundle (loaded via require at
// runtime) and force-trace the platform binaries that dynamic requires hide
// from Vercel's file tracer.
const voiceIdTraceIncludes = [
  './node_modules/sherpa-onnx-node/**',
  './node_modules/sherpa-onnx-linux-x64/**',
  './node_modules/ffmpeg-static/**',
];

const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['sherpa-onnx-node', 'ffmpeg-static'],
    outputFileTracingIncludes: {
      '/api/recordings/[id]/append-chunk': voiceIdTraceIncludes,
      '/api/recordings/[id]/finalize': voiceIdTraceIncludes,
      '/api/recordings/[id]/rediarize': voiceIdTraceIncludes,
      '/api/jobs/finalize': voiceIdTraceIncludes,
      '/api/voice-profiles': voiceIdTraceIncludes,
      '/api/transcribe': voiceIdTraceIncludes,
      '/api/health': voiceIdTraceIncludes,
    },
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
      {
        source: '/manifest.json',
        headers: [{ key: 'Content-Type', value: 'application/manifest+json' }],
      },
    ];
  },
};

module.exports = nextConfig;

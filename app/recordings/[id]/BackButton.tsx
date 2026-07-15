'use client';

import { useRouter } from 'next/navigation';

// Back via history when we arrived from inside the app — the list page is
// restored instantly from the client router cache with scroll position and
// folder/org filters intact. Falls back to a normal navigation for deep links.
export default function BackButton() {
  const router = useRouter();

  const handleBack = () => {
    let fromApp = false;
    try {
      fromApp =
        sessionStorage.getItem('came-from-list') === '1' ||
        document.referrer.startsWith(window.location.origin);
    } catch { /* sessionStorage unavailable */ }
    if (fromApp && window.history.length > 1) router.back();
    else router.push('/');
  };

  return (
    <button
      type="button"
      onClick={handleBack}
      className="flex items-center gap-1.5 text-sm font-medium text-ftc-mid hover:text-ftc-gray transition-colors p-2 -ml-2 rounded-xl touch-manipulation flex-shrink-0"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      <span className="hidden sm:inline">Back</span>
    </button>
  );
}

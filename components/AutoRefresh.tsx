"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-reads the page's data every few seconds while a rollout is moving, so the
// results appear as the worker produces them. Stops when unmounted.
export function AutoRefresh({ everyMs = 3000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return (
    <span className="text-xs text-slate-500" aria-live="polite">
      Updating live
    </span>
  );
}

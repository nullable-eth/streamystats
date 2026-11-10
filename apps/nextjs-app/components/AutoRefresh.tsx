"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Reloads the page's server data every `seconds` while the page is in view,
 * and as soon as it comes back into view, so counts and statuses keep up
 * with background jobs. Client state (open dialogs, typed input) is kept.
 */
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(refresh, seconds * 1000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, seconds]);
  return null;
}

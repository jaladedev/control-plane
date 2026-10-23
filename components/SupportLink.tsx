"use client";

import { useState, useTransition } from "react";
import { createSupportLinkAction } from "@/app/schools/actions";

type Link = { url: string; expiresAt: string };

// Asks for a one-time read-only support link and shows it as a plain link, so
// the click is a real user action (a script-opened tab can be blocked). The
// link is cleared a moment after it is used, and never stored.
export function SupportLink({ schoolId }: { schoolId: string }) {
  const [link, setLink] = useState<Link | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function request() {
    setError(null);
    setLink(null);
    start(async () => {
      const result = await createSupportLinkAction(schoolId);
      if ("error" in result) setError(result.error);
      else setLink(result);
    });
  }

  return (
    <div className="space-y-2 text-sm">
      <p className="text-slate-600">
        Opens the school&apos;s dashboard as its read-only support account. The link works once and
        expires in 5 minutes. The request is logged here, and everything you view is logged at the
        school.
      </p>
      <button
        type="button"
        onClick={request}
        disabled={pending}
        className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-50 disabled:opacity-60"
      >
        {pending ? "Creating link…" : "Create support link"}
      </button>
      {error && <p className="text-red-700">{error}</p>}
      {link && (
        <p>
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setTimeout(() => setLink(null), 1000)}
            className="font-medium text-blue-700 underline"
          >
            Open the read-only session
          </a>{" "}
          <span className="text-xs text-slate-500">
            (until {new Date(link.expiresAt).toLocaleTimeString()})
          </span>
        </p>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/client";

/**
 * Keeps an event on a student's shortlist for 30 days.
 *
 * The expiry lives in the table default, not here, so a clock set wrong in the
 * browser cannot extend it. Only the student themselves can read or change their
 * own list - see the RLS policy in 014.
 */
export default function SaveButton({
  eventId,
  initiallySaved,
  expiresAt,
}: {
  eventId: number;
  initiallySaved: boolean;
  expiresAt?: string | null;
}) {
  const [saved, setSaved] = useState(initiallySaved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const daysLeft =
    saved && expiresAt
      ? Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000))
      : null;

  async function toggle() {
    setBusy(true);
    setError("");
    const supabase = browserClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      setBusy(false);
      return;
    }

    if (saved) {
      const { error: removeError } = await supabase
        .from("saved_events")
        .delete()
        .eq("student_id", data.user.id)
        .eq("event_id", eventId);
      if (removeError) setError(removeError.message);
      else setSaved(false);
    } else {
      const { error: saveError } = await supabase
        .from("saved_events")
        .insert({ student_id: data.user.id, event_id: eventId });
      if (saveError) setError(`${saveError.message} - has migration 014 been run?`);
      else setSaved(true);
    }
    setBusy(false);
  }

  return (
    <button
      type="button"
      className={`btn savebtn ${saved ? "on" : ""}`}
      onClick={toggle}
      disabled={busy}
      title={
        error ||
        (saved
          ? `On your saved list${daysLeft !== null ? ` - kept for ${daysLeft} more day${daysLeft === 1 ? "" : "s"}` : ""}. Click to remove.`
          : "Keep this on your saved list for 30 days")
      }
    >
      {busy
        ? "..."
        : saved
          ? `✓ Saved${daysLeft !== null ? ` · ${daysLeft}d` : ""}`
          : "Save for later"}
    </button>
  );
}

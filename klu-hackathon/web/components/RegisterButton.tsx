"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/client";

/**
 * "Register Now" - opens the event's own site and records that this student went there.
 *
 * The click is logged through record_registration_click(), which runs as the signed-in
 * student and can only write that student's own row. The external page is opened first
 * so a slow or failed write never costs the student their click.
 *
 * What this proves: the student went to register. Not that they finished - that happens
 * on Unstop/Devfolio, where we have no visibility. Hence the separate "I registered"
 * confirmation.
 */
export default function RegisterButton({
  eventId,
  href,
  initiallyRegistered,
  initiallyConfirmed,
}: {
  eventId: number;
  href: string;
  initiallyRegistered: boolean;
  initiallyConfirmed: boolean;
}) {
  const [clicked, setClicked] = useState(initiallyRegistered);
  const [confirmed, setConfirmed] = useState(initiallyConfirmed);
  const [saving, setSaving] = useState(false);

  async function onRegister() {
    setClicked(true); // optimistic: the student has visibly acted
    try {
      await browserClient().rpc("record_registration_click", { p_event_id: eventId });
    } catch {
      // The external page is already opening; losing the log entry must not
      // interrupt the student. The next click will record it.
    }
  }

  async function toggleConfirmed() {
    const next = !confirmed;
    setConfirmed(next);
    setSaving(true);
    const supabase = browserClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      await supabase
        .from("event_registrations")
        .update({ confirmed: next, confirmed_at: next ? new Date().toISOString() : null })
        .eq("student_id", data.user.id)
        .eq("event_id", eventId);
    }
    setSaving(false);
  }

  return (
    <>
      <a
        className="btn primary"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onRegister}
      >
        {clicked ? "Open again" : "Register Now"}
      </a>

      {clicked && (
        <button
          type="button"
          className={`btn confirmbtn ${confirmed ? "done" : ""}`}
          onClick={toggleConfirmed}
          disabled={saving}
          title={
            confirmed
              ? "Click to undo if you did not actually register"
              : "Click once you have finished registering on the event's own site"
          }
        >
          {saving ? "Saving..." : confirmed ? "✓ Registered" : "I registered"}
        </button>
      )}
    </>
  );
}

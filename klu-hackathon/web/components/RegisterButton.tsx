"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/client";

/**
 * Every registration is reported to the college through one Microsoft Form. Set
 * NEXT_PUBLIC_REGISTRATION_FORM_URL in Vercel to change it without touching the code;
 * this default is used when that variable is unset.
 */
const FORM_URL =
  process.env.NEXT_PUBLIC_REGISTRATION_FORM_URL || "https://forms.cloud.microsoft/r/vkjJ9TQsm3";

/**
 * Two steps, in the order a student actually does them:
 *
 *   Register Now  -> the hackathon's own site (Unstop, Devfolio, HackIndia), where the
 *                    real registration happens. The click is logged against this event.
 *   I registered  -> opens the KLU form so the college gets its record, and marks the
 *                    row confirmed.
 *
 * The form cannot know which event was clicked, so that pairing is kept here, in
 * event_registrations, which is what the admin table reads.
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
      // The event's page is already opening; losing the log entry must not interrupt
      // the student. The next click records it.
    }
  }

  async function setConfirmedTo(next: boolean) {
    setConfirmed(next);
    setSaving(true);
    const supabase = browserClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      // Make sure a row exists even if the click was never logged, so ticking this
      // first still records which event it was for.
      await supabase.rpc("record_registration_click", { p_event_id: eventId });
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
        className="btn ghost"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onRegister}
        title="Opens the hackathon's own registration page"
      >
        {clicked ? "Open again" : "Register Now"}
      </a>

      {confirmed ? (
        <button
          type="button"
          className="btn confirmbtn done"
          onClick={() => setConfirmedTo(false)}
          disabled={saving}
          title="Click to undo if you did not actually register"
        >
          {saving ? "Saving..." : "\u2713 Registered"}
        </button>
      ) : (
        <a
          className="btn confirmbtn"
          href={FORM_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setConfirmedTo(true)}
          title="Opens the KLU registration form - fill it in to complete your entry"
        >
          I registered - fill the KLU form
        </a>
      )}
    </>
  );
}

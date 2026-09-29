"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/client";

/**
 * Shown only to admins and the owner. A recommended event sorts above everything
 * else in the portal and is highlighted, so this is the one editing power a plain
 * admin has - set_recommended() checks is_admin() and touches nothing else.
 */
export default function RecommendButton({
  eventId,
  initial,
}: {
  eventId: number;
  initial: boolean;
}) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    const next = !on;
    setBusy(true);
    setError("");
    const { error: rpcError } = await browserClient().rpc("set_recommended", {
      p_event_id: eventId,
      p_on: next,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setOn(next);
  }

  return (
    <button
      type="button"
      className={`btn recbtn ${on ? "on" : ""}`}
      onClick={toggle}
      disabled={busy}
      title={
        error ||
        (on
          ? "Recommended - students see this at the top. Click to remove."
          : "Recommend this to students: it moves to the top of the page")
      }
    >
      {busy ? "..." : on ? "★ Recommended" : "☆ Recommend"}
    </button>
  );
}

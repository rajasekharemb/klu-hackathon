"use client";

import { useState } from "react";
import Link from "next/link";
import { browserClient } from "@/lib/supabase/client";

const DEFAULT_DOMAIN = "kluniversity.in";

/**
 * Sends the recovery link. The link lands on /auth/callback, which exchanges the
 * code for a session and forwards to /change-password - the screen that already
 * exists for setting a password, rather than a second one that does the same job.
 *
 * The same message shows whether or not the address has an account. Saying "no
 * such account" would let anyone test which roll numbers are registered.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setError("");

    const value = email.trim().toLowerCase();
    const address = value.includes("@") ? value : `${value}@${DEFAULT_DOMAIN}`;

    const { error: sendError } = await browserClient().auth.resetPasswordForEmail(address, {
      redirectTo: `${window.location.origin}/auth/callback?next=/change-password`,
    });

    setBusy(false);
    if (sendError && !/user not found/i.test(sendError.message)) {
      setError(sendError.message);
      return;
    }
    setSent(true);
  }

  return (
    <div className="authwrap">
      <form className="authcard" onSubmit={onSubmit}>
        <h1>Reset your password</h1>
        <p className="sub">We will email you a link to set a new one.</p>

        {error && <div className="msg error">{error}</div>}

        {sent ? (
          <>
            <div className="msg ok">
              If that address has an account, a reset link is on its way. It is valid for one
              hour. Check spam if it does not arrive within a few minutes.
            </div>
            <p className="altline">
              <Link href="/login">Back to sign in</Link>
            </p>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="email">College email or username</label>
              <input
                id="email"
                type="text"
                required
                autoComplete="username"
                placeholder="2200030123@kluniversity.in"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <p className="hint">You can type just your roll number.</p>

            <button className="btn primary wide" type="submit" disabled={busy}>
              {busy ? "Sending..." : "Send the reset link"}
            </button>

            <p className="altline">
              Remembered it? <Link href="/login">Sign in</Link>
            </p>
          </>
        )}
      </form>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";
import { passwordProblem } from "@/lib/password";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    setError("");

    const problem = passwordProblem(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    const supabase = browserClient();

    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setBusy(false);
      return;
    }

    // Clear the flag, otherwise middleware keeps redirecting back here.
    const { data: session } = await supabase.auth.getUser();
    if (session.user) {
      await supabase.from("profiles").update({ must_change_password: false }).eq("id", session.user.id);
    }

    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <div className="authwrap">
      <form className="authcard" onSubmit={onSubmit}>
        <h1>Set your password</h1>
        <p className="sub">You are signed in with the shared default password.</p>

        <div className="msg info">
          Everyone was given the same starting password, so until you change it your account is
          not private. Choose one only you know.
        </div>

        {error && <div className="msg error">{error}</div>}

        <div className="field">
          <label htmlFor="password">New password</label>
          <input id="password" type="password" required autoComplete="new-password"
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <p className="hint">At least 8 characters.</p>

        <div className="field">
          <label htmlFor="confirm">Confirm new password</label>
          <input id="confirm" type="password" required autoComplete="new-password"
                 value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>

        <button className="btn primary wide" type="submit" disabled={busy}>
          {busy ? "Saving..." : "Save and continue"}
        </button>
      </form>
    </div>
  );
}


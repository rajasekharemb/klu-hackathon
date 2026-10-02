"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { browserClient } from "@/lib/supabase/client";
import { passwordProblem } from "@/lib/password";

const DEFAULT_DOMAIN = "kluniversity.in";

/**
 * Reset by one-time code: address, the six digits we email, then the new password,
 * all on one screen.
 *
 * A code rather than a link, deliberately. Exchange Online quarantines mail from an
 * outside sender whose body is a single "reset your password" link - that is the
 * shape of a phishing message - and the student never sees it, not even in Junk. A
 * six-digit number with no link in the body does not trip that filter.
 *
 * Step one reports the same thing whether or not the address has an account. Saying
 * "no such account" would let anyone test which roll numbers are registered.
 */

type Stage = "email" | "code" | "password";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function sendCode(to: string) {
    const { error: sendError } = await browserClient().auth.resetPasswordForEmail(to);
    // "User not found" is swallowed on purpose - see the note above.
    if (sendError && !/user not found/i.test(sendError.message)) return sendError.message;
    return "";
  }

  async function onRequest(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setError("");

    const value = email.trim().toLowerCase();
    const to = value.includes("@") ? value : `${value}@${DEFAULT_DOMAIN}`;

    const problem = await sendCode(to);
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    setAddress(to);
    setNote(`If ${to} has an account, a six-digit code is on its way.`);
    setStage("code");
  }

  async function onResend() {
    setBusy(true);
    setError("");
    setNote("");
    const problem = await sendCode(address);
    setBusy(false);
    // Supabase refuses a second send inside the per-user interval, which is worth
    // showing - otherwise the button looks broken.
    if (problem) setError(problem);
    else setNote("Another code is on its way.");
  }

  async function onVerify(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setError("");
    setNote("");

    const { error: verifyError } = await browserClient().auth.verifyOtp({
      email: address,
      token: code.trim(),
      type: "recovery",
    });

    setBusy(false);
    if (verifyError) {
      setError(
        /expired|invalid/i.test(verifyError.message)
          ? "That code is wrong or has expired. Ask for a new one."
          : verifyError.message,
      );
      return;
    }
    // The code signed them in, so they may now set a password for themselves.
    setStage("password");
  }

  async function onSetPassword(formEvent: React.FormEvent) {
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

    // Clear the flag an owner reset would have set, otherwise middleware bounces
    // them straight back to /change-password.
    const { data: session } = await supabase.auth.getUser();
    if (session.user) {
      await supabase.from("profiles").update({ must_change_password: false }).eq("id", session.user.id);
    }

    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <div className="authwrap">
      {stage === "email" && (
        <form className="authcard" onSubmit={onRequest}>
          <h1>Reset your password</h1>
          <p className="sub">We will email you a six-digit code.</p>

          {error && <div className="msg error">{error}</div>}

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
            {busy ? "Sending..." : "Send the code"}
          </button>

          <p className="altline">
            Remembered it? <Link href="/login">Sign in</Link>
          </p>
        </form>
      )}

      {stage === "code" && (
        <form className="authcard" onSubmit={onVerify}>
          <h1>Enter the code</h1>
          <p className="sub">Check your inbox, and your junk folder.</p>

          {note && <div className="msg ok">{note}</div>}
          {error && <div className="msg error">{error}</div>}

          <div className="field">
            <label htmlFor="code">Six-digit code</label>
            <input
              id="code"
              type="text"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={10}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <p className="hint">It expires in one hour.</p>

          <button className="btn primary wide" type="submit" disabled={busy}>
            {busy ? "Checking..." : "Continue"}
          </button>

          <p className="altline">
            <button className="linklike" type="button" onClick={onResend} disabled={busy}>
              Send it again
            </button>
          </p>
          <p className="altline">
            <Link href="/login">Back to sign in</Link>
          </p>
        </form>
      )}

      {stage === "password" && (
        <form className="authcard" onSubmit={onSetPassword}>
          <h1>Set your password</h1>
          <p className="sub">Choose one only you know.</p>

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
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { browserClient } from "@/lib/supabase/client";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setError("");

    const supabase = browserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (signInError) {
      setError(
        signInError.message === "Invalid login credentials"
          ? "That email and password do not match an account."
          : signInError.message,
      );
      setBusy(false);
      return;
    }

    // Middleware decides where they actually land - it sends anyone still on the
    // shared default password to /change-password.
    router.replace(params.get("next") || "/dashboard");
    router.refresh();
  }

  return (
    <form className="authcard" onSubmit={onSubmit}>
      <h1>Sign in</h1>
      <p className="sub">KL University hackathon portal</p>

      {error && <div className="msg error">{error}</div>}

      <div className="field">
        <label htmlFor="email">College email</label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          placeholder="2200030123@kluniversity.in"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <button className="btn primary wide" type="submit" disabled={busy}>
        {busy ? "Signing in..." : "Sign in"}
      </button>

      <p className="altline">
        No account yet? <Link href="/signup">Register with your college email</Link>
      </p>
    </form>
  );
}

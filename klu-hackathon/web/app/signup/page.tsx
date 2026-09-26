"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";

// Kept in step with allowed_email_domain() in supabase/schema.sql. The database
// rejects anything else anyway; this is only so the student sees it immediately.
const ALLOWED_DOMAINS = ["kluniversity.in", "klu.ac.in"];

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: "", rollNo: "", fullName: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function set(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [field]: e.target.value });
  }

  async function onSubmit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    setError("");
    setNotice("");

    const email = form.email.trim().toLowerCase();
    if (!ALLOWED_DOMAINS.some((domain) => email.endsWith(`@${domain}`))) {
      setError(`Use your college email (${ALLOWED_DOMAINS.map((d) => `@${d}`).join(" or ")}).`);
      return;
    }
    if (form.password.length < 8) {
      setError("Choose a password of at least 8 characters.");
      return;
    }
    if (form.password !== form.confirm) {
      setError("The two passwords do not match.");
      return;
    }

    setBusy(true);
    const supabase = browserClient();
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password: form.password,
      options: {
        data: {
          roll_no: form.rollNo.trim() || email.split("@")[0],
          full_name: form.fullName.trim(),
          must_change_password: false,
        },
      },
    });

    if (signUpError) {
      setError(signUpError.message);
      setBusy(false);
      return;
    }

    // With email confirmation on, there is no session yet and the student must
    // click the link. With it off, they are already signed in.
    if (data.session) {
      router.replace("/dashboard");
      router.refresh();
    } else {
      setNotice(`Account created. Check ${email} for the confirmation link, then sign in.`);
      setBusy(false);
    }
  }

  return (
    <div className="authwrap">
      <form className="authcard" onSubmit={onSubmit}>
        <h1>Create your account</h1>
        <p className="sub">Open to KL University students only</p>

        {error && <div className="msg error">{error}</div>}
        {notice && <div className="msg ok">{notice}</div>}

        <div className="field">
          <label htmlFor="email">College email</label>
          <input id="email" type="email" required autoComplete="email"
                 placeholder="2200030123@kluniversity.in" value={form.email} onChange={set("email")} />
        </div>

        <div className="field">
          <label htmlFor="fullName">Full name</label>
          <input id="fullName" type="text" required autoComplete="name"
                 value={form.fullName} onChange={set("fullName")} />
        </div>

        <div className="field">
          <label htmlFor="rollNo">Roll number</label>
          <input id="rollNo" type="text" placeholder="2200030123"
                 value={form.rollNo} onChange={set("rollNo")} />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" required autoComplete="new-password"
                 value={form.password} onChange={set("password")} />
        </div>
        <p className="hint">At least 8 characters.</p>

        <div className="field">
          <label htmlFor="confirm">Confirm password</label>
          <input id="confirm" type="password" required autoComplete="new-password"
                 value={form.confirm} onChange={set("confirm")} />
        </div>

        <button className="btn primary wide" type="submit" disabled={busy}>
          {busy ? "Creating..." : "Create account"}
        </button>

        <p className="altline">
          Already registered? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}


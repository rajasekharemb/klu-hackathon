"use client";

import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";

export default function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    await browserClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <button type="button" onClick={signOut}>
      Sign out
    </button>
  );
}


/**
 * Supabase client for Client Components ("use client").
 *
 * Kept in its own file on purpose. When the browser and server clients shared one module,
 * every Client Component that imported `browserClient` also pulled in `next/headers`
 * through the server client, and the build failed with "You're importing a component that
 * needs next/headers". Splitting the modules is the fix - do not merge them back.
 *
 * Only the anon key is used here. Row Level Security is what keeps one student from
 * reading another's profile; the key itself is safe to ship to the browser.
 */
import { createBrowserClient } from "@supabase/ssr";

export function browserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

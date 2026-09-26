/**
 * Supabase client for Server Components, Route Handlers and Server Actions.
 * Never import this from a file marked "use client" - it uses next/headers.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

export function serverClient() {
  const store = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return store.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          // Server Components are not allowed to write cookies. Middleware refreshes the
          // session on every request, so swallowing this is correct, not a silent bug.
          try {
            store.set({ name, value, ...options });
          } catch {
            /* called from a Server Component - ignore */
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            store.set({ name, value: "", ...options });
          } catch {
            /* ignore */
          }
        },
      },
    },
  );
}

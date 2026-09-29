/**
 * One definition of what each role may do.
 *
 * This lived in three places - middleware, the admin page and the dashboard link -
 * and drifted: when the founding account became 'owner', the middleware still tested
 * role === "admin" and redirected the owner away from the page they alone are meant
 * to control. Import these instead of comparing role strings.
 *
 * These decide what gets rendered. The real boundary is Row Level Security and the
 * is_owner() / is_admin() checks inside the database functions.
 */
export type Role = "student" | "admin" | "owner";

/** Reaches /admin at all: the registration list and the refresh log. */
export function canSeeAdminArea(role?: string | null): boolean {
  return role === "admin" || role === "owner";
}

/** Manages accounts and deletes records. The owner only. */
export function canManage(role?: string | null): boolean {
  return role === "owner";
}

/**
 * Shared constants. A plain module on purpose: PAGE_SIZE used to live in
 * EventBoard.tsx, which is marked "use client". Importing it from the server
 * component made .range(0, PAGE_SIZE - 1) resolve against an undefined value, so
 * the first page came back empty while the count still said 100 - the dashboard
 * rendered "0 of 100 shown". Keep values both sides need in here.
 */

/** Cards per page on the student board. Ten keeps a page to two tidy rows. */
export const PAGE_SIZE = 10;

/** Rows per page in the admin tables. */
export const ADMIN_PAGE_SIZE = 10;

/**
 * The rules for a password a student picks for themselves. Both /change-password
 * and the last step of /forgot-password ask for the same thing, so the check lives
 * here rather than in each of them, where the two copies would drift apart.
 */

// Every password that has been handed out in bulk. None of them may be chosen as a
// "new" password - that would leave the account on one other people already know.
export const SHARED_PASSWORDS = ["Kl_hackathon", "klu123"];

export function passwordProblem(password: string, confirm: string): string {
  if (password.length < 8) return "Choose a password of at least 8 characters.";
  if (password !== confirm) return "The two passwords do not match.";
  if (SHARED_PASSWORDS.some((shared) => shared.toLowerCase() === password.toLowerCase())) {
    return "That is a shared password everyone was given. Pick one only you know.";
  }
  return "";
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";

export type Profile = {
  id: string;
  email: string;
  roll_no: string | null;
  full_name: string | null;
  branch: string | null;
  year: number | null;
  role: string;
  created_at: string;
};

export default function AdminStudents({
  total,
  adminCount,
  meId,
}: {
  total: number;
  adminCount: number;
  meId: string;
}) {
  const router = useRouter();
  const [students, setStudents] = useState<Profile[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  // Every guard is enforced again inside the database functions - set_admin and
  // admin_delete_student both require is_owner(). These only decide which buttons
  // are worth showing; only the owner ever reaches this component at all.

  // Supabase's rpc() returns a thenable query builder rather than a Promise, so the
  // parameter is typed PromiseLike - Promise<T> would not accept it.
  async function run(
    key: string,
    action: () => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ) {
    setBusy(key);
    setMessage("");
    setError("");
    const { data, error: rpcError } = await action();
    setBusy(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setMessage(typeof data === "string" ? data : "Done.");
    await search();
    router.refresh();
  }

  function toggleRole(student: Profile) {
    const makeAdmin = student.role !== "admin";
    const who = student.full_name || student.email;
    if (!confirm(makeAdmin ? `Give ${who} admin access?` : `Remove admin access from ${who}?`)) return;
    run(`role-${student.id}`, () =>
      browserClient().rpc("set_admin", { p_email: student.email, p_is_admin: makeAdmin }),
    );
  }

  function remove(student: Profile) {
    const who = student.full_name || student.email;
    if (!confirm(`Delete ${who}?\n\nTheir login and all their registrations are removed. This cannot be undone.`)) return;
    run(`del-${student.id}`, () =>
      browserClient().rpc("admin_delete_student", { p_email: student.email }),
    );
  }

  const rows = students;

  /** Accounts are looked up, not listed - there are hundreds of them. */
  async function search(formEvent?: React.FormEvent) {
    formEvent?.preventDefault();
    const needle = filter.trim();
    if (!needle) return;
    setBusy("search");
    setError("");
    setMessage("");
    const safe = needle.replace(/[%,()]/g, " ");
    const { data, error: queryError } = await browserClient()
      .from("profiles")
      .select("*")
      .or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%,roll_no.ilike.%${safe}%,branch.ilike.%${safe}%`)
      .order("created_at", { ascending: false })
      .limit(100);
    setBusy(null);
    setSearched(true);
    if (queryError) {
      setError(queryError.message);
      return;
    }
    setStudents((data ?? []) as Profile[]);
  }

  return (
    <>
      {message && <div className="msg ok">{message}</div>}
      {error && <div className="msg error">{error}</div>}

      <form className="tabletools" onSubmit={search}>
        <input
          type="search"
          className="adminsearch"
          placeholder={`Search ${total} accounts by name, roll number, email or branch...`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="submit" className="minibtn" disabled={busy !== null || !filter.trim()}>
          {busy === "search" ? "Searching..." : "Search"}
        </button>
        {searched && (
          <button
            type="button"
            className="minibtn"
            onClick={() => { setStudents([]); setSearched(false); setFilter(""); }}
          >
            Clear
          </button>
        )}
      </form>

      {!searched ? (
        <p className="empty">Search above to find an account.</p>
      ) : (
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Roll no</th><th>Name</th><th>Email</th><th>Branch</th>
              <th>Role</th><th>Registered</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((student) => {
              const isMe = student.id === meId;
              const isAdmin = student.role === "admin";
              const isOwnerRow = student.role === "owner";
              const lastAdmin = isAdmin && adminCount <= 1;
              // The owner account is not editable from this table, by anyone.
              const locked = isOwnerRow || isMe;
              return (
                <tr key={student.id}>
                  <td>{student.roll_no || "-"}</td>
                  <td>
                    {student.full_name || "-"} {isMe && <span className="youtag">you</span>}
                  </td>
                  <td>{student.email}</td>
                  <td>{student.branch || "-"}{student.year ? ` / Y${student.year}` : ""}</td>
                  <td><span className={`state ${isAdmin ? "open" : "tba"}`}>{student.role}</span></td>
                  <td>{new Date(student.created_at).toLocaleDateString("en-IN")}</td>
                  <td>
                    <div className="rowbtns">
                      <button
                        type="button"
                        className="minibtn"
                        disabled={busy !== null || locked || (isAdmin && lastAdmin)}
                        title={
                          isOwnerRow
                            ? "The owner account cannot be changed"
                            : isMe
                              ? "You cannot change your own role"
                              : isAdmin && lastAdmin
                                ? "This is the only admin"
                                : isAdmin
                                  ? "Remove admin access - they keep student access"
                                  : "Give access to registrations and the refresh log"
                        }
                        onClick={() => toggleRole(student)}
                      >
                        {busy === `role-${student.id}`
                          ? "..."
                          : isOwnerRow
                            ? "Owner"
                            : isAdmin
                              ? "Make student"
                              : "Make admin"}
                      </button>
                      <button
                        type="button"
                        className="minibtn danger"
                        disabled={busy !== null || locked}
                        title={
                          isOwnerRow
                            ? "The owner account cannot be deleted"
                            : isMe
                              ? "You cannot delete your own account"
                              : "Delete this account and its registrations"
                        }
                        onClick={() => remove(student)}
                      >
                        {busy === `del-${student.id}` ? "..." : "Delete"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={7}>Nothing matched that search.</td></tr>}
          </tbody>
        </table>
      </div>
      )}
    </>
  );
}

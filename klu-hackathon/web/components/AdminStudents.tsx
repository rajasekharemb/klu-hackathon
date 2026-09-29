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

export default function AdminStudents({ students, meId }: { students: Profile[]; meId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  // Every guard is enforced again inside the database functions. These only decide
  // which buttons are worth showing.
  const adminCount = students.filter((s) => s.role === "admin").length;

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

  const needle = filter.trim().toLowerCase();
  const rows = needle
    ? students.filter((s) =>
        [s.full_name, s.email, s.roll_no, s.branch].join(" ").toLowerCase().includes(needle),
      )
    : students;

  return (
    <>
      {message && <div className="msg ok">{message}</div>}
      {error && <div className="msg error">{error}</div>}

      <input
        type="search"
        className="adminsearch"
        placeholder="Filter by name, roll number, email or branch..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

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
              const lastAdmin = isAdmin && adminCount <= 1;
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
                        disabled={busy !== null || (isAdmin && (isMe || lastAdmin))}
                        title={
                          isAdmin && isMe
                            ? "You cannot remove your own admin access"
                            : isAdmin && lastAdmin
                              ? "This is the only admin"
                              : isAdmin
                                ? "Remove admin access"
                                : "Give admin access"
                        }
                        onClick={() => toggleRole(student)}
                      >
                        {busy === `role-${student.id}`
                          ? "..."
                          : isAdmin
                            ? "Make student"
                            : "Make admin"}
                      </button>
                      <button
                        type="button"
                        className="minibtn danger"
                        disabled={busy !== null || isMe || lastAdmin}
                        title={isMe ? "You cannot delete your own account" : "Delete this account"}
                        onClick={() => remove(student)}
                      >
                        {busy === `del-${student.id}` ? "..." : "Delete"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={7}>No accounts match that filter.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

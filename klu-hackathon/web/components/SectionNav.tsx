"use client";

/**
 * The two links in the header. They used to be plain #hackathons anchors, which
 * only work when that section happens to be on the page - with "My registrations"
 * active and nothing registered, neither section is rendered and clicking did
 * nothing at all.
 *
 * They now tell the board which view to show. The board lives further down the
 * tree and owns the filter state, so the message goes through a window event
 * rather than lifting that state into the server component above.
 */
export const SECTION_EVENT = "portal:section";

export default function SectionNav() {
  function show(kind: "open" | "hiring") {
    window.dispatchEvent(new CustomEvent(SECTION_EVENT, { detail: kind }));
  }

  return (
    <>
      <button type="button" onClick={() => show("open")}>
        Hackathons
      </button>
      <button type="button" onClick={() => show("hiring")}>
        Hiring challenges
      </button>
    </>
  );
}

"use client";

/**
 * Numbered pages: 1 2 3 ... 43, with the current page in the middle of a short
 * window. Printing all 43 buttons would wrap over three lines and be harder to
 * use than it looks, so distant pages collapse to a gap and first/last stay
 * reachable in one click.
 */

function pageList(page: number, pageCount: number): Array<number | "gap"> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i);

  const out: Array<number | "gap"> = [0];
  const from = Math.max(1, page - 1);
  const to = Math.min(pageCount - 2, page + 1);

  if (from > 1) out.push("gap");
  for (let i = from; i <= to; i += 1) out.push(i);
  if (to < pageCount - 2) out.push("gap");
  out.push(pageCount - 1);
  return out;
}

export default function Pager({
  page,
  pageCount,
  onChange,
  busy = false,
  label,
}: {
  page: number;
  pageCount: number;
  onChange: (next: number) => void;
  busy?: boolean;
  label?: string;
}) {
  if (pageCount <= 1) return null;

  return (
    <nav className="pager" aria-label={label ?? "Pages"}>
      <button
        type="button"
        className="pagebtn"
        onClick={() => onChange(page - 1)}
        disabled={busy || page === 0}
      >
        Prev
      </button>

      {pageList(page, pageCount).map((entry, index) =>
        entry === "gap" ? (
          <span className="pagegap" key={`gap-${index}`}>
            &hellip;
          </span>
        ) : (
          <button
            type="button"
            key={entry}
            className={`pagebtn ${entry === page ? "on" : ""}`}
            onClick={() => onChange(entry)}
            disabled={busy}
            aria-current={entry === page ? "page" : undefined}
          >
            {entry + 1}
          </button>
        ),
      )}

      <button
        type="button"
        className="pagebtn"
        onClick={() => onChange(page + 1)}
        disabled={busy || page >= pageCount - 1}
      >
        Next
      </button>
    </nav>
  );
}

import type { ReactNode } from "react";

/**
 * The two-tier masthead from y25btech.klef.in: a navy bar under a gold rule
 * carrying the crest, the university name and the outlined action pills, then a
 * thinner gradient strip beneath it for the breadcrumb.
 *
 * Both the dashboard and the admin page use it. They had a copy of the chrome
 * each, which is how the Admin link came to test for the wrong role on one page
 * and not the other.
 */
export default function SiteHeader({
  name,
  eyebrow,
  crumb,
  actions,
  who,
}: {
  name: string;
  eyebrow: string;
  crumb: ReactNode;
  actions: ReactNode;
  who?: string | null;
}) {
  return (
    <div className="masthead">
      <header className="topbar">
        <div className="topinner">
          <div className="klmark">
            <span className="klglyph">KL</span>
            <span className="klwords">
              <span className="klname">{name}</span>
              <span className="klcampuses">{eyebrow}</span>
            </span>
          </div>
          <nav className="kldocs">{actions}</nav>
        </div>
      </header>

      <div className="subbar">
        <div className="subinner">
          {crumb}
          {who && <span className="who">Signed in as {who}</span>}
        </div>
      </div>
    </div>
  );
}

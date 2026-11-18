import { useEffect } from "react";

/**
 * Tell the server what this page is showing, so the agent can know.
 *
 * Only while the tab is visible. Several tabs of this app can be open, and
 * a background one asserting what the person is looking at is exactly how
 * the split view ended up with three tabs taking the pair off each other.
 * A hidden tab says nothing; the visible one is the answer.
 *
 * It also says when it goes away, so "nobody is looking" is reported rather
 * than inferred from silence — though silence is handled too, because a
 * closed laptop sends no goodbye.
 */

/** Often enough that two missed beats are still inside the server's window. */
const BEAT_MS = 20_000;

/**
 * The part of a document someone has hold of.
 *
 * Enough for the agent to act on "this": which section, which stored row,
 * and — for a bullet on a tailored draft — the line as well as the fact, so
 * it edits the draft rather than the person's history. The words are there
 * too, because the id names a row and the person means a sentence.
 */
export interface SelectionReport {
  section: string;
  field?: string;
  role?: number;
  bullet?: number;
  line?: number;
  project?: number;
  education?: number;
  skill?: number;
  prose?: number;
  text?: string;
}

export interface Showing {
  tab: string;
  selected: {
    job?: number | null;
    resume?: number | null;
    coverLetter?: number | null;
    surface?: string | null;
    /** The draft being shown on the Design tab, if it is not the profile. */
    draft?: number | null;
    selection?: SelectionReport | null;
  };
}

function send(body: unknown, leaving = false): void {
  /*
    keepalive, not sendBeacon.

    The first version used sendBeacon for the goodbye and it never arrived:
    a beacon carrying application/json needs a CORS preflight, and a beacon
    cannot make one, so the browser dropped it silently. The server logged
    four reports and no farewell. A keepalive fetch outlives the page in the
    same way and has no such restriction.
  */
  void fetch("/api/app-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: leaving,
  }).catch(() => {
    // The agent loses a little context. Nothing the person is doing fails.
  });
}

export function useReportState(showing: Showing): void {
  useEffect(() => {
    const report = () => {
      if (document.visibilityState !== "visible") return;
      // Re-sent on becoming visible even when nothing changed: that is the
      // signal that this tab, rather than another one, is the live answer.
      send(showing);
    };

    report();

    /*
      A beat while visible, not only on change.

      Without it the server cannot tell "sitting reading the same tab for
      two minutes" from "closed the laptop", because both look like silence
      — and it would have called the first one nobody-looking. The staleness
      rule only means anything if a page that is still there keeps saying so.

      It also makes the goodbye below an optimisation rather than a
      requirement, which matters: a crashed tab, a killed browser and a shut
      laptop all send no goodbye, and in this app's own preview pane the
      pagehide never arrived at all.
    */
    const beat = setInterval(report, BEAT_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") report();
    };
    const onLeave = () => send({ gone: true }, true);

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onLeave);
    return () => {
      clearInterval(beat);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onLeave);
    };
    // The selection is an object, so it is compared by what it says rather
    // than by identity: a render that rebuilt the same selection is not news.
  }, [
    showing.tab,
    showing.selected.job,
    showing.selected.resume,
    showing.selected.coverLetter,
    showing.selected.surface,
    showing.selected.draft,
    JSON.stringify(showing.selected.selection ?? null),
  ]);
}

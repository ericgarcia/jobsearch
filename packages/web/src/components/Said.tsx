import { useLayoutEffect, useRef, useState } from "react";
import { api, type ContextNote } from "../api.ts";

/**
 * What has been said about this row, behind a small mark.
 *
 * The profile shows what is true. This shows why — the figure that is under
 * NDA, the job left off on purpose, the wording a recruiter once asked
 * about. It is the same store the assistant reads before it asks anything,
 * so what is behind this mark is exactly what stops a question coming round
 * again. See the server's notes.ts.
 *
 * A mark and not a panel: context is worth having and not worth reading
 * every time you look at a role, and a row with nothing said about it shows
 * nothing at all. The mark fills in when there is something behind it, so
 * the page says at a glance which parts of a history have been explained
 * and which have only been stated.
 */
export function Said({
  notes,
  target,
  targetId,
  targetKey,
  what,
  onChanged,
}: {
  /** Every note the page has; this picks out its own. */
  notes: ContextNote[];
  target: ContextNote["target"];
  targetId?: number | null;
  targetKey?: string | null;
  /** What this row is, for the heading: "this line", "Spotify". */
  what: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);


  const mine = notes.filter(
    (one) =>
      one.target === target &&
      (targetId == null || one.target_id === targetId) &&
      (targetKey == null || one.target_key === targetKey),
  );

  /*
    Kept inside the pane it belongs to.

    The panel hangs off the mark, and the mark sits wherever its row ends —
    which for a line of a resume is a long way left. Anchored to the mark
    alone, a 340px panel opened on a short line reached two hundred pixels
    past the left edge of the profile and opened underneath the conversation,
    where it could be read but not reached.

    So it is measured once it is up and pushed back inside: the mark keeps
    the panel's right edge where it is unless that would take the left edge
    out of the pane, and then the pane wins. Measured rather than guessed
    because the pane is resizable and the rows are not all the same width.
  */
  useLayoutEffect(() => {
    const node = panel.current;
    if (!open || !node) return;

    const fit = () => {
      node.style.right = "0px";
      const pane = node.closest(".profile")?.getBoundingClientRect();
      if (!pane) return;
      const box = node.getBoundingClientRect();
      const past = pane.left + 8 - box.left;
      /*
        How far it can move before it hangs off the other side — which is
        what it has to be measured against. Capping the shift by the pane's
        width instead left the panel on the About heading 38px outside,
        because a mark that sits near the left edge needs to move further
        than a panel-width of slack allows.
      */
      const room = pane.right - 8 - box.right;
      if (past > 0) node.style.right = `${-Math.max(0, Math.min(past, room))}px`;
    };

    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open, mine.length]);

  async function keep() {
    const said = draft.trim();
    if (!said || busy) return;
    setBusy(true);
    try {
      await api.keepNote({
        target,
        ...(targetId != null ? { target_id: targetId } : {}),
        ...(targetKey != null ? { target_key: targetKey } : {}),
        note: said,
      });
      setDraft("");
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="said">
      <button
        className={mine.length > 0 ? "said-mark said-has" : "said-mark"}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={
          mine.length === 0
            ? `Nothing said about ${what} yet`
            : `${mine.length} thing${mine.length === 1 ? "" : "s"} you have said about ${what}`
        }
      >
        i
      </button>

      {open && (
        <div className="said-panel" ref={panel}>
          <div className="field-label">what you have said about {what}</div>

          {mine.length === 0 && (
            <p className="field-why">
              Nothing yet. Anything you tell the assistant about this — why it is worded that
              way, what cannot be said, why it is here at all — is kept here, and it reads this
              before asking you anything.
            </p>
          )}

          <ul className="said-list">
            {mine.map((one) => (
              <li key={one.id}>
                <p className="said-text">{one.note}</p>
                <div className="said-row">
                  {one.settles && <span className="said-settles">answers: {one.settles}</span>}
                  <span className="said-when">
                    {one.source === "person" ? "you" : "from your conversation"} ·{" "}
                    {one.at.slice(0, 10)}
                  </span>
                  <button
                    className="ghost tiny"
                    disabled={busy}
                    onClick={() => void api.forgetNote(one.id).then(onChanged)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <form
            className="said-add"
            onSubmit={(event) => {
              event.preventDefault();
              void keep();
            }}
          >
            <input
              value={draft}
              placeholder="Add something about this…"
              onChange={(event) => setDraft(event.target.value)}
            />
          </form>
        </div>
      )}
    </span>
  );
}

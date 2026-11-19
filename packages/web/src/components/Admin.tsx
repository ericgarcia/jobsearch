import { useEffect, useState } from "react";
import { api, type Wish, type WishCase } from "../api.ts";

/**
 * What the app would not let the assistant do.
 *
 * A proposal card can be answered three ways — take the text in the box,
 * change nothing, remove the row — and that set is closed on purpose: the
 * server has to carry an answer out, and what a button does must never come
 * from text that was read out of somebody's resume or a job posting.
 *
 * The cost of a closed set is that it is a guess about what the work needs.
 * The assistant is what meets the cases the guess missed, and until this
 * page existed those cases went nowhere: it explained the limit in the
 * thread, the thread scrolled away, and the next conversation hit the same
 * wall with no record that the first one had.
 *
 * So this is the record, and each want carries the cases behind it — the
 * line as it stood, the card that was up, what the assistant would have
 * done, and what should be true once it was done. That last part is an
 * acceptance test written at the only moment anybody knew what it was for,
 * which is what makes a want here something you can build against rather
 * than a note about a feeling.
 *
 * Nothing on this page is live. An answer becomes a button when it is built
 * as one, and that decision belongs to whoever reads this.
 */
export function Admin() {
  const [wished, setWished] = useState<Wish[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void api
      .wishedActions()
      .then((answer) => setWished(answer.wished))
      .catch(() => setFailed(true));
  }, []);

  return (
    <div className="admin-pane">
      <h2>Answers the assistant wanted</h2>
      <p className="field-why">
        A card can take the text in the box, change nothing, or remove the row. These are the
        answers it asked for instead, with how often it has asked and the cases behind them.
        Nothing here is live: an answer becomes a button only when it is built as one.
      </p>

      {failed && <p className="field-why">That list could not be loaded.</p>}
      {wished && wished.length === 0 && (
        <p className="field-why">Nothing yet. The three answers have been enough so far.</p>
      )}

      {wished?.map((wish) => (
        <section className="wish" key={wish.id}>
          <header className="wish-head">
            <span className="wish-name">{wish.name}</span>
            <span className="wish-votes">
              {wish.votes === 1 ? "asked once" : `asked ${wish.votes} times`}
            </span>
            <span className="wish-when">last {wish.last_at.slice(0, 10)}</span>
          </header>
          <p className="wish-why">{wish.why}</p>

          {wish.cases.length === 0 ? (
            <p className="field-why">No case was kept: no card was waiting when it came up.</p>
          ) : (
            <ol className="wish-cases">
              {wish.cases.map((one) => (
                <Case key={one.id} shown={one} />
              ))}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}

/**
 * One case, folded shut.
 *
 * Shut because twelve of these under each want is a wall of somebody's
 * resume, and the thing being scanned on this page is which want to build
 * next, not the text of any one line.
 */
function Case({ shown }: { shown: WishCase }) {
  const [open, setOpen] = useState(false);

  return (
    <li className="wish-case">
      <button className="ghost wish-case-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="wish-case-mark">{open ? "▾" : "▸"}</span>
        <span className="wish-case-shape">
          {shown.shape.action} on {shown.shape.target}
          {shown.shape.field ? ` · ${shown.shape.field}` : ""}
        </span>
        <span className="wish-when">{shown.at.slice(0, 10)}</span>
      </button>

      {open && (
        <div className="wish-case-body">
          <div className="field-label">what it saw</div>
          <p className="wish-saw">{shown.saw}</p>

          <div className="field-label">what it would have done</div>
          <p>{shown.wanted}</p>

          <div className="field-label">what should then be true</div>
          <p>{shown.expect}</p>

          <div className="field-label">the card</div>
          <p className="wish-shape">
            target <b>{shown.shape.target}</b>, field <b>{shown.shape.field || "—"}</b>, action{" "}
            <b>{shown.shape.action}</b>, answers <b>{shown.shape.answers.join(" / ") || "—"}</b>,
            recommended <b>{shown.shape.recommended || "—"}</b>,{" "}
            {shown.shape.had_value ? "something was stored" : "nothing was stored"}
          </p>
        </div>
      )}
    </li>
  );
}

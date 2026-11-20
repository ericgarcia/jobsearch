import { useEffect, useState } from "react";
import { api, type Bug, type BugOccurrence, type Wish, type WishCase } from "../api.ts";
import { useChanges } from "../changes.ts";

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
/**
 * Folders on this computer the assistant may read.
 *
 * Here rather than in a settings page because this is the page that says
 * what the assistant can do. Each one was allowed in answer to a request
 * that said what it was for, and that wording is kept and shown: a grant
 * nobody can remember the reason for is a grant to take back.
 */
function Folders() {
  const [grants, setGrants] = useState<
    { id: number; path: string; why: string | null; at: string }[] | null
  >(null);

  const load = () =>
    void api
      .folders()
      .then((answer) => setGrants(answer.grants))
      .catch(() => setGrants([]));

  useEffect(load, []);
  useChanges("files", load);

  return (
    <>
      <h2>Folders the assistant can read</h2>
      <p className="field-why">
        Nothing on this computer is readable until you allow a folder, and it only ever reads:
        there is no tool here that changes, moves or deletes a file. Hidden files are never
        included, even inside a folder you have allowed. Take one back and it stops being
        readable at once.
      </p>

      {grants && grants.length === 0 && (
        <p className="field-why">None. The assistant has to ask, and you have not said yes yet.</p>
      )}

      {grants?.map((grant) => (
        <div className="grant" key={grant.id}>
          <div className="grant-path">{grant.path}</div>
          {grant.why && <div className="grant-why">{grant.why}</div>}
          <div className="grant-row">
            <span className="grant-when">allowed {grant.at.slice(0, 10)}</span>
            <button className="ghost tiny" onClick={() => void api.revokeFolder(grant.id).then(load)}>
              Take it back
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

export function Admin() {
  const [wished, setWished] = useState<Wish[] | null>(null);
  const [bugs, setBugs] = useState<Bug[] | null>(null);
  const [failed, setFailed] = useState(false);

  const loadBugs = () =>
    void api
      .bugs()
      .then((answer) => setBugs(answer.bugs))
      .catch(() => setBugs([]));

  useEffect(() => {
    void api
      .wishedActions()
      .then((answer) => setWished(answer.wished))
      .catch(() => setFailed(true));
    loadBugs();
  }, []);

  return (
    <div className="admin-pane">
      <Folders />

      <Bugs bugs={bugs} onChanged={loadBugs} />

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
 * What the assistant ran into.
 *
 * It used to work around a fault in silence — the right thing for the person
 * in front of it, and nothing left behind. A thread saying "I put this on
 * your screen twice and both times the box disappeared" is a bug report that
 * scrolls away, and the next conversation meets the same fault with no
 * record that the first one did.
 *
 * The three lines are the assistant's: what it was doing, what it expected,
 * what happened. Everything under an occurrence is the server's, read off at
 * the moment of filing, because that is the part a model would have to guess
 * at and the part a fix needs.
 */
function Bugs({ bugs, onChanged }: { bugs: Bug[] | null; onChanged: () => void }) {
  if (!bugs || bugs.length === 0) return null;

  const open = bugs.filter((one) => !one.fixed_at);
  const fixed = bugs.filter((one) => one.fixed_at);

  return (
    <>
      <h2>Faults the assistant ran into</h2>
      <p className="field-why">
        Filed as it worked, with the state of the app attached as it filed. It is told to carry
        on and work round what it can, so a report here is not a thing that stopped anybody —
        it is a thing that went wrong quietly.
      </p>

      {open.length === 0 && <p className="field-why">Nothing open.</p>}
      {open.map((bug) => (
        <BugRow key={bug.id} bug={bug} onChanged={onChanged} />
      ))}

      {fixed.length > 0 && (
        <details className="bugs-fixed">
          <summary>{fixed.length} marked fixed</summary>
          {fixed.map((bug) => (
            <BugRow key={bug.id} bug={bug} onChanged={onChanged} />
          ))}
        </details>
      )}
    </>
  );
}

function BugRow({ bug, onChanged }: { bug: Bug; onChanged: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <section className={bug.fixed_at ? "wish bug bug-fixed" : "wish bug"}>
      <header className="wish-head">
        <span className="wish-name">{bug.title}</span>
        <span className="wish-votes">
          {bug.hits === 1 ? "once" : `${bug.hits} times`}
        </span>
        <span className="wish-when">last {bug.last_at.slice(0, 10)}</span>
      </header>

      <dl className="bug-said">
        <dt>doing</dt>
        <dd>{bug.doing}</dd>
        <dt>expected</dt>
        <dd>{bug.expected}</dd>
        <dt>happened</dt>
        <dd>{bug.happened}</dd>
      </dl>

      <div className="bug-actions">
        <button className="ghost tiny" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : `${bug.occurrences.length} ${bug.occurrences.length === 1 ? "sighting" : "sightings"}`}
        </button>
        <button
          className="ghost tiny"
          onClick={() => void api.markBugFixed(bug.id, !bug.fixed_at).then(onChanged)}
        >
          {bug.fixed_at ? "Open it again" : "Mark fixed"}
        </button>
      </div>

      {open && (
        <ol className="wish-cases">
          {bug.occurrences.map((one) => (
            <Sighting key={one.id} seen={one} />
          ))}
        </ol>
      )}
    </section>
  );
}

/** One sighting: what the app was doing at the moment it was filed. */
function Sighting({ seen }: { seen: BugOccurrence }) {
  const card = seen.context.card;
  return (
    <li className="wish-case">
      <div className="wish-case-body">
        <div className="field-label">{seen.at.slice(0, 16).replace("T", " ")}</div>
        <p>{seen.said}</p>
        <p className="wish-shape">
          {card ? (
            <>
              a card was up: <b>{card.action}</b> on <b>{card.target}</b>
              {card.target_id != null ? ` #${card.target_id}` : ""}, field <b>{card.field}</b>,
              answers <b>{card.answers.join(" / ")}</b>, recommended <b>{card.recommend}</b>,
              put up at <b>{card.at}</b>
              {card.question_id != null ? <>, for question <b>{card.question_id}</b></> : null}
            </>
          ) : (
            <>no card was waiting</>
          )}
          {" · "}
          conversation <b>{seen.context.conversation ?? "none"}</b>
          {" · "}
          queue <b>{seen.context.queue.settled}</b> settled, <b>{seen.context.queue.left}</b> left
        </p>
      </div>
    </li>
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

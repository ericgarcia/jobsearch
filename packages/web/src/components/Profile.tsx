import { ApplicationAnswers } from "./ApplicationAnswers.tsx";
import { useEffect, useRef, useState } from "react";
import { GrowText } from "./GrowText.tsx";
import { useChanges } from "../changes.ts";
import { Interests } from "./Interests.tsx";
import {
  api,
  type Answer,
  type Bullet,
  type ContextNote,
  type LeftOutGroup,
  type Profile as ProfileData,
  type Role,
} from "../api.ts";
import { say } from "../say.ts";
import { claim, release, useClaimed } from "../claimed.ts";
import { onShowCard } from "../focusCard.ts";
import { Said } from "./Said.tsx";
import { useFieldHistory } from "../undo.ts";

type Pending = NonNullable<Awaited<ReturnType<typeof api.pendingEdit>>["pending"]>;

/** Whether this proposal is about this exact thing. */
export function asksAbout(
  pending: Pending | null,
  target: string,
  of?: { id?: number; key?: string; field?: string },
): Pending | null {
  if (!pending || pending.target !== target) return null;
  if (of?.id !== undefined && pending.target_id !== of.id) return null;
  if (of?.key !== undefined && pending.target_key !== of.key) return null;
  if (of?.field !== undefined && pending.field !== of.field) return null;
  return pending;
}

/**
 * The one question the assistant is asking, painted over the thing it is
 * about.
 *
 * One component for every kind of row, because the question is the same
 * question wherever it lands: here is a value, here is why, keep it, change
 * it, or leave it. The row underneath keeps its place and its size — see the
 * note on .field-card in styles.css — so asking about one thing never moves
 * another.
 *
 * A deletion has no box to type in. There is nothing to edit about removing
 * something, and an input there would suggest otherwise.
 */
export function Proposal({
  asked,
  name,
  onDone,
  claims = true,
  onDraft,
  gone = false,
}: {
  asked: Pending;
  /** What to call this in the sentence that goes back to the assistant. */
  name: string;
  onDone: () => void;
  /**
   * What is in the box, as it is typed.
   *
   * Only the skills card uses it. Its names are also shown as pills among
   * the ones already stored, and pills that went on showing the proposal
   * while the box said something else would be two answers to one question.
   */
  onDraft?: (text: string) => void;
  /**
   * The row this is about is not on the profile any more.
   *
   * Three buttons that all write nothing is not a choice. There is one thing
   * left to do with the question — close it — so that is the one button,
   * and the box goes with the rest: there is nothing to correct.
   */
  gone?: boolean;
  /**
   * Whether this card counts as the question being on the screen.
   *
   * True everywhere except the fallback below, which exists *because*
   * nothing claimed it. A fallback that claimed would answer its own
   * question: claiming hides it, hiding releases the claim, and it shows
   * itself again — which it did, about six hundred times a second.
   */
  claims?: boolean;
}) {
  /*
    An ask carries no suggested value, so the box starts from what is
    stored: the question is "is this right?", and the thing to answer it
    with is the text itself, there to be corrected.
  */
  const seed = asked.action === "ask" ? (asked.current ?? "") : asked.value;
  const [draft, setDraft] = useState(seed);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => onDraft?.(draft), [draft, onDraft]);

  useEffect(() => {
    setDraft(seed);

    /*
      After the page has settled, not during it.

      Scrolling on mount put the question off the bottom of the screen: the
      profile renders "loading" first, and the list is still growing when the
      card appears, so the position it scrolled to was not where the card
      ended up. Two frames is enough for the layout to finish, and a second
      attempt covers a list that was still filling in.
    */
    let cancelled = false;
    const bring = () => {
      if (!cancelled) box.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    const frame = requestAnimationFrame(() => requestAnimationFrame(bring));
    const again = setTimeout(bring, 350);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      clearTimeout(again);
    };
  }, [asked.at, seed]);

  /*
    And again whenever somebody asks where the question went — from the top
    of the thread, while a turn is running and Continue has nothing to do.
    See focusCard.ts.
  */
  useEffect(
    () => onShowCard(() => box.current?.scrollIntoView({ behavior: "smooth", block: "center" })),
    [],
  );

  /* On the screen, so nothing has to show it plainly instead. See claimed.ts. */
  useEffect(() => {
    if (!claims) return;
    claim(asked.at);
    return () => release(asked.at);
  }, [asked.at, claims]);

  const removing = asked.action === "delete" && !gone;
  const asking = asked.action === "ask" && !gone;
  const adding = asked.action === "add" && !gone;

  async function resolve(chosen: Answer) {
    const answer = await api.resolveEdit(chosen, draft);
    onDone();
    if (answer.resolved.gone) {
      /*
        The row went between the question and the answer. Saying "I kept
        that" here would report a change to something that is not there.
      */
      say(`I closed that one — ${name} is not on the profile any more, so nothing changed.`);
    } else if (chosen === "leave") {
      say(`I left that one — leave ${name} as it is.`);
    } else if (answer.resolved.dropped) {
      const gone = answer.resolved.dropped;
      say(
        gone.length > 0
          ? `I took ${gone.length === 1 ? "this skill" : "these skills"} off: ${gone.join(", ")}.`
          : "I kept that, but those skills were not on the list, so nothing changed.",
      );
    } else if (answer.resolved.added) {
      /*
        Skills are added rather than replaced, so saying the list "is now"
        the three names in the box would report the opposite of what
        happened. The names that went in are the ones the server actually
        wrote, which is not always the ones that were offered.
      */
      const added = answer.resolved.added;
      say(
        added.length > 0
          ? `I added ${added.length === 1 ? "this skill" : "these skills"}: ${added.join(", ")}.`
          : "I kept that, but those skills were already on the list, so nothing changed.",
      );
    } else if (answer.resolved.removed) {
      say(`I removed ${name}.`);
    } else {
      say(
        `I kept that${answer.resolved.edited ? ", with an edit" : ""}: ${name} is now “${answer.resolved.value}”.`,
      );
    }
  }

  /*
    What each answer is called, in words that say what the button does.

    The labels used to be read off the action, which is how an ask that said
    "keep it as it is, trim it, or drop it?" came to sit above "That's right"
    and "Skip" — two buttons, neither of which dropped anything, and a
    primary one whose words claimed the text was right at the moment the
    person had just finished editing it. So each label names its effect, and
    the one the assistant recommends is the highlighted one. The app writes
    these, not the assistant: a label is what the person reads to find out
    what a click will do, and a label that came out of an imported document
    could promise one thing and do another.
  */
  /*
    Three words for three things: Update, Keep original, Drop it.

    Each one names what the button does to the profile, which the old labels
    did not. "That's right" and "Skip" sat under a question that offered to
    keep, trim or drop a line, so there were three choices and two buttons,
    and neither of them dropped anything; the first draft of the replacement
    went the other way and produced "It is right as it is" beside "Leave it
    as it is", two phrasings of one choice. These three are told apart by
    what they touch, not by shade of meaning: the text in the box, the text
    already stored, or the row itself.

    An offered line and a proposed removal keep their own words, because
    there is no "original" in the first case and nothing to update in the
    second.
  */
  const skills = asked.target === "skills";
  /*
    A question about skills already on the list. There is nothing to type:
    the card is about which names are there, and the answer is whether they
    stay. A box here would invite an edit that no button could carry out.
  */
  const skillsAsked = skills && asked.action === "ask";
  /* A phrase to point at, and the stored text to point at it in. */
  const marked = Boolean(asked.quote && asked.current);
  /*
    More than one field of the row in question. Shown as a short list of
    what is stored, with the one the box writes marked, so a question about
    two dates is not asked beside a box containing a job title.
  */
  const several = !removing && asked.fields.length > 1;

  function label(answer: Answer): string {
    if (skillsAsked) {
      const many = asked.value.includes(",");
      return answer === "drop" ? (many ? "Drop them" : "Drop it") : many ? "Keep them" : "Keep it";
    }
    if (answer === "drop") return "Drop it";
    if (answer === "leave") return adding ? "Leave it out" : "Keep original";
    if (removing) return "Drop it";
    if (skills) return "Add them";
    if (adding) return "Add it";
    return "Update";
  }

  /*
    What this would replace, when it would replace something.

    Shown under the box rather than beside it, in the same type and the same
    metrics, because the question being asked is "is this better than that?"
    and two differently styled blocks cannot be read that way. Left out when
    there is nothing to compare: a field that was empty, or a proposal that
    is the stored text offered back for correction.
  */
  const original =
    !removing && !asking && asked.current && asked.current !== asked.value
      ? asked.current
      : null;

  if (skillsAsked) {
    return (
      <div className="field-card" ref={box}>
        <span className="field-name">{name}</span>
        <div className="field-why">{asked.why}</div>
        <div className="field-label">marked in your skills above</div>
        <div className="field-answer">
          {asked.answers.map((answer) => (
            <button
              key={answer}
              className={answer === asked.recommend ? "primary" : undefined}
              onClick={() => void resolve(answer)}
            >
              {label(answer)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (gone) {
    return (
      <div className="field-card" ref={box}>
        <span className="field-name">{name}</span>
        <div className="field-why">{asked.why}</div>
        <div className="field-answer">
          <button className="primary" onClick={() => void resolve("leave")}>
            Close it
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="field-card" ref={box}>
      <span className="field-name">{removing ? `remove ${name}` : name}</span>
      <div className="field-why">{asked.why}</div>
      {removing ? (
        <div className="field-removing">{asked.current ?? asked.value}</div>
      ) : (
        <>
          {several && (
            <>
              <div className="field-label">what this is about</div>
              <dl className="field-fields">
                {asked.fields.map((one) => (
                  <div key={one.field} className={one.edits ? "field-pair field-pair-edits" : "field-pair"}>
                    <dt>{one.field.replace(/_/g, " ")}</dt>
                    <dd>{one.value || <span className="field-empty">empty</span>}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {marked && (
            <>
              <div className="field-label">the part in question</div>
              <div className="field-quoted">
                <Quoted text={asked.current ?? ""} quote={asked.quote!} />
              </div>
            </>
          )}
          {original && <div className="field-label">suggested — edit it here</div>}
          {asking && (
            <div className="field-label">
              {several
                ? `the ${asked.field.replace(/_/g, " ")} — correct it here`
                : marked
                  ? "all of it — correct it here"
                  : "on your profile — correct it here"}
            </div>
          )}
          {adding && !skills && <div className="field-label">not on your profile — add it?</div>}
          {skills && (
            <div className="field-label">not in your skills — add them? one per comma</div>
          )}
          <GrowText
            autoFocus
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {original && (
            <>
              <div className="field-label">now on your profile</div>
              <div className="field-now">{original}</div>
            </>
          )}
        </>
      )}
      <div className="field-answer">
        {/*
          The highlighted button is the one the assistant recommends, which is
          not always the one that acts.

          An offered line is the case that shows it. The import read that
          paragraph, judged it a pitch for the consultancy rather than work
          this person did, and left it out; it is only on the screen so they
          can overrule that. Highlighting "Add it" there argues the opposite
          of what the card says, and pushes somebody towards the answer the
          app thinks is wrong. The recommendation used to be guessed from the
          action for exactly that reason — one hard-coded exception — and now
          it comes with the proposal, so a card can recommend dropping a line
          as easily as keeping it.
        */}
        {asked.answers.map((answer) => (
          <button
            key={answer}
            className={answer === asked.recommend ? "primary" : undefined}
            onClick={() => void resolve(answer)}
          >
            {label(answer)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The stored text with the phrase in question marked.
 *
 * The card used to show a field whole — right for a line of a resume, wrong
 * for a four-paragraph summary, where the question is about four words of it
 * and the person is handed the lot to search. The quote is checked against
 * the stored text when the card is made, so it is there exactly once and
 * this split always comes back in three parts.
 */
function Quoted({ text, quote }: { text: string; quote: string }) {
  const at = text.indexOf(quote);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="field-mark">{quote}</mark>
      {text.slice(at + quote.length)}
    </>
  );
}

/*
  The names in a skills proposal.

  The same split as the server's, which is where the authority is: this one
  only decides which pills to draw, and the server decides what is written.
  Two short parsers rather than a shared package, since the two packages
  share nothing else yet.
*/
function namesIn(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[,\n]/)) {
    const name = part.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** One editable fact. The text is the claim a resume may later restate. */
function BulletRow({
  bullet,
  pending,
  notes,
  onChanged,
}: {
  bullet: Bullet;
  pending: Pending | null;
  notes: ContextNote[];
  onChanged: () => void;
}) {
  const [text, setText] = useState(bullet.text);
  const [editing, setEditing] = useState(false);
  /*
    Not an add. For an add, target_id names the role the line would join
    rather than a bullet, so a bullet whose id happens to equal that role's
    claims the card and shows it under the wrong job — which is what it did.
  */
  const match = asksAbout(pending, "bullet", { id: bullet.id });
  const asked = match?.action === "add" ? null : match;

  useEffect(() => setText(bullet.text), [bullet.text]);

  if (asked) {
    return (
      <li className="bullet field-asked">
        <span aria-hidden>{bullet.text}</span>
        <Proposal asked={asked} name="this line" onDone={onChanged} />
      </li>
    );
  }

  if (!editing) {
    return (
      <li className="bullet">
        <span onClick={() => setEditing(true)}>{bullet.text}</span>
        <Said
          notes={notes}
          target="bullet"
          targetId={bullet.id}
          what="this line"
          onChanged={onChanged}
        />
        <button
          className="ghost tiny"
          title="Remove this fact"
          onClick={() => void api.deleteBullet(bullet.id).then(onChanged)}
        >
          ×
        </button>
      </li>
    );
  }

  return (
    <li className="bullet editing">
      <GrowText
        value={text}
        autoFocus
        rows={2}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setText(bullet.text);
            setEditing(false);
          }
        }}
      />
      <div className="bullet-actions">
        <button
          className="primary tiny"
          onClick={() => {
            void api.patchBullet(bullet.id, text).then(() => {
              setEditing(false);
              onChanged();
            });
          }}
        >
          Save
        </button>
        <button
          className="ghost tiny"
          onClick={() => {
            setText(bullet.text);
            setEditing(false);
          }}
        >
          Cancel
        </button>
      </div>
    </li>
  );
}

/**
 * The lines an import held back from this role.
 *
 * Folded shut, because they are held back for a reason and the reason is
 * usually right: the nine that prompted this were a consultancy's services
 * menu, its commercial terms and its call to action, read off the same
 * document as somebody's actual work. Shut, the role says there are nine and
 * gets on with it; open, each line is there with why it was held and a
 * button to put it on the profile after all.
 *
 * "Leave them all out" settles the lot. It is the same answer the import
 * already gave and the same answer nine separate cards would have collected
 * one at a time, which is the thing this exists to avoid.
 */
function HeldBack({ group, onChanged }: { group: LeftOutGroup; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = (work: Promise<unknown>) => {
    setBusy(true);
    void work.then(onChanged).finally(() => setBusy(false));
  };

  const count = group.lines.length;

  return (
    <div className="held">
      <button className="ghost held-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="held-mark">{open ? "▾" : "▸"}</span>
        {count === 1 ? "1 line was held back from this role" : `${count} lines were held back from this role`}
      </button>

      {open && (
        <>
          <p className="field-why">
            The import read these on the same document and judged them not to be your work.
            Put any of them on the profile, or leave them out.
          </p>
          <ul className="held-lines">
            {group.lines.map((line) => (
              <li key={line.id}>
                <p className="held-text">{line.text}</p>
                <div className="held-row">
                  {line.why && <span className="held-why">{line.why}</span>}
                  <button
                    className="ghost tiny"
                    disabled={busy}
                    onClick={() => act(api.addLeftOut(line.id))}
                  >
                    Add it
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button
            className="ghost tiny"
            disabled={busy}
            onClick={() => act(api.leaveLeftOut(group.lines.map((one) => one.id)))}
          >
            {count === 1 ? "Leave it out" : "Leave them all out"}
          </button>
        </>
      )}
    </div>
  );
}

function RoleCard({
  role,
  pending,
  heldBack,
  notes,
  onChanged,
}: {
  role: Role;
  pending: Pending | null;
  /** Everything said about anything; the marks pick out their own. */
  notes: ContextNote[];
  /** Lines the import kept back from this role, when there are any. */
  heldBack: LeftOutGroup | undefined;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState("");
  const asked = asksAbout(pending, "role", { id: role.id });
  /* An added line names the role it would join, not a bullet of its own. */
  const offered = asksAbout(pending, "bullet", { id: role.id });
  const adding = offered?.action === "add" ? offered : null;

  const dates = [role.start_date, role.end_date ?? "present"].filter(Boolean).join(" – ");

  return (
    <section className={asked ? "role field-asked" : "role"}>
      {asked && (
        <Proposal
          asked={asked}
          /*
            Named for every field in question, not only the one the box
            writes: a card about a role's two dates used to be headed "the
            title of CTO at NuMundo", because the title was the only field
            it could be put on.
          */
          name={
            asked.action === "delete"
              ? `${role.title} at ${role.company}`
              : `the ${(asked.fields.length > 1 ? asked.fields.map((one) => one.field) : [asked.field])
                  .map((one) => one.replace(/_/g, " "))
                  .join(" and ")} of ${role.title} at ${role.company}`
          }
          onDone={onChanged}
        />
      )}
      <header>
        <div>
          <b>{role.title}</b>
          <div className="row-sub">
            {role.company}
            {dates ? ` · ${dates}` : ""}
            {role.location ? ` · ${role.location}` : ""}
          </div>
        </div>
        <Said
          notes={notes}
          target="role"
          targetId={role.id}
          what={role.company}
          onChanged={onChanged}
        />
        <button
          className="ghost tiny"
          title="Remove this role and its facts"
          onClick={() => {
            if (confirm(`Remove ${role.title} at ${role.company} and all its facts?`)) {
              void api.deleteRole(role.id).then(onChanged);
            }
          }}
        >
          ×
        </button>
      </header>

      <ul>
        {role.bullets.map((bullet) => (
          <BulletRow
            key={bullet.id}
            bullet={bullet}
            pending={pending}
            notes={notes}
            onChanged={onChanged}
          />
        ))}
        {adding && (
          /*
            A line being offered rather than one that is there. It sits where
            it would go, at the end of this role's list, so the question is
            asked in the place the answer lands — the same rule as every
            other card, applied to something that does not exist yet.
          */
          <li className="bullet bullet-adding field-asked">
            <Proposal
              asked={adding}
              name={`a line under ${role.title} at ${role.company}`}
              onDone={onChanged}
            />
          </li>
        )}
      </ul>

      {heldBack && heldBack.lines.length > 0 && (
        <HeldBack group={heldBack} onChanged={onChanged} />
      )}

      <form
        className="add-bullet"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          void api.addBullet(role.id, draft.trim()).then(() => {
            setDraft("");
            onChanged();
          });
        }}
      >
        <input
          value={draft}
          placeholder="Add an achievement, with the real figures…"
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>
    </section>
  );
}

/**
 * How to get a profile without typing one.
 *
 * Shown only on an empty profile, because that is the one moment it helps and
 * every other moment it is clutter. The steps come from the server rather than
 * being written here: the assistant gives the same instructions, and two
 * copies of a set of steps is one copy that goes stale.
 *
 * It says why the exporting is theirs to do. "Export your data and give me the
 * zip" reads as the app being lazy unless the reason is next to it, and the
 * reason is good: reading their LinkedIn page for them is against LinkedIn's
 * terms, and the account that gets restricted would be theirs.
 */
interface Route {
  name: string;
  best_for: string;
  steps: string[];
  caveats: string[];
  ready: boolean;
}

function StartFromLinkedIn() {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void api.importHelp().then((help) => setRoutes(help.routes));
  }, []);

  const best = routes[0];

  return (
    <div className="hint">
      <b>Your profile is empty.</b> The quickest way to fill it is to let the assistant read what
      you already have — say “here is my resume” and paste it, or hand over a LinkedIn export.
      {best && (
        <>
          {" "}
          <button className="standing-aside" onClick={() => setOpen(!open)}>
            {open ? "hide the LinkedIn steps" : "how do I export from LinkedIn?"}
          </button>
          {open && (
            <div className="import-routes">
              {routes.map((route) => (
                <div key={route.name}>
                  <div className="import-route-name">
                    {route.name}
                    {!route.ready && <span className="import-route-soon"> — not readable yet</span>}
                  </div>
                  <div className="import-route-best">{route.best_for}</div>
                  <ol>
                    {route.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  {route.caveats.length > 0 && (
                    <ul className="import-route-caveats">
                      {route.caveats.map((caveat) => (
                        <li key={caveat}>{caveat}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              <div className="import-route-why">
                This app does not read your LinkedIn page itself. LinkedIn forbids automated
                access, and the account that gets restricted for it would be yours.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One profile field, with whatever is being proposed for it.
 *
 * The input stays exactly where it was; the question is painted over it.
 */
function AboutField({
  field,
  stored,
  pending,
  onSaved,
  long,
}: {
  field: string;
  stored: string;
  pending: Pending | null;
  onSaved: () => void;
  /** Prose rather than a line: a box that grows, across the whole width. */
  long?: boolean;
}) {
  const asked = asksAbout(pending, "profile", { field });
  const history = useFieldHistory();
  const common = {
    key: stored,
    defaultValue: stored,
    ...history,
    ...(asked ? { tabIndex: -1, "aria-hidden": true } : {}),
    onBlur: (event: { target: { value: string } }) => {
      if (!asked && event.target.value !== stored) {
        void api.patchProfile({ [field]: event.target.value }).then(onSaved);
      }
    },
  };

  return (
    <label className={`${asked ? "field-asked" : ""} ${long ? "field-long" : ""}`.trim() || undefined}>
      <span>{field}</span>
      {long ? (
        <GrowText {...common} rows={3} placeholder="A few lines about your work…" />
      ) : (
        <input {...common} placeholder={field === "headline" ? "Staff Backend Engineer" : ""} />
      )}
      {asked && <Proposal asked={asked} name={field} onDone={onSaved} />}
    </label>
  );
}

/**
 * A waiting question that nothing on the page claimed.
 *
 * Normally this renders nothing: a question is asked on the thing it is
 * about, and the card there says so. This is for when it is about something
 * the page does not show — a fact with no row, a bullet under a role that
 * has gone, a target added to the server and not yet to this pane. Before
 * this, that was silence: the assistant asked, the person looked, and there
 * was nothing to find.
 *
 * It waits a moment before deciding. The cards claim their question in an
 * effect, and on a first paint this component can run before the one that
 * is about to claim it, so deciding immediately would show a stray card on
 * every load.
 */
/*
  What to call a question whose row this page does not show.

  It used to be called "this", which is the one word that says nothing: the
  card sits at the top of the pane with no row under it, so the heading is
  all there is to say what is being asked about. Named from the proposal
  instead — what kind of thing it is, and whether it is still stored, which
  `current` answers for every target that has a stored value.
*/
function strandedName(pending: Pending): string {
  const gone = pending.current === null && pending.action !== "add";
  const kind =
    pending.target === "bullet"
      ? "a line"
      : pending.target === "role"
        ? "a job"
        : pending.target === "education"
          ? "a degree"
          : pending.target === "fact"
            ? "an answer you have stored"
            : pending.target === "skills"
              ? "your skills list"
              : `your ${pending.field}`;

  if (pending.target === "skills") return kind;
  if (pending.action === "add") return `${kind} that is not on your profile yet`;
  return gone ? `${kind} that is no longer on your profile` : `${kind} this page does not show`;
}

function Stranded({ pending, onDone }: { pending: Pending | null; onDone: () => void }) {
  const claimed = useClaimed(pending?.at ?? null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setSettled(false);
    if (!pending) return;
    const wait = setTimeout(() => setSettled(true), 400);
    return () => clearTimeout(wait);
  }, [pending?.at]);

  if (!pending || claimed || !settled) return null;

  return (
    <div className="stranded">
      <div className="stranded-note">
        {pending.current === null && pending.action !== "add"
          ? "This question is about something that is no longer on your profile. Answering it closes the question; nothing will be written."
          : "This question is about something that is not on this page."}
      </div>
      <div className="stranded-card">
        <Proposal
          asked={pending}
          name={strandedName(pending)}
          onDone={onDone}
          claims={false}
          gone={pending.current === null && pending.action !== "add"}
        />
      </div>
    </div>
  );
}

/**
 * One stored degree, with its parts editable.
 *
 * Education was imported and then shown nowhere, which made it the second
 * kind of thing the app held and the person could not see. It also meant a
 * question about a degree had nothing on the page to be asked over — the
 * assistant put "your summary says signal processing and your education
 * says electrical engineering" into the conversation and the profile
 * highlighted nothing, because there was nothing to highlight.
 */
function EducationRow({
  item,
  pending,
  onChanged,
}: {
  item: { id: number; school: string; degree: string | null; field: string | null; start_date: string | null; end_date: string | null };
  pending: Pending | null;
  onChanged: () => void;
}) {
  const parts = ["degree", "field", "school", "start_date", "end_date"] as const;
  const history = useFieldHistory();

  return (
    <div className="education-row">
      {parts.map((part) => {
        const asked = asksAbout(pending, "education", { id: item.id, field: part });
        const stored = item[part] ?? "";
        return (
          <label key={part} className={asked ? "field-asked education-part" : "education-part"}>
            <span>{part === "start_date" ? "from" : part === "end_date" ? "to" : part}</span>
            <input
              key={stored}
              defaultValue={stored}
              {...history}
              {...(asked ? { tabIndex: -1, "aria-hidden": true } : {})}
              onBlur={(event) => {
                if (!asked && event.target.value !== stored) {
                  void api.patchEducation(item.id, { [part]: event.target.value }).then(onChanged);
                }
              }}
            />
            {asked && (
              <Proposal asked={asked} name={`the ${part} of this degree`} onDone={onChanged} />
            )}
          </label>
        );
      })}
    </div>
  );
}

export function Profile() {
  const [data, setData] = useState<ProfileData | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [adding, setAdding] = useState(false);
  const [role, setRole] = useState({ company: "", title: "", start_date: "", end_date: "" });
  const [skill, setSkill] = useState("");
  /*
    What the skills card has in its box right now, so the offered pills can
    show the same names the Add button would write.
  */
  const [skillDraft, setSkillDraft] = useState("");
  /* Lines an import kept back, which belong to the role they came from. */
  const [heldBack, setHeldBack] = useState<LeftOutGroup[]>([]);
  /* What they have said about parts of this, shown on the rows. See Said.tsx. */
  const [notes, setNotes] = useState<ContextNote[]>([]);

  const load = () => void api.profile().then(setData);
  const loadPending = () => void api.pendingEdit().then((answer) => setPending(answer.pending));
  const loadNotes = () =>
    void api
      .notes()
      .then((answer) => setNotes(answer.notes))
      .catch(() => setNotes([]));
  const loadHeldBack = () =>
    void api
      .leftOutLines()
      .then((answer) => setHeldBack(answer.groups))
      .catch(() => setHeldBack([]));
  useEffect(load, []);
  useEffect(loadPending, []);
  useEffect(loadHeldBack, []);
  useEffect(loadNotes, []);
  // The agent edits the profile through the same functions this page calls,
  // so a change it makes shows up here without anyone reloading.
  useChanges("profile", load);
  // Answering one of the held-back lines settles its question, so the count
  // on the role has to move with it.
  useChanges("profile", loadHeldBack);
  useChanges("profile", loadNotes);
  // And what it is asking about arrives the same way.
  useChanges("focus", loadPending);

  if (!data) return <div className="empty">Loading profile…</div>;

  const saved = () => {
    load();
    loadPending();
    loadHeldBack();
    loadNotes();
  };

  /*
    The skills question, and the names it is offering.

    The box is the authority once the card is up, so the pills read from the
    draft and fall back to what was proposed for the frame before the card
    has reported it. Names already on the list are left out: a pill shown
    twice, once filled and once outlined, would offer to add something that
    is already there.
  */
  const offeredSkills = asksAbout(pending, "skills");
  const have = new Set(data.skills.map((one) => one.name.toLowerCase()));
  /*
    A skills card is one of two questions. "add" offers names that are not
    on the list, drawn as outlined pills at the end of it. "ask" is about
    names that are on it — no line of theirs shows these, do they stay? —
    and those are the pills already drawn, marked where they sit.
  */
  const askingSkills = offeredSkills?.action === "ask" ? offeredSkills : null;
  const offering =
    !offeredSkills || askingSkills
      ? []
      : namesIn(skillDraft || offeredSkills.value).filter((name) => !have.has(name.toLowerCase()));
  const inQuestion = new Set(
    askingSkills ? namesIn(askingSkills.value).map((one) => one.toLowerCase()) : [],
  );

  return (
    <div className="profile">
      <Stranded pending={pending} onDone={saved} />
      <Interests />

      <h3>
        About you
        <Said
          notes={notes}
          target="profile"
          what="your profile as a whole"
          onChanged={saved}
        />
      </h3>
      <div className="field-grid">
        {(["name", "headline", "email", "phone", "location"] as const).map((field) => (
          <AboutField
            key={field}
            field={field}
            stored={data.profile[field] ?? ""}
            pending={pending}
            onSaved={saved}
          />
        ))}
        {/*
          The summary, which was stored and shown nowhere. It is the longest
          thing on a profile and the first thing a resume restates, and a
          question about it had no row to be asked over — it was the first
          thing the stranded card ever caught for real.
        */}
        <AboutField
          field="summary"
          stored={data.profile.summary ?? ""}
          pending={pending}
          onSaved={saved}
          long
        />
      </div>

      {data.empty && <StartFromLinkedIn />}

      <h3>
        Experience
        <button className="ghost tiny" onClick={() => setAdding((on) => !on)}>
          {adding ? "Cancel" : "+ Role"}
        </button>
      </h3>

      {adding && (
        <form
          className="new-role"
          onSubmit={(event) => {
            event.preventDefault();
            if (!role.company.trim() || !role.title.trim()) return;
            void api.addRole({ ...role, sort_order: data.roles.length }).then(() => {
              setRole({ company: "", title: "", start_date: "", end_date: "" });
              setAdding(false);
              load();
            });
          }}
        >
          <input
            placeholder="Title"
            value={role.title}
            onChange={(event) => setRole({ ...role, title: event.target.value })}
          />
          <input
            placeholder="Company"
            value={role.company}
            onChange={(event) => setRole({ ...role, company: event.target.value })}
          />
          <input
            placeholder="From (2021-01)"
            value={role.start_date}
            onChange={(event) => setRole({ ...role, start_date: event.target.value })}
          />
          <input
            placeholder="To (blank = current)"
            value={role.end_date}
            onChange={(event) => setRole({ ...role, end_date: event.target.value })}
          />
          <button className="primary" type="submit">
            Add role
          </button>
        </form>
      )}

      {data.roles.map((item) => (
        <RoleCard
          key={item.id}
          role={item}
          pending={pending}
          heldBack={heldBack.find((group) => group.role_id === item.id)}
          notes={notes}
          onChanged={saved}
        />
      ))}

      <h3>Education</h3>
      {data.education.length === 0 ? (
        <p className="editor-note">Nothing stored yet.</p>
      ) : (
        data.education.map((item) => (
          <EducationRow key={item.id} item={item} pending={pending} onChanged={saved} />
        ))
      )}

      <ApplicationAnswers />

      {/*
        The skills list, with what is being offered shown in it.

        Every other question lands on the row it is about. This one had
        nowhere to land: the list is a section, not a row, so an assistant
        that noticed three tools in somebody's lines and not in their skills
        could only name them in the conversation, and the page highlighted
        nothing. The offered names now sit among the pills, outlined rather
        than filled, so the question is read where the answer goes — and
        they follow the box as it is edited, since pills and box disagreeing
        would be two answers to one question.
      */}
      <h3>Skills</h3>
      <div className={offeredSkills ? "skills skills-asked" : "skills"}>
        {data.skills.map((item) => (
          <span
            className={inQuestion.has(item.name.toLowerCase()) ? "pill pill-asked" : "pill"}
            key={item.id}
          >
            {item.name}
            <button className="ghost tiny" onClick={() => void api.deleteSkill(item.id).then(load)}>
              ×
            </button>
          </span>
        ))}
        {offering.map((name) => (
          <span className="pill pill-offered" key={name} title="Offered, not yet added">
            {name}
          </span>
        ))}
      </div>
      {offeredSkills && (
        <div className="skills-card">
          <Proposal
            asked={offeredSkills}
            name="your skills list"
            onDone={saved}
            onDraft={setSkillDraft}
          />
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!skill.trim()) return;
          void api.addSkill(skill.trim()).then(() => {
            setSkill("");
            load();
          });
        }}
      >
        <input
          value={skill}
          placeholder="Add a skill…"
          onChange={(event) => setSkill(event.target.value)}
        />
      </form>
    </div>
  );
}

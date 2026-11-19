import { ApplicationAnswers } from "./ApplicationAnswers.tsx";
import { useEffect, useRef, useState } from "react";
import { GrowText } from "./GrowText.tsx";
import { useChanges } from "../changes.ts";
import { Interests } from "./Interests.tsx";
import {
  api,
  type Answer,
  type Bullet,
  type LeftOutGroup,
  type Profile as ProfileData,
  type Role,
} from "../api.ts";
import { say } from "../say.ts";
import { claim, release, useClaimed } from "../claimed.ts";
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
}: {
  asked: Pending;
  /** What to call this in the sentence that goes back to the assistant. */
  name: string;
  onDone: () => void;
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

  /* On the screen, so nothing has to show it plainly instead. See claimed.ts. */
  useEffect(() => {
    if (!claims) return;
    claim(asked.at);
    return () => release(asked.at);
  }, [asked.at, claims]);

  const removing = asked.action === "delete";
  const asking = asked.action === "ask";
  const adding = asked.action === "add";

  async function resolve(chosen: Answer) {
    const answer = await api.resolveEdit(chosen, draft);
    onDone();
    if (chosen === "leave") {
      say(`I left that one — leave ${name} as it is.`);
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
  function label(answer: Answer): string {
    if (answer === "drop") return "Drop it";
    if (answer === "leave") return adding ? "Leave it out" : "Keep original";
    if (removing) return "Drop it";
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

  return (
    <div className="field-card" ref={box}>
      <span className="field-name">{removing ? `remove ${name}` : name}</span>
      <div className="field-why">{asked.why}</div>
      {removing ? (
        <div className="field-removing">{asked.current ?? asked.value}</div>
      ) : (
        <>
          {original && <div className="field-label">suggested — edit it here</div>}
          {asking && <div className="field-label">on your profile — correct it here</div>}
          {adding && <div className="field-label">not on your profile — add it?</div>}
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

/** One editable fact. The text is the claim a resume may later restate. */
function BulletRow({
  bullet,
  pending,
  onChanged,
}: {
  bullet: Bullet;
  pending: Pending | null;
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
  onChanged,
}: {
  role: Role;
  pending: Pending | null;
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
          name={asked.action === "delete" ? `${role.title} at ${role.company}` : `the ${asked.field.replace(/_/g, " ")} of ${role.title} at ${role.company}`}
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
          <BulletRow key={bullet.id} bullet={bullet} pending={pending} onChanged={onChanged} />
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
        This question is about something that is not on this page.
      </div>
      <div className="stranded-card">
        <Proposal asked={pending} name="this" onDone={onDone} claims={false} />
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
  /* Lines an import kept back, which belong to the role they came from. */
  const [heldBack, setHeldBack] = useState<LeftOutGroup[]>([]);

  const load = () => void api.profile().then(setData);
  const loadPending = () => void api.pendingEdit().then((answer) => setPending(answer.pending));
  const loadHeldBack = () =>
    void api
      .leftOutLines()
      .then((answer) => setHeldBack(answer.groups))
      .catch(() => setHeldBack([]));
  useEffect(load, []);
  useEffect(loadPending, []);
  useEffect(loadHeldBack, []);
  // The agent edits the profile through the same functions this page calls,
  // so a change it makes shows up here without anyone reloading.
  useChanges("profile", load);
  // Answering one of the held-back lines settles its question, so the count
  // on the role has to move with it.
  useChanges("profile", loadHeldBack);
  // And what it is asking about arrives the same way.
  useChanges("focus", loadPending);

  if (!data) return <div className="empty">Loading profile…</div>;

  const saved = () => {
    load();
    loadPending();
    loadHeldBack();
  };

  return (
    <div className="profile">
      <Stranded pending={pending} onDone={saved} />
      <Interests />

      <h3>About you</h3>
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

      <h3>Skills</h3>
      <div className="skills">
        {data.skills.map((item) => (
          <span className="pill" key={item.id}>
            {item.name}
            <button className="ghost tiny" onClick={() => void api.deleteSkill(item.id).then(load)}>
              ×
            </button>
          </span>
        ))}
      </div>
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

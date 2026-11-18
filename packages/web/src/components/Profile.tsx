import { ApplicationAnswers } from "./ApplicationAnswers.tsx";
import { useEffect, useRef, useState } from "react";
import { useChanges } from "../changes.ts";
import { Interests } from "./Interests.tsx";
import { api, type Bullet, type Profile as ProfileData, type Role } from "../api.ts";
import { say } from "../say.ts";

/** One editable fact. The text is the claim a resume may later restate. */
function BulletRow({ bullet, onChanged }: { bullet: Bullet; onChanged: () => void }) {
  const [text, setText] = useState(bullet.text);
  const [editing, setEditing] = useState(false);

  useEffect(() => setText(bullet.text), [bullet.text]);

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
      <textarea
        value={text}
        autoFocus
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

function RoleCard({ role, onChanged }: { role: Role; onChanged: () => void }) {
  const [draft, setDraft] = useState("");

  const dates = [role.start_date, role.end_date ?? "present"].filter(Boolean).join(" – ");

  return (
    <section className="role">
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
          <BulletRow key={bullet.id} bullet={bullet} onChanged={onChanged} />
        ))}
      </ul>

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

type Pending = NonNullable<Awaited<ReturnType<typeof api.pendingEdit>>["pending"]>;

/**
 * One field, with whatever the assistant is proposing for it.
 *
 * The proposal lives in the box, not beside it, so that editing it is just
 * typing — there is no second input, no "accept then correct", and what gets
 * stored is whatever is there when they click. Skipping writes nothing.
 *
 * It takes the field's own text while a proposal is open and hands it back
 * afterwards, which is why the key changes: a React input remembers what was
 * typed into it, and the stored value arriving later has to win.
 */
function AboutField({
  field,
  stored,
  pending,
  onSaved,
}: {
  field: string;
  stored: string;
  pending: Pending | null;
  onSaved: () => void;
}) {
  const asked = pending?.target === "profile" && pending.field === field ? pending : null;
  const [draft, setDraft] = useState(asked?.value ?? "");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft(asked?.value ?? "");
    /*
      Straight to it. The person asked for the page to come to them rather
      than being told which field to go and find — see the note on the
      highlight in styles.css.
    */
    if (asked) box.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [asked?.at, asked?.value, asked?.field]);

  async function resolve(keep: boolean) {
    const answer = await api.resolveEdit(keep, draft);
    onSaved();
    say(
      keep
        ? `I kept that${answer.resolved.edited ? ", with an edit" : ""}: ${field} is now “${answer.resolved.value}”.`
        : `I skipped that one — leave ${field} as it is.`,
    );
  }

  return (
    <label ref={box as never} className={asked ? "field-asked" : undefined}>
      <span>{field}</span>
      {/*
        The field as it always is, left in place to hold the space. While a
        proposal is open it is covered rather than replaced, so the page is
        laid out exactly as it was and nothing below moves.
      */}
      <input
        key={stored}
        defaultValue={stored}
        placeholder={field === "headline" ? "Staff Backend Engineer" : ""}
        {...(asked ? { tabIndex: -1, "aria-hidden": true } : {})}
        onBlur={(event) => {
          if (!asked && event.target.value !== stored) {
            void api.patchProfile({ [field]: event.target.value }).then(onSaved);
          }
        }}
      />

      {/*
        And the question, as one card over the top of it: the name, the box to
        type in, why it is being asked, and the two answers. One border around
        the whole of it, because it is one thing being asked — an outline on
        the input alone reads as a validation error rather than a question.
      */}
      {asked && (
        <div className="field-card">
          <span>{field}</span>
          <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="field-why">{asked.why}</div>
          {asked.current && asked.current !== asked.value && (
            <div className="field-was">now: {asked.current}</div>
          )}
          <div className="field-answer">
            <button className="primary" onClick={() => void resolve(true)}>
              Keep
            </button>
            <button onClick={() => void resolve(false)}>Skip</button>
          </div>
        </div>
      )}
    </label>
  );
}

export function Profile() {
  const [data, setData] = useState<ProfileData | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [adding, setAdding] = useState(false);
  const [role, setRole] = useState({ company: "", title: "", start_date: "", end_date: "" });
  const [skill, setSkill] = useState("");

  const load = () => void api.profile().then(setData);
  const loadPending = () => void api.pendingEdit().then((answer) => setPending(answer.pending));
  useEffect(load, []);
  useEffect(loadPending, []);
  // The agent edits the profile through the same functions this page calls,
  // so a change it makes shows up here without anyone reloading.
  useChanges("profile", load);
  // And what it is asking about arrives the same way.
  useChanges("focus", loadPending);

  if (!data) return <div className="empty">Loading profile…</div>;

  const saved = () => {
    load();
    loadPending();
  };

  return (
    <div className="profile">
      <Interests />

      <h3>About you</h3>
      <div className="field-grid">
        {(["name", "headline", "email", "location"] as const).map((field) => (
          <AboutField
            key={field}
            field={field}
            stored={data.profile[field] ?? ""}
            pending={pending}
            onSaved={saved}
          />
        ))}
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
        <RoleCard key={item.id} role={item} onChanged={load} />
      ))}

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

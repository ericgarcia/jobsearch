import { useEffect, useState } from "react";
import { Interests } from "./Interests.tsx";
import { api, type Bullet, type Profile as ProfileData, type Role } from "../api.ts";

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

export function Profile() {
  const [data, setData] = useState<ProfileData | null>(null);
  const [adding, setAdding] = useState(false);
  const [role, setRole] = useState({ company: "", title: "", start_date: "", end_date: "" });
  const [skill, setSkill] = useState("");

  const load = () => void api.profile().then(setData);
  useEffect(load, []);

  if (!data) return <div className="empty">Loading profile…</div>;

  return (
    <div className="profile">
      <Interests />

      <h3>About you</h3>
      <div className="field-grid">
        {(["name", "headline", "email", "location"] as const).map((field) => (
          <label key={field}>
            <span>{field}</span>
            <input
              defaultValue={data.profile[field] ?? ""}
              placeholder={field === "headline" ? "Staff Backend Engineer" : ""}
              onBlur={(event) => {
                if (event.target.value !== (data.profile[field] ?? "")) {
                  void api.patchProfile({ [field]: event.target.value }).then(load);
                }
              }}
            />
          </label>
        ))}
      </div>

      {data.empty && (
        <div className="hint">
          Your profile is empty. Add your roles below, or ask the assistant: “here is my resume”
          and paste it — it will record the facts for you.
        </div>
      )}

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

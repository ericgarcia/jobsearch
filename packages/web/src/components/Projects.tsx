import { useEffect, useState } from "react";
import { api, type Project, type ProseSection } from "../api.ts";

/**
 * Projects and prose, the long-form half of the profile.
 *
 * A project has two bodies and they are not two sizes of the same thing. The
 * blurb is one line, written for a stranger in a hurry, and it is what
 * appears beside a role. The narrative is however long it needs to be, and
 * it is source material: the fact-checker reads it so a tailored summary can
 * draw on it honestly, and the agent distils bullets from it that you
 * approve.
 *
 * So the narrative is not published by default. It is where someone writes
 * candidly for their own use, and a tool that quietly put that on the public
 * internet would be a bad tool.
 */

function ProjectCard({
  project,
  roleName,
  onSave,
  onDelete,
}: {
  project: Project;
  roleName: string | null;
  onSave: (patch: Partial<Project>) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(project);
  const dirty = JSON.stringify(draft) !== JSON.stringify(project);

  useEffect(() => setDraft(project), [project]);

  return (
    <li className="project-card">
      <div className="project-head">
        <button className="ghost project-disclose" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "▾" : "▸"}
        </button>
        <div className="project-title">
          <strong>{project.name}</strong>
          {roleName && <span className="project-role"> · {roleName}</span>}
        </div>
        <span className="project-flags">
          {project.narrative ? (
            <span className={project.narrative_public ? "flag flag-on" : "flag"}>
              {project.narrative_public ? "long form public" : "long form private"}
            </span>
          ) : (
            <span className="flag flag-empty">no long form yet</span>
          )}
        </span>
      </div>

      {open && (
        <div className="project-body">
          <label>
            <span>Name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>

          <label>
            <span>One line, for a resume</span>
            <input
              value={draft.blurb ?? ""}
              placeholder="What it was, in a sentence"
              onChange={(e) => setDraft({ ...draft, blurb: e.target.value })}
            />
          </label>

          <label>
            <span>The long version</span>
            <textarea
              rows={10}
              value={draft.narrative ?? ""}
              placeholder="What the problem was, what you tried, what it cost, what changed. Write it for yourself — the agent turns this into bullets, and the fact-checker uses it to tell a true summary from an invented one."
              onChange={(e) => setDraft({ ...draft, narrative: e.target.value })}
            />
          </label>

          <label className="project-public">
            <input
              type="checkbox"
              checked={draft.narrative_public === 1}
              onChange={(e) => setDraft({ ...draft, narrative_public: e.target.checked ? 1 : 0 })}
            />
            <span>
              Show the long version on my public profile
              <em> — off by default, because this is where people write candidly</em>
            </span>
          </label>

          <div className="project-actions">
            <button onClick={() => onSave(draft)} disabled={!dirty}>
              {dirty ? "Save" : "Saved"}
            </button>
            <button className="ghost" onClick={onDelete}>
              Delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sections, setSections] = useState<ProseSection[]>([]);
  const [roles, setRoles] = useState<{ id: number; title: string; company: string }[]>([]);
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    void api.projects().then(setProjects).catch(() => setError("Could not load projects."));
    void api.sections().then(setSections).catch(() => setError("Could not load sections."));
  };

  useEffect(() => {
    reload();
    void api
      .profile()
      .then((p) => setRoles(p.roles.map((r) => ({ id: r.id, title: r.title, company: r.company }))))
      .catch(() => undefined);
  }, []);

  const add = async () => {
    if (!name.trim()) return;
    try {
      await api.addProject({ name: name.trim(), role_id: roleId === "" ? null : Number(roleId) });
      setName("");
      reload();
    } catch (problem) {
      setError((problem as Error).message);
    }
  };

  const roleName = (id: number | null) => {
    const role = roles.find((r) => r.id === id);
    return role ? `${role.title}, ${role.company}` : null;
  };

  return (
    <div className="projects-pane">
      {error && <div className="banner error">{error}</div>}

      <h3>Projects</h3>
      <p className="editor-note">
        Write at length here once. The one-line version goes on a resume; the long version feeds the
        fact-checker and the bullets the agent proposes.
      </p>

      <div className="new-project">
        <input
          value={name}
          placeholder="Project name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">No role</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.title}, {role.company}
            </option>
          ))}
        </select>
        <button onClick={() => void add()} disabled={!name.trim()}>
          Add
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="empty">No projects yet.</div>
      ) : (
        <ul className="project-list">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              roleName={roleName(project.role_id)}
              onSave={(patch) => {
                void api
                  .saveProject(project.id, patch)
                  .then(reload)
                  .catch((problem) => setError((problem as Error).message));
              }}
              onDelete={() => {
                void api.deleteProject(project.id).then(reload);
              }}
            />
          ))}
        </ul>
      )}

      <h3>In your own words</h3>
      <p className="editor-note">
        Values, how you work, what you care about. These appear on the public profile, not on a resume.
      </p>

      <ul className="section-prose-list">
        {sections.map((section) => (
          <li key={section.id}>
            <input
              defaultValue={section.heading}
              onBlur={(e) => void api.saveSection(section.id, { heading: e.target.value }).then(reload)}
            />
            <textarea
              rows={4}
              defaultValue={section.body}
              onBlur={(e) => void api.saveSection(section.id, { body: e.target.value }).then(reload)}
            />
            <div className="project-actions">
              <label>
                <input
                  type="checkbox"
                  checked={section.is_public === 1}
                  onChange={(e) => void api.saveSection(section.id, { is_public: e.target.checked ? 1 : 0 }).then(reload)}
                />
                public
              </label>
              <button className="ghost" onClick={() => void api.deleteSection(section.id).then(reload)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      <button
        className="ghost"
        onClick={() =>
          void api.addSection({ heading: "How I work", body: "" }).then(reload)
        }
      >
        + Add a section
      </button>
    </div>
  );
}

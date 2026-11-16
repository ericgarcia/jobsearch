import { all, get, run } from "../db/client.js";
import { changed } from "../notify.js";
import { getInterests } from "../interests.js";
import * as profile from "../profile.js";
import { getResume } from "../resume.js";
import type { RenderContent, Surface } from "@jobsearch/layout";
import {
  checkSpec,
  checkTokens,
  DEFAULT_SPECS,
  layoutSpec,
  type LayoutSpec,
} from "@jobsearch/layout";

/**
 * Layouts: a surface, an ordered set of sections, and a set of tokens.
 *
 * Stored as data rather than written as code, so a hosted copy can offer the
 * same customising as a local one. Nothing here is executable: a spec is a
 * list of section names and flags, and every token is checked against a type
 * before it is kept.
 */

export interface LayoutRow {
  id: number;
  surface: Surface;
  name: string;
  spec: LayoutSpec;
  tokens: Record<string, string>;
  is_default: number;
  updated_at: string;
}

interface StoredRow {
  id: number;
  surface: string;
  name: string;
  spec: string;
  tokens: string;
  is_default: number;
  updated_at: string;
}

function hydrate(row: StoredRow): LayoutRow {
  /*
    A stored spec is parsed, never trusted. It was valid when written, but a
    schema that has moved on since would otherwise reach the renderer as a
    shape it does not handle, and the first sign would be a blank section.
  */
  const parsed = layoutSpec.safeParse(JSON.parse(row.spec));
  const surface = row.surface === "resume" ? "resume" : "profile";
  return {
    id: row.id,
    surface,
    name: row.name,
    spec: parsed.success ? parsed.data : DEFAULT_SPECS[surface],
    tokens: JSON.parse(row.tokens) as Record<string, string>,
    is_default: row.is_default,
    updated_at: row.updated_at,
  };
}

export async function listLayouts(surface?: Surface): Promise<LayoutRow[]> {
  const rows = surface
    ? await all<StoredRow>(`SELECT * FROM layouts WHERE surface = ? ORDER BY is_default DESC, name`, surface)
    : await all<StoredRow>(`SELECT * FROM layouts ORDER BY surface, is_default DESC, name`);
  return rows.map(hydrate);
}

export async function getLayout(id: number): Promise<LayoutRow> {
  const row = await get<StoredRow>(`SELECT * FROM layouts WHERE id = ?`, id);
  if (!row) throw new Error(`No layout with id ${id}`);
  return hydrate(row);
}

/** The layout a surface uses when nothing else is named. */
export async function defaultLayout(surface: Surface): Promise<LayoutRow> {
  const row = await get<StoredRow>(
    `SELECT * FROM layouts WHERE surface = ? ORDER BY is_default DESC, id LIMIT 1`,
    surface,
  );
  if (row) return hydrate(row);
  return seedLayout(surface);
}

async function seedLayout(surface: Surface): Promise<LayoutRow> {
  const result = await run(
    `INSERT INTO layouts (surface, name, spec, tokens, is_default) VALUES (?, ?, ?, ?, 1)`,
    surface,
    surface === "resume" ? "Default resume" : "Default profile",
    JSON.stringify(DEFAULT_SPECS[surface]),
    JSON.stringify({}),
  );
  return getLayout(result.lastInsertRowid);
}

/** Both surfaces have a layout. Called once at startup. */
export async function seedLayouts(): Promise<void> {
  for (const surface of ["profile", "resume"] as const) {
    const existing = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM layouts WHERE surface = ?`, surface);
    if (!existing || existing.n === 0) await seedLayout(surface);
  }
}

export interface LayoutPatch {
  name?: string;
  spec?: unknown;
  tokens?: Record<string, string>;
}

/**
 * Change a layout. Rejects anything that would not render, and says why.
 *
 * The message matters more than usual: the agent is the main caller, and a
 * rejection it can read is a rejection it can fix on the next turn.
 */
export async function updateLayout(id: number, patch: LayoutPatch): Promise<LayoutRow> {
  const current = await getLayout(id);

  if (patch.name !== undefined) {
    await run(`UPDATE layouts SET name = ? WHERE id = ?`, patch.name.slice(0, 80), id);
  }

  if (patch.spec !== undefined) {
    const parsed = layoutSpec.safeParse(patch.spec);
    if (!parsed.success) {
      throw new Error(
        `That layout is not valid: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"} — ${issue.message}`)
          .join("; ")}`,
      );
    }
    const problems = checkSpec(parsed.data);
    if (problems.length > 0) throw new Error(problems.join(" "));
    await run(`UPDATE layouts SET spec = ? WHERE id = ?`, JSON.stringify(parsed.data), id);
  }

  if (patch.tokens !== undefined) {
    // Merged, so a caller changing one colour does not clear the rest.
    const merged = { ...current.tokens, ...patch.tokens };
    for (const [name, value] of Object.entries(patch.tokens)) {
      if (value === "") delete merged[name]; // Back to the default.
    }

    const problems = checkTokens(current.surface, merged);
    if (problems.length > 0) {
      throw new Error(
        `These values were refused: ${problems
          .map((p) => `${p.token} = "${p.value}" — ${p.why}`)
          .join("; ")}`,
      );
    }
    await run(`UPDATE layouts SET tokens = ? WHERE id = ?`, JSON.stringify(merged), id);
  }

  await run(`UPDATE layouts SET updated_at = datetime('now') WHERE id = ?`, id);
  changed("layout");
  return getLayout(id);
}

export async function createLayout(surface: Surface, name: string, from?: number): Promise<LayoutRow> {
  const base = from ? await getLayout(from) : null;
  const result = await run(
    `INSERT INTO layouts (surface, name, spec, tokens, is_default) VALUES (?, ?, ?, ?, 0)`,
    surface,
    name.slice(0, 80),
    JSON.stringify(base?.spec ?? DEFAULT_SPECS[surface]),
    JSON.stringify(base?.tokens ?? {}),
  );
  changed("layout");
  return getLayout(result.lastInsertRowid);
}

/* ------------------------------------------------------------- content */

function splitLinks(raw: string): { label: string; url: string }[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === "string") return { label: item.replace(/^https?:\/\//, ""), url: item };
        const record = item as { label?: string; url?: string };
        return record.url ? { label: record.label ?? record.url, url: record.url } : null;
      })
      .filter((item): item is { label: string; url: string } => item !== null)
      // Only addresses a browser will follow. A `javascript:` href in an
      // anchor we render is the one script injection this design still has.
      .filter((item) => /^https?:\/\//i.test(item.url) || /^mailto:/i.test(item.url));
  } catch {
    return [];
  }
}

/**
 * Everything a document can show, gathered once.
 *
 * `resumeId` swaps the content without touching the template: the same
 * styling renders the stored profile or any tailored draft. That is the
 * whole reason the two are separate.
 */
export async function gatherContent(resumeId?: number | null): Promise<RenderContent> {
  const [me, roles, bullets, education, skills, interests, projects, sections] = await Promise.all([
    profile.getProfile(),
    profile.listRoles(),
    profile.listBullets(),
    profile.listEducation(),
    profile.listSkills(),
    getInterests(),
    profile.listProjects(),
    profile.listSections(),
  ]);

  // A tailored resume replaces both the summary and the bullets; anything it
  // does not mention falls back to what is stored.
  let summary = me.summary;
  let chosen: Map<number, string[]> | null = null;

  if (resumeId != null) {
    const draft = await getResume(resumeId);
    summary = draft.summary ?? me.summary;
    chosen = new Map();
    for (const line of draft.lines) {
      const key = line.role_id ?? -1;
      chosen.set(key, [...(chosen.get(key) ?? []), line.text]);
    }
  }

  return {
    name: me.name,
    headline: me.headline,
    email: me.email,
    phone: me.phone,
    location: me.location,
    links: splitLinks(me.links),
    summary,
    values: sections
      .filter((section) => section.is_public === 1)
      .map((section) => ({ heading: section.heading, body: section.body })),
    interests: { titles: interests.titles, include: interests.include, note: interests.note },
    roles: roles
      .map((role) => ({
        id: role.id,
        title: role.title,
        company: role.company,
        location: role.location,
        start: role.start_date,
        end: role.end_date,
        summary: role.summary,
        bullets: chosen
          ? (chosen.get(role.id) ?? [])
          : bullets.filter((b) => b.role_id === role.id).map((b) => b.text),
        // The blurb, never the narrative: a project line beside a role has
        // to be one line. The long form belongs to the profile's own
        // projects section, and only when its author published it.
        projects: projects
          .filter((project) => project.role_id === role.id)
          .map((project) => ({ name: project.name, blurb: project.blurb })),
      }))
      // A tailored resume names a subset of roles. A role with nothing to say
      // on this resume is not a gap to explain, it is a role left out.
      .filter((role) => (chosen ? role.bullets.length > 0 : true)),
    /*
      The standalone projects section. A narrative appears here only if its
      author published it; otherwise the blurb stands alone. The default is
      unpublished, because the long form is where someone writes candidly
      for their own use.
    */
    projects: projects.map((project) => ({
      name: project.name,
      blurb: project.narrative_public === 1 && project.narrative ? project.narrative : project.blurb,
      role: roles.find((role) => role.id === project.role_id)?.company ?? null,
    })),
    education: education.map((item) => ({
      school: item.school,
      degree: item.degree,
      field: item.field,
      end: item.end_date,
    })),
    skills: skills.map((skill) => ({ name: skill.name, category: skill.category })),
  };
}

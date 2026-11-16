import type { InValue } from "@libsql/client";
import { all as dbAll, get as dbGet, run as dbRun } from "./db/client.js";

export interface ProfileRow {
  id: number;
  name: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  links: string;
  summary: string | null;
}

export interface RoleRow {
  id: number;
  company: string;
  title: string;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  summary: string | null;
  sort_order: number;
}

export interface BulletRow {
  id: number;
  role_id: number | null;
  text: string;
  skills: string;
  sort_order: number;
}

export interface EducationRow {
  id: number;
  school: string;
  degree: string | null;
  field: string | null;
  start_date: string | null;
  end_date: string | null;
  note: string | null;
}

export interface SkillRow {
  id: number;
  name: string;
  category: string | null;
  years: number | null;
}

/* ----------------------------------------------------------------- reading */

export async function getProfile(): Promise<ProfileRow> {
  (await dbRun(`INSERT OR IGNORE INTO profile (id) VALUES (1)`));
  return (await dbGet(`SELECT * FROM profile WHERE id = 1`)) as ProfileRow;
}

export async function listRoles(): Promise<RoleRow[]> {
  return (await dbAll(`SELECT * FROM profile_roles ORDER BY sort_order, COALESCE(end_date, '9999') DESC`)) as RoleRow[];
}

export async function listBullets(roleId?: number): Promise<BulletRow[]> {
  return roleId == null
    ? ((await dbAll(`SELECT * FROM profile_bullets ORDER BY role_id, sort_order`)) as BulletRow[])
    : ((await dbAll(`SELECT * FROM profile_bullets WHERE role_id = ? ORDER BY sort_order`, roleId)) as BulletRow[]);
}

export async function listEducation(): Promise<EducationRow[]> {
  return (await dbAll(`SELECT * FROM profile_education ORDER BY sort_order`)) as EducationRow[];
}

export async function listSkills(): Promise<SkillRow[]> {
  return (await dbAll(`SELECT * FROM profile_skills ORDER BY category, name`)) as SkillRow[];
}

/** The whole profile, as the agent and the UI both read it. */
export async function fullProfile() {
  const roles = await listRoles();
  const bullets = await listBullets();
  return {
    profile: await getProfile(),
    roles: roles.map((role) => ({
      ...role,
      links: undefined,
      bullets: bullets.filter((bullet) => bullet.role_id === role.id),
    })),
    unassigned_bullets: bullets.filter((bullet) => bullet.role_id == null),
    education: await listEducation(),
    skills: await listSkills(),
  };
}

/** Every stored fact as one block of text, for checking generated prose. */
export async function profileCorpus(): Promise<string> {
  // One round trip each, in parallel: they do not depend on each other, and
  // a remote database makes the difference between five waits and one.
  const [profile, roles, bullets, education, skills] = await Promise.all([
    getProfile(),
    listRoles(),
    listBullets(),
    listEducation(),
    listSkills(),
  ]);

  return [
    profile.headline,
    profile.summary,
    ...roles.map((role) => `${role.title} ${role.company} ${role.summary ?? ""}`),
    ...bullets.map((bullet) => bullet.text),
    ...education.map((item) => `${item.school} ${item.degree ?? ""} ${item.field ?? ""}`),
    ...skills.map((skill) => `${skill.name} ${skill.years ?? ""}`),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function isEmpty(): Promise<boolean> {
  return (await listRoles()).length === 0 && (await listBullets()).length === 0;
}

/* ----------------------------------------------------------------- writing */

export async function updateProfile(patch: Partial<Omit<ProfileRow, "id">>): Promise<ProfileRow> {
  await getProfile();
  const fields = ["name", "headline", "email", "phone", "location", "links", "summary"] as const;
  const set: string[] = [];
  const params: InValue[] = [];

  for (const field of fields) {
    if (patch[field] !== undefined) {
      set.push(`${field} = ?`);
      params.push(patch[field]);
    }
  }
  if (set.length > 0) {
    (await dbRun(`UPDATE profile SET ${set.join(", ")}, updated_at = datetime('now') WHERE id = 1`, ...params));
  }
  return await getProfile();
}

export async function addRole(
  role: Omit<RoleRow, "id" | "sort_order"> & { sort_order?: number },
): Promise<RoleRow> {
  const info = (await dbRun(`INSERT INTO profile_roles (company, title, location, start_date, end_date, summary, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, role.company,
      role.title,
      role.location ?? null,
      role.start_date ?? null,
      role.end_date ?? null,
      role.summary ?? null,
      role.sort_order ?? 0));
  return (await dbGet(`SELECT * FROM profile_roles WHERE id = ?`, info.lastInsertRowid)) as RoleRow;
}

export async function updateRole(id: number, patch: Partial<RoleRow>): Promise<RoleRow> {
  const fields = ["company", "title", "location", "start_date", "end_date", "summary", "sort_order"] as const;
  const set: string[] = [];
  const params: InValue[] = [];
  for (const field of fields) {
    if (patch[field] !== undefined) {
      set.push(`${field} = ?`);
      params.push(patch[field]);
    }
  }
  if (set.length > 0) {
    (await dbRun(`UPDATE profile_roles SET ${set.join(", ")} WHERE id = ?`, ...params, id));
  }
  const row = (await dbGet(`SELECT * FROM profile_roles WHERE id = ?`, id)) as RoleRow | undefined;
  if (!row) throw new Error(`No role with id ${id}`);
  return row;
}

export async function deleteRole(id: number): Promise<boolean> {
  return (await dbRun(`DELETE FROM profile_roles WHERE id = ?`, id)).changes > 0;
}

export async function addBullet(roleId: number | null, text: string, skills: string[] = []): Promise<BulletRow> {
  if (roleId != null) {
    const role = (await dbGet(`SELECT 1 FROM profile_roles WHERE id = ?`, roleId));
    if (!role) throw new Error(`No role with id ${roleId}`);
  }
  const next = (await dbGet(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM profile_bullets WHERE role_id IS ?`, roleId)) as { n: number };
  const info = (await dbRun(`INSERT INTO profile_bullets (role_id, text, skills, sort_order) VALUES (?, ?, ?, ?)`, roleId, text, JSON.stringify(skills), next.n));
  return (await dbGet(`SELECT * FROM profile_bullets WHERE id = ?`, info.lastInsertRowid)) as BulletRow;
}

export async function updateBullet(id: number, text?: string, skills?: string[]): Promise<BulletRow> {
  if (text !== undefined) (await dbRun(`UPDATE profile_bullets SET text = ? WHERE id = ?`, text, id));
  if (skills !== undefined) {
    (await dbRun(`UPDATE profile_bullets SET skills = ? WHERE id = ?`, JSON.stringify(skills), id));
  }
  const row = (await dbGet(`SELECT * FROM profile_bullets WHERE id = ?`, id)) as BulletRow | undefined;
  if (!row) throw new Error(`No bullet with id ${id}`);
  return row;
}

export async function deleteBullet(id: number): Promise<boolean> {
  return (await dbRun(`DELETE FROM profile_bullets WHERE id = ?`, id)).changes > 0;
}

export async function addEducation(item: Omit<EducationRow, "id">): Promise<EducationRow> {
  const info = (await dbRun(`INSERT INTO profile_education (school, degree, field, start_date, end_date, note)
       VALUES (?, ?, ?, ?, ?, ?)`, item.school,
      item.degree ?? null,
      item.field ?? null,
      item.start_date ?? null,
      item.end_date ?? null,
      item.note ?? null));
  return (await dbGet(`SELECT * FROM profile_education WHERE id = ?`, info.lastInsertRowid)) as EducationRow;
}

export async function deleteEducation(id: number): Promise<boolean> {
  return (await dbRun(`DELETE FROM profile_education WHERE id = ?`, id)).changes > 0;
}

export async function addSkill(name: string, category?: string, years?: number): Promise<SkillRow> {
  (await dbRun(`INSERT INTO profile_skills (name, category, years) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET category = excluded.category, years = excluded.years`, name, category ?? null, years ?? null));
  return (await dbGet(`SELECT * FROM profile_skills WHERE name = ?`, name)) as SkillRow;
}

export async function deleteSkill(id: number): Promise<boolean> {
  return (await dbRun(`DELETE FROM profile_skills WHERE id = ?`, id)).changes > 0;
}

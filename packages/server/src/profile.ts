import { db } from "./db/client.js";

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

export function getProfile(): ProfileRow {
  db.prepare(`INSERT OR IGNORE INTO profile (id) VALUES (1)`).run();
  return db.prepare(`SELECT * FROM profile WHERE id = 1`).get() as ProfileRow;
}

export function listRoles(): RoleRow[] {
  return db
    .prepare(`SELECT * FROM profile_roles ORDER BY sort_order, COALESCE(end_date, '9999') DESC`)
    .all() as RoleRow[];
}

export function listBullets(roleId?: number): BulletRow[] {
  return roleId == null
    ? (db.prepare(`SELECT * FROM profile_bullets ORDER BY role_id, sort_order`).all() as BulletRow[])
    : (db
        .prepare(`SELECT * FROM profile_bullets WHERE role_id = ? ORDER BY sort_order`)
        .all(roleId) as BulletRow[]);
}

export function listEducation(): EducationRow[] {
  return db.prepare(`SELECT * FROM profile_education ORDER BY sort_order`).all() as EducationRow[];
}

export function listSkills(): SkillRow[] {
  return db.prepare(`SELECT * FROM profile_skills ORDER BY category, name`).all() as SkillRow[];
}

/** The whole profile, as the agent and the UI both read it. */
export function fullProfile() {
  const roles = listRoles();
  const bullets = listBullets();
  return {
    profile: getProfile(),
    roles: roles.map((role) => ({
      ...role,
      links: undefined,
      bullets: bullets.filter((bullet) => bullet.role_id === role.id),
    })),
    unassigned_bullets: bullets.filter((bullet) => bullet.role_id == null),
    education: listEducation(),
    skills: listSkills(),
  };
}

/** Every stored fact as one block of text, for checking generated prose. */
export function profileCorpus(): string {
  const profile = getProfile();
  return [
    profile.headline,
    profile.summary,
    ...listRoles().map((role) => `${role.title} ${role.company} ${role.summary ?? ""}`),
    ...listBullets().map((bullet) => bullet.text),
    ...listEducation().map((item) => `${item.school} ${item.degree ?? ""} ${item.field ?? ""}`),
    ...listSkills().map((skill) => `${skill.name} ${skill.years ?? ""}`),
  ]
    .filter(Boolean)
    .join("\n");
}

export function isEmpty(): boolean {
  return listRoles().length === 0 && listBullets().length === 0;
}

/* ----------------------------------------------------------------- writing */

export function updateProfile(patch: Partial<Omit<ProfileRow, "id">>): ProfileRow {
  getProfile();
  const fields = ["name", "headline", "email", "phone", "location", "links", "summary"] as const;
  const set: string[] = [];
  const params: unknown[] = [];

  for (const field of fields) {
    if (patch[field] !== undefined) {
      set.push(`${field} = ?`);
      params.push(patch[field]);
    }
  }
  if (set.length > 0) {
    db.prepare(
      `UPDATE profile SET ${set.join(", ")}, updated_at = datetime('now') WHERE id = 1`,
    ).run(...params);
  }
  return getProfile();
}

export function addRole(role: Omit<RoleRow, "id" | "sort_order"> & { sort_order?: number }): RoleRow {
  const info = db
    .prepare(
      `INSERT INTO profile_roles (company, title, location, start_date, end_date, summary, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      role.company,
      role.title,
      role.location ?? null,
      role.start_date ?? null,
      role.end_date ?? null,
      role.summary ?? null,
      role.sort_order ?? 0,
    );
  return db.prepare(`SELECT * FROM profile_roles WHERE id = ?`).get(info.lastInsertRowid) as RoleRow;
}

export function updateRole(id: number, patch: Partial<RoleRow>): RoleRow {
  const fields = ["company", "title", "location", "start_date", "end_date", "summary", "sort_order"] as const;
  const set: string[] = [];
  const params: unknown[] = [];
  for (const field of fields) {
    if (patch[field] !== undefined) {
      set.push(`${field} = ?`);
      params.push(patch[field]);
    }
  }
  if (set.length > 0) {
    db.prepare(`UPDATE profile_roles SET ${set.join(", ")} WHERE id = ?`).run(...params, id);
  }
  const row = db.prepare(`SELECT * FROM profile_roles WHERE id = ?`).get(id) as RoleRow | undefined;
  if (!row) throw new Error(`No role with id ${id}`);
  return row;
}

export function deleteRole(id: number): boolean {
  return db.prepare(`DELETE FROM profile_roles WHERE id = ?`).run(id).changes > 0;
}

export function addBullet(roleId: number | null, text: string, skills: string[] = []): BulletRow {
  if (roleId != null) {
    const role = db.prepare(`SELECT 1 FROM profile_roles WHERE id = ?`).get(roleId);
    if (!role) throw new Error(`No role with id ${roleId}`);
  }
  const next = db
    .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM profile_bullets WHERE role_id IS ?`)
    .get(roleId) as { n: number };
  const info = db
    .prepare(`INSERT INTO profile_bullets (role_id, text, skills, sort_order) VALUES (?, ?, ?, ?)`)
    .run(roleId, text, JSON.stringify(skills), next.n);
  return db
    .prepare(`SELECT * FROM profile_bullets WHERE id = ?`)
    .get(info.lastInsertRowid) as BulletRow;
}

export function updateBullet(id: number, text?: string, skills?: string[]): BulletRow {
  if (text !== undefined) db.prepare(`UPDATE profile_bullets SET text = ? WHERE id = ?`).run(text, id);
  if (skills !== undefined) {
    db.prepare(`UPDATE profile_bullets SET skills = ? WHERE id = ?`).run(JSON.stringify(skills), id);
  }
  const row = db.prepare(`SELECT * FROM profile_bullets WHERE id = ?`).get(id) as BulletRow | undefined;
  if (!row) throw new Error(`No bullet with id ${id}`);
  return row;
}

export function deleteBullet(id: number): boolean {
  return db.prepare(`DELETE FROM profile_bullets WHERE id = ?`).run(id).changes > 0;
}

export function addEducation(item: Omit<EducationRow, "id">): EducationRow {
  const info = db
    .prepare(
      `INSERT INTO profile_education (school, degree, field, start_date, end_date, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.school,
      item.degree ?? null,
      item.field ?? null,
      item.start_date ?? null,
      item.end_date ?? null,
      item.note ?? null,
    );
  return db
    .prepare(`SELECT * FROM profile_education WHERE id = ?`)
    .get(info.lastInsertRowid) as EducationRow;
}

export function deleteEducation(id: number): boolean {
  return db.prepare(`DELETE FROM profile_education WHERE id = ?`).run(id).changes > 0;
}

export function addSkill(name: string, category?: string, years?: number): SkillRow {
  db.prepare(
    `INSERT INTO profile_skills (name, category, years) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET category = excluded.category, years = excluded.years`,
  ).run(name, category ?? null, years ?? null);
  return db.prepare(`SELECT * FROM profile_skills WHERE name = ?`).get(name) as SkillRow;
}

export function deleteSkill(id: number): boolean {
  return db.prepare(`DELETE FROM profile_skills WHERE id = ?`).run(id).changes > 0;
}

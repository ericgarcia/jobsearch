import { db } from "./db/client.js";
import { checkAgainstCorpus, checkRendering } from "./factcheck.js";
import * as profile from "./profile.js";

export interface DraftLine {
  /** Must name a bullet that already exists in the profile. */
  bullet_id: number;
  /** The bullet reworded for this posting. Omit to use the stored wording. */
  rendered_text?: string;
}

export interface ResumeLineView {
  id: number;
  source_bullet_id: number;
  source_text: string;
  rendered_text: string | null;
  text: string;
  warnings: string[];
  role_id: number | null;
}

/**
 * Assemble a tailored resume.
 *
 * Every line must name a bullet that is already in the profile, so the agent
 * cannot add a job, an employer or an achievement that the person never
 * recorded. Rewording is allowed, and each reworded line is checked against the
 * fact it came from.
 */
export const draftResume = db.transaction(
  (input: {
    jobId: number | null;
    label?: string;
    summary?: string;
    lines: DraftLine[];
  }): { resumeId: number; warnings: string[] } => {
    if (input.lines.length === 0) {
      throw new Error("A resume needs at least one line.");
    }

    const bullets = new Map(profile.listBullets().map((bullet) => [bullet.id, bullet]));
    const unknown = input.lines
      .map((line) => line.bullet_id)
      .filter((id) => !bullets.has(id));

    if (unknown.length > 0) {
      throw new Error(
        `These bullet ids are not in the profile: ${unknown.join(", ")}. ` +
          `Add the fact with add_bullet first; a resume may only restate stored facts.`,
      );
    }

    if (input.jobId != null) {
      const job = db.prepare(`SELECT 1 FROM jobs WHERE id = ?`).get(input.jobId);
      if (!job) throw new Error(`No job with id ${input.jobId}`);
    }

    // The summary is free prose, so check it against every stored fact.
    const summaryWarnings = input.summary
      ? checkAgainstCorpus(profile.profileCorpus(), input.summary)
      : [];

    const resumeId = Number(
      db
        .prepare(`INSERT INTO resumes (job_id, label, summary, warnings) VALUES (?, ?, ?, ?)`)
        .run(
          input.jobId,
          input.label ?? null,
          input.summary ?? null,
          JSON.stringify(summaryWarnings),
        ).lastInsertRowid,
    );

    const allWarnings: string[] = [...summaryWarnings];
    const insert = db.prepare(
      `INSERT INTO resume_lines (resume_id, source_bullet_id, rendered_text, warnings, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
    );

    input.lines.forEach((line, index) => {
      const source = bullets.get(line.bullet_id)!;
      const warnings = line.rendered_text
        ? checkRendering(source.text, line.rendered_text)
        : [];
      allWarnings.push(...warnings);
      insert.run(resumeId, line.bullet_id, line.rendered_text ?? null, JSON.stringify(warnings), index);
    });

    return { resumeId, warnings: allWarnings };
  },
);

export function getResume(id: number) {
  const resume = db.prepare(`SELECT * FROM resumes WHERE id = ?`).get(id) as
    | {
        id: number;
        job_id: number | null;
        label: string | null;
        summary: string | null;
        warnings: string;
        created_at: string;
      }
    | undefined;
  if (!resume) throw new Error(`No resume with id ${id}`);

  const lines = db
    .prepare(
      `SELECT l.id, l.source_bullet_id, l.rendered_text, l.warnings, b.text AS source_text, b.role_id
         FROM resume_lines l
         JOIN profile_bullets b ON b.id = l.source_bullet_id
        WHERE l.resume_id = ?
        ORDER BY l.sort_order`,
    )
    .all(id) as {
    id: number;
    source_bullet_id: number;
    rendered_text: string | null;
    warnings: string;
    source_text: string;
    role_id: number | null;
  }[];

  const job = resume.job_id
    ? (db
        .prepare(`SELECT id, company, title, url FROM jobs WHERE id = ?`)
        .get(resume.job_id) as { id: number; company: string; title: string; url: string } | undefined)
    : undefined;

  const view: ResumeLineView[] = lines.map((line) => ({
    id: line.id,
    source_bullet_id: line.source_bullet_id,
    source_text: line.source_text,
    rendered_text: line.rendered_text,
    text: line.rendered_text ?? line.source_text,
    warnings: JSON.parse(line.warnings) as string[],
    role_id: line.role_id,
  }));

  const summaryWarnings = JSON.parse(resume.warnings) as string[];
  return {
    ...resume,
    job,
    lines: view,
    summary_warnings: summaryWarnings,
    warnings: [...summaryWarnings, ...view.flatMap((line) => line.warnings)],
  };
}

export function listResumes(jobId?: number) {
  const where = jobId == null ? "" : "WHERE r.job_id = ?";
  return db
    .prepare(
      `SELECT r.id, r.job_id, r.label, r.created_at, j.company, j.title,
              (SELECT COUNT(*) FROM resume_lines l WHERE l.resume_id = r.id) AS lines
         FROM resumes r LEFT JOIN jobs j ON j.id = r.job_id
        ${where} ORDER BY r.created_at DESC`,
    )
    .all(...(jobId == null ? [] : [jobId]));
}

export function deleteResume(id: number): boolean {
  return db.prepare(`DELETE FROM resumes WHERE id = ?`).run(id).changes > 0;
}

/** Render a resume as Markdown, grouped by role in profile order. */
export function renderMarkdown(id: number): string {
  const resume = getResume(id);
  const me = profile.getProfile();
  const roles = new Map(profile.listRoles().map((role) => [role.id, role]));

  const header = [
    me.name ? `# ${me.name}` : "# Resume",
    [me.headline, me.location].filter(Boolean).join(" · "),
    [me.email, me.phone].filter(Boolean).join(" · "),
  ].filter(Boolean);

  const out = [...header, ""];

  if (resume.summary) out.push("## Summary", "", resume.summary, "");

  const byRole = new Map<number | null, ResumeLineView[]>();
  for (const line of resume.lines) {
    const bucket = byRole.get(line.role_id) ?? [];
    bucket.push(line);
    byRole.set(line.role_id, bucket);
  }

  if (byRole.size > 0) {
    out.push("## Experience", "");
    const ordered = [...byRole.keys()].sort((a, b) => {
      const left = a == null ? Number.MAX_SAFE_INTEGER : (roles.get(a)?.sort_order ?? 0);
      const right = b == null ? Number.MAX_SAFE_INTEGER : (roles.get(b)?.sort_order ?? 0);
      return left - right;
    });

    for (const roleId of ordered) {
      const role = roleId == null ? null : roles.get(roleId);
      if (role) {
        const dates = [role.start_date, role.end_date ?? "present"].filter(Boolean).join(" – ");
        out.push(`### ${role.title}, ${role.company}`);
        if (dates || role.location) {
          out.push([dates, role.location].filter(Boolean).join(" · "));
        }
        out.push("");
      }
      for (const line of byRole.get(roleId)!) out.push(`- ${line.text}`);
      out.push("");
    }
  }

  const education = profile.listEducation();
  if (education.length > 0) {
    out.push("## Education", "");
    for (const item of education) {
      out.push(
        `- ${[item.degree, item.field].filter(Boolean).join(" ")}${
          item.degree || item.field ? ", " : ""
        }${item.school}${item.end_date ? ` (${item.end_date})` : ""}`,
      );
    }
    out.push("");
  }

  const skills = profile.listSkills();
  if (skills.length > 0) {
    out.push("## Skills", "", skills.map((skill) => skill.name).join(" · "), "");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ----------------------------------------------------------- cover letters */

export function saveCoverLetter(jobId: number, body: string) {
  const job = db.prepare(`SELECT 1 FROM jobs WHERE id = ?`).get(jobId);
  if (!job) throw new Error(`No job with id ${jobId}`);

  const warnings = checkAgainstCorpus(profile.profileCorpus(), body);
  const id = Number(
    db
      .prepare(`INSERT INTO cover_letters (job_id, body, warnings) VALUES (?, ?, ?)`)
      .run(jobId, body, JSON.stringify(warnings)).lastInsertRowid,
  );
  return { id, job_id: jobId, warnings };
}

export function listCoverLetters(jobId: number) {
  return (
    db
      .prepare(`SELECT * FROM cover_letters WHERE job_id = ? ORDER BY created_at DESC`)
      .all(jobId) as { id: number; job_id: number; body: string; warnings: string; created_at: string }[]
  ).map((row) => ({ ...row, warnings: JSON.parse(row.warnings) as string[] }));
}

export interface CoverLetterRow {
  id: number;
  job_id: number;
  body: string;
  warnings: string[];
  created_at: string;
  company: string | null;
  title: string | null;
  url: string | null;
}

/** Every cover letter, newest first, with the posting each one targets. */
export function listAllCoverLetters(): CoverLetterRow[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.job_id, c.body, c.warnings, c.created_at,
              j.company, j.title, j.url
         FROM cover_letters c
         LEFT JOIN jobs j ON j.id = c.job_id
        ORDER BY c.created_at DESC`,
    )
    .all() as (Omit<CoverLetterRow, "warnings"> & { warnings: string })[];

  return rows.map((row) => ({ ...row, warnings: JSON.parse(row.warnings) as string[] }));
}

export function getCoverLetter(id: number): CoverLetterRow {
  const letter = listAllCoverLetters().find((row) => row.id === id);
  if (!letter) throw new Error(`No cover letter with id ${id}`);
  return letter;
}

export function deleteCoverLetter(id: number): boolean {
  return db.prepare(`DELETE FROM cover_letters WHERE id = ?`).run(id).changes > 0;
}

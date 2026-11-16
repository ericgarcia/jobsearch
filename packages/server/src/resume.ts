import { all as dbAll, get as dbGet, run as dbRun, tx } from "./db/client.js";
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
export async function draftResume(input: {
  jobId: number | null;
  label?: string;
  summary?: string;
  lines: DraftLine[];
}): Promise<{ resumeId: number; warnings: string[] }> {
  return tx(async () => {
    if (input.lines.length === 0) {
      throw new Error("A resume needs at least one line.");
    }

    const bullets = new Map((await profile.listBullets()).map((bullet) => [bullet.id, bullet]));
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
      const job = (await dbGet(`SELECT 1 FROM jobs WHERE id = ?`, input.jobId));
      if (!job) throw new Error(`No job with id ${input.jobId}`);
    }

    // The summary is free prose, so check it against every stored fact.
    const summaryWarnings = input.summary
      ? checkAgainstCorpus(await profile.profileCorpus(), input.summary)
      : [];

    const resumeId = Number(
      (await dbRun(`INSERT INTO resumes (job_id, label, summary, warnings) VALUES (?, ?, ?, ?)`, input.jobId,
          input.label ?? null,
          input.summary ?? null,
          JSON.stringify(summaryWarnings))).lastInsertRowid,
    );

    const allWarnings: string[] = [...summaryWarnings];
    const INSERT_LINE = `INSERT INTO resume_lines (resume_id, source_bullet_id, rendered_text, warnings, sort_order)
       VALUES (?, ?, ?, ?, ?)`;

    // Sequential, not Promise.all: sort_order is the line's position, and the
    // rows should go in holding it.
    for (const [index, line] of input.lines.entries()) {
      const source = bullets.get(line.bullet_id)!;
      const warnings = line.rendered_text
        ? checkRendering(source.text, line.rendered_text)
        : [];
      allWarnings.push(...warnings);
      await dbRun(
        INSERT_LINE,
        resumeId,
        line.bullet_id,
        line.rendered_text ?? null,
        JSON.stringify(warnings),
        index,
      );
    }

    return { resumeId, warnings: allWarnings };
  });
}

export async function getResume(id: number) {
  const resume = (await dbGet(`SELECT * FROM resumes WHERE id = ?`, id)) as
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

  const lines = (await dbAll(`SELECT l.id, l.source_bullet_id, l.rendered_text, l.warnings, b.text AS source_text, b.role_id
         FROM resume_lines l
         JOIN profile_bullets b ON b.id = l.source_bullet_id
        WHERE l.resume_id = ?
        ORDER BY l.sort_order`, id)) as {
    id: number;
    source_bullet_id: number;
    rendered_text: string | null;
    warnings: string;
    source_text: string;
    role_id: number | null;
  }[];

  const job = resume.job_id
    ? ((await dbGet(`SELECT id, company, title, url FROM jobs WHERE id = ?`, resume.job_id)) as { id: number; company: string; title: string; url: string } | undefined)
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

export async function listResumes(jobId?: number) {
  const where = jobId == null ? "" : "WHERE r.job_id = ?";
  return (await dbAll(`SELECT r.id, r.job_id, r.label, r.created_at, j.company, j.title,
              (SELECT COUNT(*) FROM resume_lines l WHERE l.resume_id = r.id) AS lines
         FROM resumes r LEFT JOIN jobs j ON j.id = r.job_id
        ${where} ORDER BY r.created_at DESC`, ...(jobId == null ? [] : [jobId])));
}

export async function deleteResume(id: number): Promise<boolean> {
  return (await dbRun(`DELETE FROM resumes WHERE id = ?`, id)).changes > 0;
}

/** Render a resume as Markdown, grouped by role in profile order. */
export async function renderMarkdown(id: number): Promise<string> {
  const resume = await getResume(id);
  const me = await profile.getProfile();
  const roles = new Map((await profile.listRoles()).map((role) => [role.id, role]));

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

  const education = await profile.listEducation();
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

  const skills = await profile.listSkills();
  if (skills.length > 0) {
    out.push("## Skills", "", skills.map((skill) => skill.name).join(" · "), "");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ----------------------------------------------------------- cover letters */

export async function saveCoverLetter(jobId: number, body: string) {
  const job = (await dbGet(`SELECT 1 FROM jobs WHERE id = ?`, jobId));
  if (!job) throw new Error(`No job with id ${jobId}`);

  const warnings = checkAgainstCorpus(await profile.profileCorpus(), body);
  const id = Number(
    (await dbRun(`INSERT INTO cover_letters (job_id, body, warnings) VALUES (?, ?, ?)`, jobId, body, JSON.stringify(warnings))).lastInsertRowid,
  );
  return { id, job_id: jobId, warnings };
}

export async function listCoverLetters(jobId: number) {
  return (
    (await dbAll(`SELECT * FROM cover_letters WHERE job_id = ? ORDER BY created_at DESC`, jobId)) as { id: number; job_id: number; body: string; warnings: string; created_at: string }[]
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
export async function listAllCoverLetters(): Promise<CoverLetterRow[]> {
  const rows = (await dbAll(`SELECT c.id, c.job_id, c.body, c.warnings, c.created_at,
              j.company, j.title, j.url
         FROM cover_letters c
         LEFT JOIN jobs j ON j.id = c.job_id
        ORDER BY c.created_at DESC`)) as (Omit<CoverLetterRow, "warnings"> & { warnings: string })[];

  return rows.map((row) => ({ ...row, warnings: JSON.parse(row.warnings) as string[] }));
}

export async function getCoverLetter(id: number): Promise<CoverLetterRow> {
  const letter = (await listAllCoverLetters()).find((row) => row.id === id);
  if (!letter) throw new Error(`No cover letter with id ${id}`);
  return letter;
}

export async function deleteCoverLetter(id: number): Promise<boolean> {
  return (await dbRun(`DELETE FROM cover_letters WHERE id = ?`, id)).changes > 0;
}

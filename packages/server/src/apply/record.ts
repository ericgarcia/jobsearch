import { all, run } from "../db/client.js";
import { changed } from "../notify.js";
import * as repo from "../repo.js";

/**
 * What you told them.
 *
 * An application is answered once and remembered badly. Three weeks later a
 * recruiter asks about notice, or about the role you said you had, and the
 * form is gone — submitted, unreachable, and never shown again. So what went
 * onto the form is written down as it goes on.
 *
 * Self-identification is recorded as answered and never as an answer. The
 * values live in one table and stay there; a record that said "Disability:
 * yes" would have copied the most sensitive thing in the database into a
 * second place, to solve a problem nobody has — nobody forgets that one.
 */

export interface Answer {
  label: string;
  kind: string;
  value: string | null;
  at: string;
}

export async function recordAnswers(
  jobId: number,
  entries: { label: string; kind: string; value: string | null }[],
): Promise<void> {
  for (const entry of entries) {
    await run(
      `INSERT INTO application_answers (job_id, label, kind, value, at)
            VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (job_id, label) DO UPDATE SET
            kind = excluded.kind, value = excluded.value, at = excluded.at`,
      jobId,
      entry.label,
      entry.kind,
      // Never the value itself for self-identification: see above.
      entry.kind === "eeo" ? null : entry.value,
    );
  }
  changed("applications");
}

export async function listAnswers(jobId: number): Promise<Answer[]> {
  return await all<Answer>(
    `SELECT label, kind, value, at FROM application_answers WHERE job_id = ? ORDER BY id`,
    jobId,
  );
}

/**
 * The person has sent it.
 *
 * Only they can say so — nothing here can see a submitted form, and the app
 * never pressed the button. Moving the status on their word is the honest
 * version: the alternative is guessing from a page that may just have
 * reloaded.
 */
export async function markApplied(jobId: number): Promise<{ status: string; answers: number }> {
  const job = await repo.getJob(jobId);
  if (!job) throw new Error(`No job with id ${jobId}`);

  await repo.trackJob(jobId);
  const now = await repo.getJob(jobId);
  if (now?.status !== "applied") {
    await repo.setStatus(jobId, "applied", "Sent by the person");
  }
  await run(`UPDATE applications SET applied_at = datetime('now') WHERE job_id = ?`, jobId);

  const answers = await listAnswers(jobId);
  return { status: "applied", answers: answers.length };
}

import * as repo from "../repo.js";
import * as resume from "../resume.js";
import { coverage, listStandingAnswers, selfIdentificationKeysSet } from "./answers.js";
import { describe as describeForm } from "./form.js";
import { formForJob } from "./read.js";

/**
 * Starting an application.
 *
 * One call rather than six, because the six have an order and forgetting one
 * is invisible until it matters: a letter drafted before the form was read
 * answers questions nobody asked, and a resume drafted for the wrong posting
 * looks right.
 *
 * It does the deterministic half — move the application to "applying", find
 * what is already drafted for this job, read the form, work out what can be
 * answered — and hands back the brief for the half that needs writing. The
 * drafting itself stays with the agent, because choosing which of someone's
 * achievements to put in front of this employer is the judgement, and it is
 * checked against the stored facts on the way back in.
 */

export interface Started {
  job: {
    id: number;
    title: string;
    company: string;
    url: string;
    description: string | null;
  };
  status: string;
  /** What is already written for this job. Nothing is overwritten. */
  drafts: {
    resumes: { id: number; label: string | null; created_at: string }[];
    cover_letters: { id: number; created_at: string }[];
  };
  form?: {
    ats: string;
    url: string;
    summary: string;
    answerable: number;
    total: number;
    needs_you: { label: string; required: boolean; missing?: string }[];
  };
  /** Present when the form could not be read, with the reason. */
  form_error?: string;
  standing_answers: { topic: string; question: string; answer: string }[];
  self_identification_stored: string[];
  next: string;
}

export async function startApplication(jobId: number): Promise<Started> {
  const job = await repo.getJob(jobId);
  if (!job) throw new Error(`No job with id ${jobId}`);

  /*
    Tracked first, then moved. The status machine refuses a move from
    nothing, and an application that was already further along — screening,
    say — is left where it is rather than dragged backwards.
  */
  await repo.trackJob(jobId);
  const current = await repo.getJob(jobId);
  if (current?.status === "interested") {
    await repo.setStatus(jobId, "applying", "Started the application");
  }

  const [resumes, letters, standing, selfIds] = await Promise.all([
    resume.listResumes(jobId),
    resume.listCoverLetters(jobId),
    listStandingAnswers(),
    selfIdentificationKeysSet(),
  ]);

  const started: Started = {
    job: {
      id: job.id,
      title: job.title,
      company: job.company,
      url: job.url,
      description: job.description,
    },
    status: (await repo.getJob(jobId))?.status ?? "applying",
    drafts: {
      resumes: (resumes as { id: number; label: string | null; created_at: string }[]).map(
        (row) => ({ id: row.id, label: row.label ?? null, created_at: row.created_at }),
      ),
      cover_letters: letters.map((row) => ({ id: row.id, created_at: row.created_at })),
    },
    standing_answers: standing,
    self_identification_stored: selfIds,
    next: "",
  };

  /*
    The form is read before anything is written, and a failure to read it is
    not a failure to start. A posting on a board this app cannot parse still
    deserves a tailored resume; it just cannot say in advance what the form
    will want.
  */
  try {
    const form = await formForJob(jobId);
    const seen = await coverage(form);
    started.form = {
      ats: form.ats,
      url: form.url,
      summary: describeForm(form),
      answerable: seen.answerable,
      total: seen.total,
      needs_you: seen.needsYou.map((field) => ({
        label: field.label,
        required: field.required,
        ...(field.missing ? { missing: field.missing } : {}),
      })),
    };
  } catch (error) {
    started.form_error = error instanceof Error ? error.message : String(error);
  }

  started.next = instructions(started);
  return started;
}

/** What is left to do, in the order it should happen. */
function instructions(started: Started): string {
  const steps: string[] = [];

  if (started.drafts.resumes.length === 0) {
    steps.push(
      "Draft the resume with draft_resume, choosing the stored bullets this posting actually calls for.",
    );
  } else {
    steps.push(
      `A resume is already drafted for this job (#${started.drafts.resumes.at(-1)?.id}). Read it before writing another, and say what you would change rather than silently replacing it.`,
    );
  }

  if (started.drafts.cover_letters.length === 0) {
    steps.push("Then write the cover letter with save_cover_letter.");
  } else {
    steps.push(`A cover letter already exists (#${started.drafts.cover_letters.at(-1)?.id}).`);
  }

  const outstanding = started.form?.needs_you ?? [];
  if (outstanding.length > 0) {
    steps.push(
      `Then put these to the person, because nothing else can answer them: ${outstanding
        .map((field) => field.label)
        .join(" / ")}. Store anything that will be true at every company with set_standing_answer.`,
    );
  } else if (started.form) {
    steps.push("Everything the form asks can be answered from what is stored.");
  }

  if (started.form_error) {
    steps.push(
      `The application form could not be read (${started.form_error}), so say that you cannot list what it will ask for.`,
    );
  }

  steps.push(
    "Nothing is submitted here, and nothing will be: the person sends the application themselves.",
  );

  return steps.join(" ");
}

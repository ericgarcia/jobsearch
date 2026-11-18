import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "./config.js";
import { credentialEnv, readCredential } from "./settings.js";

/**
 * Whether a job being imported is one already on file.
 *
 * The first version compared the company and the title as written, which read
 * "University of Washington" and "University of Washington (Genome Sciences)"
 * as two employers and imported a career twice. The obvious repair — drop the
 * parentheses and compare again — is the one that must not be made on its
 * own, and the reason is in the same profile:
 *
 *   Intel Research          Research Intern   Jun 2008 – Sep 2008
 *   Intel Research Seattle  Research Intern   Jun 2007 – Sep 2007
 *   Intel Research Seattle  Research Intern   Apr 2006 – Oct 2006
 *
 * Three internships, one title, one employer. Matching on employer and title
 * would collapse them into one and delete two jobs. Dates are what tells a
 * repeat from a duplicate.
 *
 * The two mistakes are not equal, and that decides how this fails. A missed
 * duplicate is a second row on a page, visible, and one click to remove. A
 * false one silently loses work somebody did. So everything here leans
 * towards importing: certainty merges, doubt does not.
 */

const SUFFIX = /\b(inc|llc|ltd|limited|corp|corporation|co|plc|gmbh|sa|ag|srl|bv|pty)\b/g;

/**
 * A name reduced to what two spellings of it have in common.
 *
 * Deliberately mild. It removes punctuation, a legal suffix and a
 * parenthetical — the department, the campus, the trading name — and stops
 * there. Reducing further starts merging employers that are not the same one.
 */
export function plainName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[‐-―]/g, "-")
    .replace(/[^a-z0-9&+ -]/g, " ")
    .replace(SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A date as a number that sorts, from the forms documents actually use. */
export function asMonth(date: string | null | undefined): number | null {
  if (!date) return null;
  const text = date.trim().toLowerCase();
  if (!text || text === "present" || text === "current") return null;

  const iso = text.match(/^(\d{4})[-/](\d{1,2})/);
  if (iso) return Number(iso[1]) * 12 + Number(iso[2]) - 1;

  const months = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const named = text.match(/([a-z]{3,})\w*\s+(\d{4})/);
  if (named) {
    const at = months.indexOf(named[1]!.slice(0, 3));
    if (at >= 0) return Number(named[2]) * 12 + at;
  }

  const year = text.match(/(\d{4})/);
  return year ? Number(year[1]) * 12 : null;
}

export interface Job {
  company: string;
  title: string;
  start_date?: string | null;
  end_date?: string | null;
}

/**
 * Whether two date ranges can be the same stretch of time.
 *
 * Generous where a date is missing, because a document that does not say when
 * something started is not evidence that it was a different job — and strict
 * where both are given, because that is where the Intel internships are told
 * apart. Eleven months of slack, so "2005" and "January 2005" agree.
 */
export function sameSpell(a: Job, b: Job): boolean {
  const from = [asMonth(a.start_date), asMonth(b.start_date)];
  const to = [asMonth(a.end_date), asMonth(b.end_date)];
  if (from[0] == null || from[1] == null) return true;
  if (Math.abs(from[0] - from[1]) > 11) return false;
  if (to[0] == null || to[1] == null) return true;
  return Math.abs(to[0] - to[1]) <= 11;
}

/** The same job beyond doubt: one employer, one title, one stretch of time. */
export function plainlySame(a: Job, b: Job): boolean {
  const employer = plainName(a.company);
  if (!employer || employer !== plainName(b.company)) return false;
  const role = plainName(a.title);
  if (!role || role !== plainName(b.title)) return false;
  return sameSpell(a, b);
}

const INSTRUCTIONS = `
You are given the jobs already on somebody's profile and some jobs being
imported from a document of theirs. Say which of the incoming ones are the
same job as one already there.

The same job means the same employer, the same position, over the same
stretch of time. A company written differently is still one company:
"University of Washington" and "University of Washington (Genome Sciences)"
are the same employer, and so are "Meta" and "Facebook".

These are not duplicates, and each of them will look like one:

- Two different positions at one employer. A research assistant and a
  lecturer at the same university are two jobs, even in the same years.
- The same position at one employer in different years. Three summer
  internships at the same lab are three jobs, not one listed three times.
- A promotion listed as its own entry.

If you are not sure, say it is not a duplicate. A duplicate that gets through
is a second row on a page and one click to remove; a wrong match deletes work
somebody did, and they may not notice for months.

Reply with JSON only: [{"incoming": 0, "same_as": 12}] for each incoming job
that is already on file, naming the id of the one it repeats. Leave out
everything else.
`.trim();

export const DEDUPE_MODEL = process.env.JOBSEARCH_DEDUPE_MODEL ?? "claude-haiku-5-5";

const describe = (job: Job) =>
  `${job.company} — ${job.title}` +
  (job.start_date || job.end_date
    ? ` (${job.start_date ?? "?"}–${job.end_date ?? "present"})`
    : "");

/**
 * Which incoming jobs repeat one already on file.
 *
 * Returns incoming index to existing id. The plain matches are settled first
 * and for nothing; what is left goes to one call for the whole list, and a
 * failed or unavailable call leaves only the plain matches — which imports a
 * duplicate rather than losing a job, the right way round to be wrong.
 */
export async function duplicates(
  incoming: Job[],
  existing: (Job & { id: number })[],
): Promise<Map<number, number>> {
  const found = new Map<number, number>();
  if (incoming.length === 0 || existing.length === 0) return found;

  const unsettled: { job: Job; at: number }[] = [];
  incoming.forEach((job, at) => {
    const plain = existing.find((had) => plainlySame(job, had));
    if (plain) found.set(at, plain.id);
    else unsettled.push({ job, at });
  });
  if (unsettled.length === 0) return found;

  try {
    /*
      Inside the try with the rest of it. Everything from here on is an
      improvement on the plain matches, and nothing from here on should be
      able to stop an import — including reading the credential.
    */
    const credential = await readCredential();
    if (!credential) return found;

    let text = "";
    for await (const message of query({
      prompt:
        `ALREADY ON FILE\n${existing.map((job) => `[${job.id}] ${describe(job)}`).join("\n")}` +
        `\n\nBEING IMPORTED\n${unsettled.map((one, index) => `[${index}] ${describe(one.job)}`).join("\n")}`,
      options: {
        model: DEDUPE_MODEL,
        cwd: DATA_DIR,
        systemPrompt: INSTRUCTIONS,
        tools: [],
        settingSources: [],
        maxTurns: 1,
        env: credentialEnv(credential),
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") text += block.text;
        }
      }
      if (message.type === "result" && message.subtype !== "success") return found;
    }

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return found;
    const replies = JSON.parse(match[0]) as { incoming?: unknown; same_as?: unknown }[];
    if (!Array.isArray(replies)) return found;

    const ids = new Set(existing.map((job) => job.id));
    for (const reply of replies) {
      const index = typeof reply.incoming === "number" ? reply.incoming : -1;
      const sameAs = typeof reply.same_as === "number" ? reply.same_as : -1;
      const entry = unsettled[index];
      /* An id nothing is stored under is not a match, it is an invented one. */
      if (entry && ids.has(sameAs)) found.set(entry.at, sameAs);
    }
  } catch (error) {
    console.log(
      `[onboard] could not check for repeated jobs: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return found;
}

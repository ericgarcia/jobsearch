import { SOURCES } from "./index.js";

/**
 * Find a company's job board from its name.
 *
 * Adding a board by hand means knowing which applicant tracking system a
 * company uses and what it calls itself inside that system — neither of which
 * is on the careers page. Both are guessable: the token is almost always the
 * company name with the punctuation removed, so try the likely spellings
 * against each board's API and see which one answers.
 */

export interface Detected {
  ats: string;
  board_token: string;
  /** How many postings the board returned, as evidence it is the right one. */
  jobs: number;
  sample: string[];
}

/** The spellings a company is likely to use as its board token. */
export function candidateTokens(name: string): string[] {
  const lower = name.trim().toLowerCase();
  const stripped = lower
    // Drop the legal suffixes that are never in a board token.
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|labs?|technologies|technology)\b/g, " ")
    .trim();

  const squashed = stripped.replace(/[^a-z0-9]/g, "");
  const hyphenated = stripped.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const full = lower.replace(/[^a-z0-9]/g, "");

  return [...new Set([squashed, hyphenated, full].filter((token) => token.length >= 2))];
}

/**
 * Try one token against one board. Returns null for anything but a real board
 * with postings on it, so an empty or wrong board is not reported as a find.
 */
async function probe(ats: string, token: string): Promise<Detected | null> {
  const source = SOURCES[ats];
  if (!source) return null;

  try {
    const jobs = await source.fetchBoard(token);
    if (jobs.length === 0) return null;
    return {
      ats,
      board_token: token,
      jobs: jobs.length,
      sample: jobs.slice(0, 3).map((job) => job.title),
    };
  } catch {
    // A miss is the normal case: most tokens are wrong on most boards.
    return null;
  }
}

/**
 * Work out which board a company uses, if any of the three have it.
 * Every token is tried against every board at once, and the board with the
 * most postings wins when more than one answers.
 */
export async function detectBoard(name: string): Promise<Detected | null> {
  const tokens = candidateTokens(name);
  const attempts: Promise<Detected | null>[] = [];

  for (const ats of Object.keys(SOURCES)) {
    for (const token of tokens) attempts.push(probe(ats, token));
  }

  const found = (await Promise.all(attempts)).filter((hit): hit is Detected => hit !== null);
  if (found.length === 0) return null;

  found.sort((a, b) => b.jobs - a.jobs);
  return found[0]!;
}

/** Detect several companies at once, a few at a time to stay polite. */
export async function detectMany(
  names: string[],
): Promise<{ name: string; found: Detected | null }[]> {
  const results: { name: string; found: Detected | null }[] = [];
  const batch = 4;

  for (let i = 0; i < names.length; i += batch) {
    const slice = names.slice(i, i + batch);
    results.push(
      ...(await Promise.all(
        slice.map(async (name) => ({ name, found: await detectBoard(name) })),
      )),
    );
  }
  return results;
}

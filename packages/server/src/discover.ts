import { getSource } from "./sources/index.js";
import { detectBoard } from "./sources/detect.js";
import { buildScorer, corpusBest, finalScore, rawScore } from "./matching.js";
import { expandPlace, locationMatches } from "./location.js";
import { homeLocation } from "./settings.js";
import * as repo from "./repo.js";

/**
 * Look at a company's board before following it.
 *
 * Adding a company and then discovering it posts nothing you want is a waste
 * of a sync and clutters the list. This fetches the board, scores every
 * posting against the same terms the ranked list uses, and reports what it
 * found — without writing anything. The decision to follow is then made on
 * evidence rather than on a guess about what the company hires for.
 *
 * Scores are scaled against the best match in the stored corpus, so a company
 * evaluated here is measured by the same bar as everything already followed.
 * Normalising each batch against itself would make every company look perfect.
 */

export interface Hit {
  title: string;
  location: string | null;
  remote: boolean;
  url: string;
  score: number;
}

export interface Evaluation {
  name: string;
  ats: string | null;
  board_token: string | null;
  /** Everything on the board. */
  total: number;
  /** How many survive the location filter. */
  in_scope: number;
  /** How many score at or above the bar. */
  matching: number;
  best_score: number;
  top: Hit[];
  already_followed: boolean;
  error?: string;
}

export interface EvaluateOptions {
  /** Cities to accept. Omitted means where the person lives; "" means anywhere. */
  location?: string;
  includeRemote?: boolean;
  /** The score a posting must reach to count as a match. */
  threshold?: number;
  perCompany?: number;
}

async function evaluateOne(
  name: string,
  options: EvaluateOptions,
  scorer: ReturnType<typeof buildScorer>,
  best: number,
  followed: Set<string>,
): Promise<Evaluation> {
  const empty: Evaluation = {
    name,
    ats: null,
    board_token: null,
    total: 0,
    in_scope: 0,
    matching: 0,
    best_score: 0,
    top: [],
    already_followed: false,
  };

  const found = await detectBoard(name);
  if (!found) return { ...empty, error: "no board found" };

  const key = `${found.ats}:${found.board_token}`;
  let jobs;
  try {
    jobs = await getSource(found.ats).fetchBoard(found.board_token, name);
  } catch (error) {
    return {
      ...empty,
      ats: found.ats,
      board_token: found.board_token,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const places =
    options.location === undefined ? (homeLocation() ?? "") : options.location;
  const wanted = places
    .split(",")
    .map((place) => place.trim())
    .filter(Boolean)
    .flatMap(expandPlace);

  const inScope = jobs.filter((job) => {
    if (wanted.length === 0) return true;
    if (wanted.some((place) => locationMatches(job.location, place))) return true;
    return options.includeRemote === true && job.remote;
  });

  const threshold = options.threshold ?? 40;
  const scored: Hit[] = inScope
    .map((job) => {
      const raw = rawScore(scorer, job.title, job.description ?? "");
      return {
        title: job.title,
        location: job.location,
        remote: job.remote,
        url: job.url,
        score: finalScore(scorer, raw.total, best, job.title, job.description ?? ""),
      };
    })
    .sort((a, b) => b.score - a.score);

  return {
    name,
    ats: found.ats,
    board_token: found.board_token,
    total: jobs.length,
    in_scope: inScope.length,
    matching: scored.filter((hit) => hit.score >= threshold).length,
    best_score: scored[0]?.score ?? 0,
    top: scored.slice(0, options.perCompany ?? 5),
    already_followed: followed.has(key),
  };
}

/**
 * Evaluate several companies at once. Nothing is written: the caller decides
 * which, if any, to follow.
 */
export async function evaluateCompanies(
  names: string[],
  options: EvaluateOptions = {},
): Promise<Evaluation[]> {
  const scorer = buildScorer();
  if (scorer.keywords.length === 0) {
    throw new Error(
      "There is nothing to match against. Add roles to the profile, or say what you are looking for under interests.",
    );
  }

  const best = corpusBest();
  if (best === 0) {
    throw new Error("Rank the stored postings first, so there is a scale to measure against.");
  }

  const followed = new Set(
    repo.listCompanies().map((company) => `${company.ats}:${company.board_token}`),
  );

  const results: Evaluation[] = [];
  const batch = 3;
  for (let i = 0; i < names.length; i += batch) {
    results.push(
      ...(await Promise.all(
        names
          .slice(i, i + batch)
          .map((name) => evaluateOne(name, options, scorer, best, followed)),
      )),
    );
  }

  // Most promising first, so a long list reads top-down.
  results.sort((a, b) => b.matching - a.matching || b.best_score - a.best_score);
  return results;
}

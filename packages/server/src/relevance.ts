import { buildScorer, corpusBest, finalScore, rawScore, type Scorer } from "./matching.js";
import { expandPlace, locationMatches } from "./location.js";
import { homeLocation, matchBar } from "./settings.js";

/**
 * Whether a posting is worth keeping, decided in one place.
 *
 * There were two answers to this and they disagreed. evaluate_companies
 * scored a board, applied a location filter and a threshold, and reported
 * "2,400 postings, 12 match you". Following the company then stored all
 * 2,400, because sync had no opinion about relevance at all — so the number
 * the person agreed to and the number they got were different, and the job
 * list filled up with roles nobody would ever read.
 *
 * Now both ask here. What evaluate promises is what sync stores.
 *
 * The bar is deliberately about what comes *in*. Nothing stored is removed
 * when the bar moves: a posting already in the list may be tracked, drafted
 * for, or simply remembered, and a change of interests is not a reason to
 * take it away.
 */

export interface BarOptions {
  /** Cities to accept. Omitted means where the person lives; "" means anywhere. */
  location?: string;
  includeRemote?: boolean;
  /** The score a posting must reach. */
  threshold?: number;
}

export interface Bar {
  scorer: Scorer;
  best: number;
  places: string[];
  includeRemote: boolean;
  threshold: number;
  /**
   * Whether the score means anything yet.
   *
   * It does not when the profile has no keywords, and it does not before
   * anything has been ranked, because a score is scaled against the best
   * match in the corpus and there is no best match yet. In both cases the
   * honest answer is to keep everything: a filter that cannot judge must not
   * quietly throw a whole board away.
   */
  canJudge: boolean;
}

export async function buildBar(options: BarOptions = {}): Promise<Bar> {
  const [scorer, best, home, stored] = await Promise.all([
    buildScorer(),
    corpusBest(),
    options.location === undefined ? homeLocation() : Promise.resolve(options.location),
    matchBar(),
  ]);

  const places = (home ?? "")
    .split(",")
    .map((place) => place.trim())
    .filter(Boolean)
    .flatMap(expandPlace);

  return {
    scorer,
    best,
    places,
    /*
      Remote is in scope unless a caller says otherwise. Remote work is
      reachable from wherever the person lives, and defaulting it off made
      the evaluation stricter than the sync that followed it — so a board
      stored postings the evaluation had not counted.
    */
    includeRemote: options.includeRemote !== false,
    threshold: options.threshold ?? stored,
    canJudge: scorer.keywords.length > 0 && best > 0,
  };
}

export interface Postable {
  title: string;
  location: string | null;
  remote: boolean;
  description?: string | null;
}

/** Somewhere the person would work. */
export function inScope(bar: Bar, job: Postable): boolean {
  if (bar.places.length === 0) return true;
  if (bar.places.some((place) => locationMatches(job.location, place))) return true;
  return bar.includeRemote && job.remote;
}

export function scoreOf(bar: Bar, job: Postable): number {
  const raw = rawScore(bar.scorer, job.title, job.description ?? "");
  return finalScore(bar.scorer, raw.total, bar.best, job.title, job.description ?? "");
}

/** Worth putting in front of the person at all. */
export function clears(bar: Bar, job: Postable): boolean {
  if (!inScope(bar, job)) return false;
  if (!bar.canJudge) return true;
  return scoreOf(bar, job) >= bar.threshold;
}

/** Why a board was not filtered, in words the agent can pass on. */
export function cannotJudge(bar: Bar): string | null {
  if (bar.canJudge) return null;
  if (bar.scorer.keywords.length === 0) {
    return "The profile is empty, so postings cannot be scored. Everything on the board was kept.";
  }
  return "Nothing has been ranked yet, so there is no scale to score against. Everything on the board was kept — run rank_jobs, then sync again to apply the filter.";
}

import { db } from "./db/client.js";
import * as profile from "./profile.js";
import { getInterests } from "./interests.js";

/**
 * Rank every posting against the stored profile.
 *
 * This is deliberately arithmetic, not judgement. It runs over all 2,000-odd
 * postings in well under a second and costs nothing, so its job is to decide
 * which handful are worth the agent actually reading. The agent's own score
 * lives in job_assessments and always takes precedence.
 *
 * It was written because the job list had no ranking at all: postings came back
 * in the order they were fetched, which looked like relevance and was not.
 */

/** The score the best match in the corpus receives. See rankAllJobs. */
const BEST_MATCH = 65;

/** Terms too short or too common to mean anything on their own. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "our", "you", "your", "team", "work", "role",
  "new", "all", "can", "will", "has", "have", "job", "are", "who", "from",
  "this", "that", "they", "them", "its", "about", "into", "out", "per", "end",
]);

/**
 * Titles that are wrong for an experienced person however well the words match.
 * A PhD ML engineer matches "PhD Machine Learning Engineer, Intern" almost
 * perfectly on keywords, which is exactly why keywords alone are not a ranking.
 */
const JUNIOR_TITLE =
  /\b(intern|internship|co-?op|new ?grad|graduate program|apprentice|trainee|entry[- ]level|junior|assistant professor)\b/i;

/** Titles that signal the level this profile is actually at. */
const SENIOR_TITLE =
  /\b(staff|senior|sr\.?|principal|lead|head|chief|director|founder|cto|vp|distinguished|architect)\b/i;

/**
 * Does the profile show someone past junior roles? Either a senior title, or
 * enough years since the earliest recorded role.
 */
export function profileIsSenior(): boolean {
  const roles = profile.listRoles();
  if (roles.some((role) => SENIOR_TITLE.test(role.title))) return true;

  const starts = roles
    .map((role) => Number((role.start_date ?? "").slice(0, 4)))
    .filter((year) => year > 1900);
  if (starts.length === 0) return false;
  return new Date().getFullYear() - Math.min(...starts) >= 8;
}

export interface Keyword {
  term: string;
  /** How much a hit is worth. Skills the person listed count for more. */
  weight: number;
}

/** Build the term list from the profile: skills, bullet skills, role titles. */
export function profileKeywords(): Keyword[] {
  const weights = new Map<string, number>();

  const add = (raw: string, weight: number) => {
    const term = raw.trim().toLowerCase();
    if (term.length < 3 || STOPWORDS.has(term)) return;
    weights.set(term, Math.max(weights.get(term) ?? 0, weight));
  };

  /*
    Chosen terms outweigh inferred ones. What the person says they want is
    better evidence than what their last job happened to involve, and without
    this a career move is ranked against the career being left.
  */
  const interests = getInterests();
  for (const title of interests.titles) {
    for (const word of title.split(/[^A-Za-z0-9+#.]+/)) add(word, 5);
  }
  for (const topic of interests.include) add(topic, 4);

  // Skills the person listed by hand.
  for (const skill of profile.listSkills()) add(skill.name, 3);

  // Skills tagged on individual achievements.
  for (const bullet of profile.listBullets()) {
    for (const skill of JSON.parse(bullet.skills) as string[]) add(skill, 2);
  }

  // Words from role titles, which carry seniority and discipline.
  for (const role of profile.listRoles()) {
    for (const word of role.title.split(/[^A-Za-z+#.]+/)) add(word, 2);
  }

  return [...weights].map(([term, weight]) => ({ term, weight }));
}

/** Word-boundary match, so "go" does not hit "going" and "r" hits nothing. */
function mentions(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9+#])${escaped}(?![A-Za-z0-9+#])`, "i").test(haystack);
}

export interface MatchResult {
  scored: number;
  top: { id: number; company: string; title: string; score: number }[];
}

/**
 * Score every posting and store the result.
 * A term found in the title counts for three times a term found in the body.
 */
export function rankAllJobs(): MatchResult {
  const scorer = buildScorer();
  if (scorer.keywords.length === 0) {
    throw new Error("The profile is empty, so there is nothing to match against.");
  }

  const jobs = db
    .prepare(`SELECT id, company, title, COALESCE(description, '') AS description FROM jobs`)
    .all() as { id: number; company: string; title: string; description: string }[];

  /*
    Scores are normalised against the best match in this corpus, not against a
    theoretical maximum of every term appearing in one title. That maximum is
    unreachable, so normalising against it squashed every posting into the
    bottom of the range while an assessed score runs 0-100 — and any posting
    already read and scored above that ceiling outranked every unread posting
    forever, however well it matched.

    The best match scores BEST_MATCH, deliberately below the top of the
    assessed range: keyword overlap is evidence that a posting deserves
    reading, never evidence that it is a strong fit.
  */
  const raw = new Map<number, { total: number; matched: string[] }>();
  for (const job of jobs) {
    raw.set(job.id, rawScore(scorer, job.title, job.description));
  }

  const best = Math.max(1, ...[...raw.values()].map((entry) => entry.total));

  // Remembered so a company being evaluated is scaled against the same bar.
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('match_best_raw', ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(String(best));

  const upsert = db.prepare(
    `INSERT INTO job_match (job_id, score, matched, scored_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (job_id) DO UPDATE SET
       score = excluded.score, matched = excluded.matched, scored_at = excluded.scored_at`,
  );

  const write = db.transaction(() => {
    for (const job of jobs) {
      const entry = raw.get(job.id)!;
      const score = finalScore(scorer, entry.total, best, job.title, job.description);
      upsert.run(job.id, score, JSON.stringify(entry.matched.slice(0, 20)));
    }
  });
  write();

  const top = db
    .prepare(
      `SELECT j.id, j.company, j.title, m.score
         FROM job_match m JOIN jobs j ON j.id = m.job_id
        ORDER BY m.score DESC, j.posted_at DESC LIMIT 10`,
    )
    .all() as MatchResult["top"];

  return { scored: jobs.length, top };
}

export function matchFor(jobId: number) {
  const row = db.prepare(`SELECT score, matched, scored_at FROM job_match WHERE job_id = ?`).get(jobId) as
    | { score: number; matched: string; scored_at: string }
    | undefined;
  return row ? { ...row, matched: JSON.parse(row.matched) as string[] } : null;
}

/** Everything scoring needs, built once per run. */
export interface Scorer {
  keywords: Keyword[];
  senior: boolean;
  avoid: string[];
}

export function buildScorer(): Scorer {
  return {
    keywords: profileKeywords(),
    senior: profileIsSenior(),
    avoid: getInterests()
      .exclude.map((term) => term.trim().toLowerCase())
      .filter(Boolean),
  };
}

/** The raw weighted overlap for one posting, before scaling. */
export function rawScore(
  scorer: Scorer,
  title: string,
  description: string,
): { total: number; matched: string[] } {
  let total = 0;
  const matched: string[] = [];
  for (const { term, weight } of scorer.keywords) {
    const inTitle = mentions(title, term);
    const inBody = !inTitle && mentions(description, term);
    if (!inTitle && !inBody) continue;
    total += weight * (inTitle ? 3 : 1);
    matched.push(term);
  }
  return { total, matched };
}

/** Scale a raw score onto the shared 0-65 range and apply the corrections. */
export function finalScore(
  scorer: Scorer,
  raw: number,
  best: number,
  title: string,
  description: string,
): number {
  let score = Math.round(BEST_MATCH * Math.sqrt(raw / Math.max(1, best)));

  if (scorer.senior && JUNIOR_TITLE.test(title)) score = Math.round(score * 0.2);
  else if (scorer.senior && SENIOR_TITLE.test(title)) score = Math.min(BEST_MATCH, score + 5);

  const lowerTitle = title.toLowerCase();
  const lowerBody = description.toLowerCase();
  if (scorer.avoid.some((term) => lowerTitle.includes(term))) score = Math.round(score * 0.15);
  else if (scorer.avoid.some((term) => lowerBody.includes(term))) score = Math.round(score * 0.7);

  return score;
}

/**
 * The best raw score in the stored corpus, remembered so a company being
 * evaluated is scaled the same way as everything already followed. Without it
 * each batch would be normalised against itself and always look like a
 * perfect match.
 */
export function corpusBest(): number {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'match_best_raw'`).get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

import { db } from "./db/client.js";
import * as profile from "./profile.js";

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

  // Skills the person listed by hand are the strongest signal.
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
  const keywords = profileKeywords();
  if (keywords.length === 0) {
    throw new Error("The profile is empty, so there is nothing to match against.");
  }

  const jobs = db
    .prepare(`SELECT id, company, title, COALESCE(description, '') AS description FROM jobs`)
    .all() as { id: number; company: string; title: string; description: string }[];

  // The best possible score, used to normalise onto 0-100.
  const ceiling = keywords.reduce((total, k) => total + k.weight * 3, 0);
  const senior = profileIsSenior();

  const upsert = db.prepare(
    `INSERT INTO job_match (job_id, score, matched, scored_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (job_id) DO UPDATE SET
       score = excluded.score, matched = excluded.matched, scored_at = excluded.scored_at`,
  );

  const write = db.transaction(() => {
    for (const job of jobs) {
      let raw = 0;
      const matched: string[] = [];

      for (const { term, weight } of keywords) {
        const inTitle = mentions(job.title, term);
        const inBody = !inTitle && mentions(job.description, term);
        if (!inTitle && !inBody) continue;
        raw += weight * (inTitle ? 3 : 1);
        matched.push(term);
      }

      // Square-root curve: a job matching 20 terms is better than one matching
      // 10, but not twice as good, and nothing reaches 100 on keywords alone.
      let score = Math.round(Math.min(100, 100 * Math.sqrt(raw / ceiling)));

      // Level, which keywords cannot see. Pushed down rather than hidden, so
      // the posting is still there if the person goes looking for it.
      if (senior && JUNIOR_TITLE.test(job.title)) score = Math.round(score * 0.2);
      else if (senior && SENIOR_TITLE.test(job.title)) score = Math.min(100, score + 8);
      upsert.run(job.id, score, JSON.stringify(matched.slice(0, 20)));
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

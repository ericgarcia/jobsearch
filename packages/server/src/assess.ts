import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "./config.js";
import { db } from "./db/client.js";
import { credentialEnv, homeLocation, readCredential } from "./settings.js";
import { expandPlace } from "./location.js";
import * as profile from "./profile.js";
import * as repo from "./repo.js";

/**
 * Judge a batch of postings against the profile.
 *
 * This is not the conversational agent. Reading a posting and scoring it is a
 * judgement about one document, not an open-ended task, so it runs as a small
 * single-shot call per posting on a cheap model. At the time of writing that is
 * roughly forty times cheaper than the model the chat uses, which is what makes
 * it reasonable to score a whole shortlist rather than a handful.
 *
 * The keyword match (matching.ts) decides what gets read. This decides whether
 * it is any good.
 */

export const ASSESS_MODEL = process.env.JOBSEARCH_ASSESS_MODEL ?? "claude-haiku-5-5";

const CONCURRENCY = Number(process.env.JOBSEARCH_ASSESS_CONCURRENCY ?? 4);

/** The profile as compact prose, built once and reused for the whole batch. */
function profileBrief(): string {
  const me = profile.getProfile();
  const bullets = profile.listBullets();

  const roles = profile
    .listRoles()
    .map((role) => {
      const dates = [role.start_date, role.end_date ?? "present"].filter(Boolean).join("–");
      const lines = bullets
        .filter((bullet) => bullet.role_id === role.id)
        .map((bullet) => `  - ${bullet.text}`)
        .join("\n");
      return `${role.title}, ${role.company} (${dates})\n${lines}`;
    })
    .join("\n\n");

  const education = profile
    .listEducation()
    .map((item) => `${item.degree ?? ""} ${item.field ?? ""}, ${item.school} ${item.end_date ?? ""}`)
    .join("; ");

  return [
    me.headline ? `Headline: ${me.headline}` : "",
    me.location ? `Location: ${me.location}` : "",
    me.summary ? `Summary: ${me.summary}` : "",
    "",
    "EXPERIENCE",
    roles,
    "",
    `EDUCATION: ${education}`,
    `SKILLS: ${profile.listSkills().map((s) => s.name).join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const INSTRUCTIONS = `
You judge how well one job posting fits one person. You are given their whole
profile and the posting.

Score 0-100:
  0-29   wrong discipline, or wrong level by a wide margin
  30-49  adjacent; they could argue for it but the posting asks for something
         the profile does not show
  50-69  a real fit with a named gap
  70-84  a strong fit; the profile evidences most of what the posting asks
  85-100 they are close to the stated ideal

Rules:
- Judge against what the profile actually records. Do not assume unstated
  experience, and do not credit a requirement the profile cannot evidence.
- Level matters as much as subject. A senior person in a junior posting is a
  poor fit, and so is the reverse.
- Name the single biggest gap, in plain words, even on a high score.

Reply with JSON only, no prose around it:
{"fit_score": <0-100>, "reasoning": "<two or three sentences citing the posting and the profile>", "biggest_gap": "<one sentence, or empty if there is none>"}
`.trim();

interface Verdict {
  fit_score: number;
  reasoning: string;
  biggest_gap?: string;
}

function parseVerdict(text: string): Verdict | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Verdict;
    if (typeof parsed.fit_score !== "number" || typeof parsed.reasoning !== "string") return null;
    return { ...parsed, fit_score: Math.max(0, Math.min(100, Math.round(parsed.fit_score))) };
  } catch {
    return null;
  }
}

async function assessOne(
  job: repo.JobWithStatus,
  brief: string,
  env: Record<string, string>,
): Promise<{ id: number; score: number | null; cost: number; error?: string }> {
  const posting = [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    job.location ? `Location: ${job.location}${job.remote === 1 ? " (remote)" : ""}` : "",
    "",
    (job.description ?? "").slice(0, 14000),
  ]
    .filter(Boolean)
    .join("\n");

  let text = "";
  let cost = 0;

  try {
    for await (const message of query({
      prompt: `PROFILE\n${brief}\n\nPOSTING\n${posting}`,
      options: {
        model: ASSESS_MODEL,
        cwd: DATA_DIR,
        systemPrompt: INSTRUCTIONS,
        tools: [],
        settingSources: [],
        maxTurns: 1,
        env,
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") text += block.text;
        }
      }
      if (message.type === "result") {
        cost = message.total_cost_usd ?? 0;
        if (message.subtype !== "success") {
          return { id: job.id, score: null, cost, error: `stopped: ${message.subtype}` };
        }
      }
    }
  } catch (error) {
    return { id: job.id, score: null, cost, error: error instanceof Error ? error.message : String(error) };
  }

  const verdict = parseVerdict(text);
  if (!verdict) return { id: job.id, score: null, cost, error: "could not parse a verdict" };

  const reasoning = verdict.biggest_gap
    ? `${verdict.reasoning} Biggest gap: ${verdict.biggest_gap}`
    : verdict.reasoning;

  db.prepare(
    `INSERT INTO job_assessments (job_id, fit_score, reasoning, model, assessed_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (job_id) DO UPDATE SET
       fit_score = excluded.fit_score, reasoning = excluded.reasoning,
       model = excluded.model, assessed_at = excluded.assessed_at`,
  ).run(job.id, verdict.fit_score, reasoning, ASSESS_MODEL);

  return { id: job.id, score: verdict.fit_score, cost };
}

export interface AssessReport {
  model: string;
  /** The places the batch was limited to, so the caller can report it. */
  places: string[];
  assessed: number;
  failed: number;
  cost_usd: number;
  results: { id: number; company: string; title: string; score: number | null; error?: string }[];
}

/**
 * Assess the best-matching postings that have not been judged yet.
 * Runs a few at a time so a batch of twenty does not take twenty round trips.
 */
export interface AssessOptions {
  limit?: number;
  /** Cities to stay within. Omitted means where the person lives; "" means everywhere. */
  location?: string;
  includeRemote?: boolean;
}

export async function assessTopJobs(options: AssessOptions = {}): Promise<AssessReport> {
  const limit = options.limit ?? 20;
  const credential = readCredential();
  if (!credential) throw new Error("No Claude credential is set up yet.");
  if (profile.isEmpty()) throw new Error("The profile is empty, so there is nothing to judge against.");

  // Judge what the person is actually looking at. Scoring postings that their
  // location filter excludes spends money on jobs they will never see.
  const places = options.location === undefined ? (homeLocation() ?? "") : options.location;
  const locationAny = places
    .split(",")
    .map((place) => place.trim())
    .filter(Boolean)
    .flatMap(expandPlace);

  // Filter in the query, not afterwards: taking the top N and then dropping
  // the ones already judged returns fewer than asked for.
  const jobs = repo.searchJobs({
    unassessedOnly: true,
    locationAny: locationAny.length > 0 ? locationAny : undefined,
    includeRemote: options.includeRemote ?? false,
    limit: Math.min(Math.max(limit, 1), 100),
  });

  if (jobs.length === 0) {
    return { model: ASSESS_MODEL, places: locationAny, assessed: 0, failed: 0, cost_usd: 0, results: [] };
  }

  const brief = profileBrief();
  const env = credentialEnv(credential);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const results: AssessReport["results"] = [];
  let cost = 0;
  let failed = 0;

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map((job) => assessOne(job, brief, env)));
    for (const outcome of settled) {
      const job = byId.get(outcome.id)!;
      cost += outcome.cost;
      if (outcome.error) failed += 1;
      results.push({
        id: job.id,
        company: job.company,
        title: job.title,
        score: outcome.score,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    }
  }

  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return {
    model: ASSESS_MODEL,
    places: locationAny,
    assessed: results.length - failed,
    failed,
    cost_usd: Number(cost.toFixed(4)),
    results,
  };
}

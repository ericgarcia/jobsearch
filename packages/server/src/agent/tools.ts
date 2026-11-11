import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as repo from "../repo.js";
import { STATUSES } from "../status.js";
import { syncBoards } from "../sync.js";
import { rankAllJobs } from "../matching.js";
import { expandPlace } from "../location.js";
import { homeLocation } from "../settings.js";
import { assessTopJobs, ASSESS_MODEL } from "../assess.js";
import { SOURCES } from "../sources/index.js";
import { profileTools, PROFILE_MUTATING } from "./profileTools.js";
import { browserTools } from "./browserClient.js";
import { browserEnabled } from "./browserFlag.js";

/** Tool results go back as compact JSON. Claude reads these as exact fields. */
const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

async function guard<T>(run: () => T | Promise<T>) {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Trim a posting so one job does not swallow the context window. */
function truncate(text: string | null, max: number): string | null {
  if (text == null) return null;
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

/** The summary shape returned by list-style tools. Descriptions are left out. */
function summarise(job: repo.JobWithStatus) {
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    location: job.location,
    remote: job.remote === 1,
    url: job.url,
    posted_at: job.posted_at,
    status: job.status,
    fit_score: job.fit_score,
    match_score: job.match_score,
  };
}

/**
 * Turn what the agent asked for into the forms boards actually write.
 * No places named means the person's own city; "anywhere" means no filter.
 */
function resolvePlaces(places?: string[]): string[] | undefined {
  if (places?.some((place) => place.trim().toLowerCase() === "anywhere")) return undefined;

  const wanted = places && places.length > 0 ? places : [homeLocation() ?? ""].filter(Boolean);
  if (wanted.length === 0) return undefined;
  return wanted.flatMap(expandPlace);
}

const listCompanies = tool(
  "list_companies",
  "List the company job boards this app polls.",
  {},
  async () => guard(() => repo.listCompanies()),
  { annotations: { readOnlyHint: true } },
);

const addCompany = tool(
  "add_company",
  "Add a company job board to poll. The board token is the company's identifier in its ATS URL, for example 'anthropic' in boards.greenhouse.io/anthropic.",
  {
    name: z.string().describe("Display name of the company"),
    ats: z.enum(["greenhouse", "lever", "ashby"]).describe("Which applicant tracking system hosts the board"),
    board_token: z.string().describe("The board identifier in the ATS URL"),
  },
  async (args) => guard(() => repo.addCompany(args.name, args.ats, args.board_token)),
);

const syncBoardsTool = tool(
  "sync_boards",
  "Fetch the current postings from the company boards and store them. Run this before searching when the user wants fresh results. Returns how many postings were seen and how many were new.",
  {
    companies: z
      .array(z.string())
      .optional()
      .describe("Limit the sync to these company names. Omit to sync every active board."),
  },
  async (args) => guard(() => syncBoards(args.companies)),
);

const rankJobs = tool(
  "rank_jobs",
  "Score every stored posting against the profile by keyword overlap, so the list has an order that means something. This is arithmetic, not judgement: use it to decide which postings are worth reading, then read them and use assess_job for a real opinion. Run it after a sync, or after the profile changes.",
  {},
  async () => guard(() => rankAllJobs()),
);

const assessTop = tool(
  "assess_top_jobs",
  `Read and score the best-matching postings that have not been judged yet, on a cheaper model (${ASSESS_MODEL}). Use this to turn a keyword-ranked list into real opinions — it costs a few cents for twenty and takes a minute or so. Judge a single posting yourself with get_job and assess_job instead.`,
  {
    limit: z.number().int().min(1).max(50).optional().describe("How many to assess. Default 20."),
    location_any: z
      .array(z.string())
      .optional()
      .describe("Cities to stay within. Omit for where the person lives; [\"anywhere\"] for no limit."),
    include_remote: z.boolean().optional().describe("Also judge remote postings based elsewhere"),
  },
  async (args) =>
    guard(() => {
      const places = resolvePlaces(args.location_any);
      return assessTopJobs({
        limit: args.limit ?? 20,
        location: places === undefined ? "" : places.join(","),
        includeRemote: args.include_remote ?? false,
      });
    }),
);

const searchJobs = tool(
  "search_jobs",
  "Search stored postings. All filters are optional and combine with AND; the lists inside one filter combine with OR. Results come back highest fit score first, so assessed_only with no other filter lists everything you have scored. Returns summaries without the posting body — call get_job for the full text.",
  {
    title_any: z.array(z.string()).optional().describe("Match if the title contains any of these"),
    title_none: z.array(z.string()).optional().describe("Exclude if the title contains any of these"),
    text_any: z.array(z.string()).optional().describe("Match if the title or body contains any of these"),
    text_none: z.array(z.string()).optional().describe("Exclude if the title or body contains any of these"),
    company_any: z.array(z.string()).optional().describe("Limit to these companies"),
    location_any: z
      .array(z.string())
      .optional()
      .describe(
        "Cities to accept, for example [\"New York\"]. Short forms boards use are matched for you. Omit to use where the person lives; pass [\"anywhere\"] to drop the location filter entirely.",
      ),
    include_remote: z
      .boolean()
      .optional()
      .describe(
        "Also accept remote postings based in other cities. The person is not assumed to be open to this; ask if you do not know.",
      ),
    remote_only: z.boolean().optional().describe("Only postings marked remote"),
    status_any: z.array(z.enum(STATUSES)).optional().describe("Only jobs tracked at these statuses"),
    untracked_only: z.boolean().optional().describe("Only jobs with no application row yet"),
    unassessed_only: z
      .boolean()
      .optional()
      .describe("Only postings you have not scored yet"),
    assessed_only: z
      .boolean()
      .optional()
      .describe("Only jobs you have already scored with assess_job"),
    min_match_score: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("Only postings whose keyword match with the profile is at least this"),
    min_fit_score: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("Only jobs scored at or above this. Results always come back highest score first."),
    new_since: z.string().optional().describe("Only jobs first seen on or after this date, as YYYY-MM-DD"),
    limit: z.number().int().min(1).max(200).optional().describe("How many to return. Default 50."),
  },
  async (args) =>
    guard(() => {
      const jobs = repo.searchJobs({
        titleAny: args.title_any,
        titleNone: args.title_none,
        textAny: args.text_any,
        textNone: args.text_none,
        companyAny: args.company_any,
        locationAny: resolvePlaces(args.location_any),
        includeRemote: args.include_remote ?? false,
        remoteOnly: args.remote_only,
        statusAny: args.status_any,
        untrackedOnly: args.untracked_only,
        assessedOnly: args.assessed_only,
        unassessedOnly: args.unassessed_only,
        minFitScore: args.min_fit_score,
        minMatchScore: args.min_match_score,
        newSince: args.new_since,
        limit: args.limit,
      });
      return { count: jobs.length, jobs: jobs.map(summarise) };
    }),
  { annotations: { readOnlyHint: true } },
);

const getJob = tool(
  "get_job",
  "Read one posting in full, including the body text and any status history.",
  { job_id: z.number().int().describe("The job id from search_jobs") },
  async (args) =>
    guard(() => {
      const job = repo.getJob(args.job_id);
      if (!job) throw new Error(`No job with id ${args.job_id}`);
      return {
        ...summarise(job),
        reasoning: job.reasoning,
        description: truncate(job.description, 12000),
        history: repo.applicationHistory(job.id),
      };
    }),
  { annotations: { readOnlyHint: true } },
);

const assessJob = tool(
  "assess_job",
  "Record your judgement of how well a posting fits the user. Use this after reading a posting so the score survives the conversation.",
  {
    job_id: z.number().int(),
    fit_score: z.number().int().min(0).max(100).describe("0 = no fit, 100 = ideal fit"),
    reasoning: z.string().describe("Two or three sentences on why, naming the concrete evidence"),
  },
  async (args) =>
    guard(() => {
      repo.saveAssessment(args.job_id, args.fit_score, args.reasoning);
      return { job_id: args.job_id, fit_score: args.fit_score };
    }),
);

const trackJob = tool(
  "track_job",
  "Start tracking a job as an application, at status 'interested'. Idempotent.",
  { job_id: z.number().int(), note: z.string().optional() },
  async (args) => guard(() => repo.trackJob(args.job_id, args.note)),
);

const setStatus = tool(
  "set_status",
  "Move a tracked application to a new status. The status machine rejects a move it does not allow and tells you which moves are allowed.",
  {
    job_id: z.number().int(),
    status: z.enum(STATUSES),
    note: z.string().optional().describe("Why the status changed. Stored in the history."),
  },
  async (args) => guard(() => repo.setStatus(args.job_id, args.status, args.note)),
  { annotations: { destructiveHint: true } },
);

const listApplications = tool(
  "list_applications",
  "List tracked applications, newest change first.",
  { status_any: z.array(z.enum(STATUSES)).optional().describe("Limit to these statuses") },
  async (args) => guard(() => repo.listApplications(args.status_any)),
  { annotations: { readOnlyHint: true } },
);

const getStats = tool(
  "get_stats",
  "Count the stored postings and the applications at each status.",
  {},
  async () =>
    guard(() => ({ ...repo.stats(), sources: Object.keys(SOURCES) })),
  { annotations: { readOnlyHint: true } },
);

export const jobsearchServer = createSdkMcpServer({
  name: "jobsearch",
  version: "0.1.0",
  tools: [
    listCompanies,
    addCompany,
    syncBoardsTool,
    rankJobs,
    assessTop,
    searchJobs,
    getJob,
    assessJob,
    trackJob,
    setStatus,
    listApplications,
    getStats,
    ...profileTools,
    ...(browserEnabled ? browserTools : []),
  ],
});

/** Tools whose results change the stored data, so the UI should refetch. */
export const MUTATING_TOOLS = new Set([
  "mcp__jobsearch__add_company",
  "mcp__jobsearch__sync_boards",
  "mcp__jobsearch__rank_jobs",
  "mcp__jobsearch__assess_top_jobs",
  "mcp__jobsearch__assess_job",
  "mcp__jobsearch__track_job",
  "mcp__jobsearch__set_status",
  ...PROFILE_MUTATING,
]);

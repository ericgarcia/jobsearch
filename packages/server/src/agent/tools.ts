import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { currentState } from "../appState.js";
import { z } from "zod";
import * as repo from "../repo.js";
import { STATUSES } from "../status.js";
import { syncBoards } from "../sync.js";
import { rankAllJobs } from "../matching.js";
import { expandPlace } from "../location.js";
import { detectMany } from "../sources/detect.js";
import { evaluateCompanies } from "../discover.js";
import { getInterests, setInterests } from "../interests.js";
import { homeLocation, matchBar, setMatchBar } from "../settings.js";
import { importPosting } from "../importing.js";
import { formForJob } from "../apply/read.js";
import { describe as describeForm } from "../apply/form.js";
import { startApplication } from "../apply/start.js";
import { fillApplication } from "../apply/fill.js";
import { listAnswers, markApplied, recordAnswers } from "../apply/record.js";
import {
  coverage,
  listStandingAnswers,
  selfIdentificationKeysSet,
  setStandingAnswer,
} from "../apply/answers.js";
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
async function resolvePlaces(places?: string[]): Promise<string[] | undefined> {
  if (places?.some((place) => place.trim().toLowerCase() === "anywhere")) return undefined;

  const wanted =
    places && places.length > 0 ? places : [(await homeLocation()) ?? ""].filter(Boolean);
  if (wanted.length === 0) return undefined;
  return wanted.flatMap(expandPlace);
}

const getInterestsTool = tool(
  "get_interests",
  "Read what the person says they are looking for: the role titles they want, subjects to seek out, and subjects to avoid. This is what they want next, as opposed to the profile, which is what they have done. Matching weights these above anything read from their history.",
  {},
  async () => guard(async () => await getInterests()),
  { annotations: { readOnlyHint: true } },
);

const setInterestsTool = tool(
  "set_interests",
  "Record what the person is looking for. Use their own words. Only send the fields that change; sending a list replaces it.",
  {
    titles: z.array(z.string()).optional().describe('Role titles wanted, e.g. ["Staff Machine Learning Engineer"]'),
    include: z.array(z.string()).optional().describe("Subjects or technologies to seek out"),
    exclude: z.array(z.string()).optional().describe("Subjects to avoid. A posting whose title matches one is pushed right down."),
    note: z.string().optional().describe("Anything else about what they want, in their words"),
  },
  async (args) =>
    guard(async () => ({
      interests: await setInterests(args),
      note: "Run rank_jobs so the change takes effect on the stored postings.",
    })),
);

const evaluateCompaniesTool = tool(
  "evaluate_companies",
  "Look at companies' job boards WITHOUT following them, and report how many of their postings match what the person wants. Use this to decide which companies are worth following, then add_companies for the ones that are. Propose candidate names yourself from what you know of the person's field — there is no way to search every board, so the names have to come from somewhere, and saying where you got them is part of the answer.",
  {
    names: z.array(z.string()).min(1).max(20).describe("Companies to look at"),
    location_any: z.array(z.string()).optional().describe('Cities to count. Omit for where they live; ["anywhere"] for no limit.'),
    include_remote: z.boolean().optional().describe("Also count remote postings based elsewhere"),
    threshold: z.number().int().min(0).max(100).optional().describe("Score a posting must reach to count as a match. Default 40."),
  },
  async (args) =>
    guard(async () => {
      const places = await resolvePlaces(args.location_any);
      return await evaluateCompanies(args.names, {
        location: places === undefined ? "" : places.join(","),
        includeRemote: args.include_remote ?? false,
        threshold: args.threshold,
      });
    }),
  { annotations: { readOnlyHint: true } },
);

const removeCompanyTool = tool(
  "remove_company",
  "Stop following a board. Say whether to delete the postings it already fetched: left behind, they stay in the list and rank, and nothing ever refreshes them again. Postings being pursued or drafted for are always kept, however this is called. Check with list_companies first so you name the right one, and tell the person how many postings go.",
  {
    id: z.number().int().describe("The company id from list_companies"),
    delete_postings: z
      .boolean()
      .describe("True to delete its stored postings. Ask the person before sending true."),
  },
  async (args) => guard(async () => await repo.removeCompany(args.id, args.delete_postings)),
);

const listCompanies = tool(
  "list_companies",
  "List the company job boards this app polls.",
  {},
  async () => guard(async () => await repo.listCompanies()),
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
  async (args) => guard(async () => await repo.addCompany(args.name, args.ats, args.board_token)),
);

const addCompaniesByName = tool(
  "add_companies",
  "Add companies to follow by name alone. Works out which applicant tracking system each one uses and what its board is called, then stores the ones it finds. Tell the person which companies could not be found: they may use a system this app does not read, or post only on their own site.",
  {
    names: z.array(z.string()).min(1).describe("Company names, for example [\"Figma\", \"Ramp\"]"),
  },
  async (args) =>
    guard(async () => {
      const found = await detectMany(args.names);
      for (const row of found) {
        if (row.found) await repo.addCompany(row.name, row.found.ats, row.found.board_token);
      }
      return {
        added: found.filter((row) => row.found).map((row) => ({
          name: row.name,
          ats: row.found!.ats,
          board_token: row.found!.board_token,
          jobs: row.found!.jobs,
        })),
        not_found: found.filter((row) => !row.found).map((row) => row.name),
        note: "Run sync_boards next to fetch the postings, then rank_jobs.",
      };
    }),
);

const importPostingTool = tool(
  "import_posting",
  "Bring one posting into the job list from wherever the person found it — a LinkedIn listing, a link someone sent them, the page open in the pane beside the app. Give the posting's own URL when it is already on greenhouse, lever or ashby; otherwise give the company and the role title, and this finds the company's own board and the posting on it. The canonical posting is the one worth storing: it can be applied to, it stays up to date, and it ranks against everything else. A posting imported this way is kept whatever it scores, because they asked for it by name. When it answers with candidates it was not sure which posting is meant — show them and ask, never pick one. Set follow to also subscribe to that company's board, which brings in its other matching roles on the next sync.",
  {
    url: z.string().optional().describe("The posting's URL, from any site"),
    company: z.string().optional().describe("The company, when the URL is not a board we read"),
    title: z.string().optional().describe("The role title, as the other site gives it"),
    follow: z
      .boolean()
      .optional()
      .describe("Also follow the company's board. Ask first for a large company."),
  },
  async (args) => guard(async () => await importPosting(args)),
);

const applicationFormTool = tool(
  "application_form",
  "What a job's application will ask for, read from the board without opening a browser. Answers with every field, whether it is required, and who the answer belongs to: identity and link fields come from the profile, documents are the resume and cover letter this app produces, standing fields are the ones that are the same at every company and are legally significant — work authorization, sponsorship, relocation, notice, pay — custom fields are that employer's own questions, and eeo fields are voluntary self-identification. Use it to tell someone what an application needs before they start, or to compare several. Never answer an eeo field, and never infer one: they are the person's alone.",
  { job_id: z.number().int().describe("The job id, from search_jobs or a card") },
  async (args) =>
    guard(async () => {
      const form = await formForJob(args.job_id);
      return { ...form, summary: describeForm(form) };
    }),
  { annotations: { readOnlyHint: true } },
);

const standingAnswersTool = tool(
  "get_standing_answers",
  "What the person has already said about their situation — work authorisation, sponsorship, relocation, days in an office, notice, pay. These are the same at every company and are the answers to copy, never to work out: an agent inferring someone's right to work in a country from their history is guessing about something legally significant. Anything not stored here is a decision only they can make.",
  {},
  async () => guard(async () => ({ answers: await listStandingAnswers() })),
  { annotations: { readOnlyHint: true } },
);

const setStandingAnswerTool = tool(
  "set_standing_answer",
  "Store what they just told you about their situation, in their words, so no application has to ask again. Use the topic that fits: work_authorization, sponsorship, relocation, onsite, notice_period, start_date, salary — or your own short topic name for anything else. Only store what they actually said; an empty answer removes it.",
  {
    topic: z.string().describe("work_authorization, sponsorship, relocation, onsite, notice_period, start_date, salary, or your own"),
    answer: z.string().describe("Their answer, in their words"),
    question: z.string().optional().describe("The question it answers, if it is not one of the known topics"),
  },
  async (args) =>
    guard(async () => {
      await setStandingAnswer(args.topic, args.answer, args.question);
      return { answers: await listStandingAnswers() };
    }),
);

const selfIdStatusTool = tool(
  "self_identification_status",
  "Whether the person has stored answers for the voluntary self-identification questions — gender, race, veteran status, disability, pronouns. Answers with which of them are set and NEVER with a value: those are theirs, they are not sent to you, and you must not ask for them, infer them from a name or a history, or answer such a question on a form. When a form asks one, say it is voluntary and that stored answers are filled in without you seeing them.",
  {},
  async () =>
    guard(async () => ({
      stored: await selfIdentificationKeysSet(),
      note: "Values are never shown to the assistant. They are filled into forms by the app itself.",
    })),
  { annotations: { readOnlyHint: true } },
);

const startApplicationTool = tool(
  "start_application",
  "Begin applying for a job. Moves it to 'applying', reads the application form, finds anything already drafted for it, and hands back what is left to do in order. Call this first when someone decides to apply, rather than drafting straight away: a letter written before the form was read answers questions nobody asked, and a second resume written without reading the first quietly replaces their edits. It writes nothing and submits nothing — the resume and the letter are yours to draft afterwards, and the person sends the application themselves.",
  { job_id: z.number().int() },
  async (args) => guard(async () => await startApplication(args.job_id)),
);

const fillApplicationTool = tool(
  "fill_application",
  "Fill in the application form for a job, in the pane beside the app, from what is already known: name, email and links from the profile, situation questions from the standing answers, and the voluntary self-identification fields from whatever the person stored — those are filled by the app itself and their values are not shown to you. Attaches the resume drafted for this job. Answers with what was filled and what was left, including the employer's own questions, which still need writing. It does not send anything: the control that sends an application is refused by the app, not by instruction, because an application cannot be taken back.",
  { job_id: z.number().int() },
  async (args) => guard(async () => await fillApplication(args.job_id)),
);

const recordAnswerTool = tool(
  "record_answer",
  "Write down an answer you put on an application form, so it can be read back later. Use it for the employer's own questions, which you write rather than copy — what you told them about why you want the job is the thing nobody remembers three weeks on. Never record a self-identification answer: those are filled by the app and recorded as answered, without the value.",
  {
    job_id: z.number().int(),
    label: z.string().describe("The question, as the form words it"),
    value: z.string().describe("What was put in the field"),
  },
  async (args) =>
    guard(async () => {
      await recordAnswers(args.job_id, [
        { label: args.label, kind: "custom", value: args.value },
      ]);
      return { recorded: args.label };
    }),
);

const applicationRecordTool = tool(
  "application_record",
  "What went on a job's application form, as it was filled in. Self-identification fields show as answered without their values.",
  { job_id: z.number().int() },
  async (args) => guard(async () => ({ answers: await listAnswers(args.job_id) })),
  { annotations: { readOnlyHint: true } },
);

const markAppliedTool = tool(
  "mark_applied",
  "Record that the person has sent the application. Only on their word: nothing here can see a submitted form, and the app never presses the button, so asking them and believing them is the honest version. Moves the job to 'applied', stamps the date, and freezes what was put on the form.",
  { job_id: z.number().int() },
  async (args) => guard(async () => await markApplied(args.job_id)),
);

const coverageTool = tool(
  "application_coverage",
  "What a job's application asks for, and how much of it is already answerable: identity and links from the profile, documents from the resume and letter this app writes, situation questions from the standing answers, self-identification from what the person stored. Answers with the fields that nothing can answer yet — which is the list worth putting to them before they start, and worth comparing across a shortlist. Self-identification is never listed as outstanding: leaving it blank is a complete answer.",
  { job_id: z.number().int() },
  async (args) =>
    guard(async () => {
      const form = await formForJob(args.job_id);
      return { ats: form.ats, url: form.url, ...(await coverage(form)) };
    }),
  { annotations: { readOnlyHint: true } },
);

const matchBarTool = tool(
  "set_match_bar",
  "Set how good a match a posting must be to be stored when a board is synced. Scores run 0-65, and the bar starts at 50. Raise it when the list is full of roles they would not read; lower it when a board they follow is contributing almost nothing. This changes what comes in from the next sync onward — it never removes a posting already stored. Say what the new bar is and that it takes effect on the next sync.",
  {
    score: z.number().int().min(0).max(65).describe("The score a posting must reach, 0 to 65"),
  },
  async (args) =>
    guard(async () => ({
      bar: await setMatchBar(args.score),
      note: "Applies from the next sync. Postings already stored are untouched.",
    })),
);

const getMatchBarTool = tool(
  "get_match_bar",
  "The score a posting must reach to be stored when a board is synced.",
  {},
  async () => guard(async () => ({ bar: await matchBar() })),
  { annotations: { readOnlyHint: true } },
);

const syncBoardsTool = tool(
  "sync_boards",
  "Fetch the current postings from the company boards and store the ones worth this person's attention. A board is the company's list, not theirs: postings outside the places they work, or scoring below the relevance bar, are not stored at all. Returns, per board, how many were seen, how many were kept and how many are new — and a note when the filter could not be applied. Run this before searching when the user wants fresh results.",
  {
    companies: z
      .array(z.string())
      .optional()
      .describe("Limit the sync to these company names. Omit to sync every active board."),
  },
  async (args) => guard(async () => await syncBoards(args.companies)),
);

const rankJobs = tool(
  "rank_jobs",
  "Score every stored posting against the profile by keyword overlap, so the list has an order that means something. This is arithmetic, not judgement: use it to decide which postings are worth reading, then read them and use assess_job for a real opinion. Run it after a sync, or after the profile changes.",
  {},
  async () => guard(async () => await rankAllJobs()),
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
    guard(async () => {
      const places = await resolvePlaces(args.location_any);
      return await assessTopJobs({
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
    guard(async () => {
      const jobs = await repo.searchJobs({
        titleAny: args.title_any,
        titleNone: args.title_none,
        textAny: args.text_any,
        textNone: args.text_none,
        companyAny: args.company_any,
        locationAny: await resolvePlaces(args.location_any),
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
    guard(async () => {
      const job = await repo.getJob(args.job_id);
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
    guard(async () => {
      await repo.saveAssessment(args.job_id, args.fit_score, args.reasoning);
      return { job_id: args.job_id, fit_score: args.fit_score };
    }),
);

const trackJob = tool(
  "track_job",
  "Start tracking a job as an application, at status 'interested'. Idempotent.",
  { job_id: z.number().int(), note: z.string().optional() },
  async (args) => guard(async () => await repo.trackJob(args.job_id, args.note)),
);

const setStatus = tool(
  "set_status",
  "Move a tracked application to a new status. The status machine rejects a move it does not allow and tells you which moves are allowed.",
  {
    job_id: z.number().int(),
    status: z.enum(STATUSES),
    note: z.string().optional().describe("Why the status changed. Stored in the history."),
  },
  async (args) => guard(async () => await repo.setStatus(args.job_id, args.status, args.note)),
  { annotations: { destructiveHint: true } },
);

const listApplications = tool(
  "list_applications",
  "List tracked applications, newest change first.",
  { status_any: z.array(z.enum(STATUSES)).optional().describe("Limit to these statuses") },
  async (args) => guard(async () => await repo.listApplications(args.status_any)),
  { annotations: { readOnlyHint: true } },
);

const getStats = tool(
  "get_stats",
  "Count the stored postings and the applications at each status.",
  {},
  async () =>
    guard(async () => ({ ...(await repo.stats()), sources: Object.keys(SOURCES) })),
  { annotations: { readOnlyHint: true } },
);


/**
 * What is on the person's screen.
 *
 * Cheap, and it removes most of the reason to open a browser. "Make this one
 * warmer" and "why is this ranked so low" both resolve from here, where
 * otherwise they need a screenshot read back.
 *
 * It says when it does not know. A confident answer about the wrong resume
 * is worse than asking which one.
 */
const appState = tool(
  "app_state",
  "What the person currently has open in the app: which tab, and what is selected in it. Call this before acting on 'this one', 'that posting' or 'the current resume' instead of guessing or taking a screenshot. It reports honestly when the app is closed or has not said recently.",
  {},
  async () => guard(async () => currentState()),
  { annotations: { readOnlyHint: true } },
);

export const jobsearchServer = createSdkMcpServer({
  name: "jobsearch",
  version: "0.1.0",
  tools: [
    appState,
    listCompanies,
    removeCompanyTool,
    getInterestsTool,
    setInterestsTool,
    evaluateCompaniesTool,
    addCompany,
    addCompaniesByName,
    syncBoardsTool,
    importPostingTool,
    applicationFormTool,
    startApplicationTool,
    fillApplicationTool,
    recordAnswerTool,
    applicationRecordTool,
    markAppliedTool,
    coverageTool,
    standingAnswersTool,
    setStandingAnswerTool,
    selfIdStatusTool,
    matchBarTool,
    getMatchBarTool,
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
  "mcp__jobsearch__add_companies",
  "mcp__jobsearch__remove_company",
  "mcp__jobsearch__set_interests",
  "mcp__jobsearch__sync_boards",
  "mcp__jobsearch__rank_jobs",
  "mcp__jobsearch__assess_top_jobs",
  "mcp__jobsearch__assess_job",
  "mcp__jobsearch__track_job",
  "mcp__jobsearch__set_status",
  ...PROFILE_MUTATING,
]);

import type { InValue } from "@libsql/client";
import { all as dbAll, get as dbGet, run as dbRun, tx } from "./db/client.js";
import { locationClause, locationTokens } from "./location.js";
import { allowedNext, canTransition, isStatus, type Status } from "./status.js";
import type { SourceJob } from "./sources/types.js";

export interface JobRow {
  id: number;
  source: string;
  source_job_id: string;
  company: string;
  title: string;
  location: string | null;
  remote: number;
  url: string;
  description: string | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface JobWithStatus extends JobRow {
  status: Status | null;
  fit_score: number | null;
  reasoning: string | null;
  model: string | null;
  /** Keyword overlap with the profile, 0-100. See matching.ts. */
  match_score: number | null;
}

/* ------------------------------------------------------------------ companies */

export interface CompanyRow {
  id: number;
  name: string;
  ats: string;
  board_token: string;
  active: number;
  /** Postings stored from this board, so the list is evidence not just config. */
  jobs?: number;
}

export async function listCompanies(): Promise<CompanyRow[]> {
  return (await dbAll(`SELECT c.id, c.name, c.ats, c.board_token, c.active,
              (SELECT COUNT(*) FROM jobs j WHERE j.company = c.name) AS jobs
         FROM companies c ORDER BY c.name`)) as CompanyRow[];
}

export async function addCompany(name: string, ats: string, boardToken: string): Promise<CompanyRow> {
  (await dbRun(`INSERT INTO companies (name, ats, board_token) VALUES (?, ?, ?)
     ON CONFLICT (ats, board_token) DO UPDATE SET name = excluded.name, active = 1`, name, ats, boardToken));
  return (await dbGet(`SELECT id, name, ats, board_token, active FROM companies WHERE ats = ? AND board_token = ?`, ats, boardToken)) as CompanyRow;
}

/*
  A posting worth keeping even when its board goes: one you are pursuing, or
  one you have already drafted something for. Deleting those would take an
  application's history and a tailored resume with them, which no amount of
  tidying is worth.
*/
const TRACKED = `
  j.id IN (SELECT job_id FROM applications)
  OR j.id IN (SELECT job_id FROM cover_letters)
  OR j.id IN (SELECT job_id FROM resumes WHERE job_id IS NOT NULL)`;

export interface PostingCount {
  /** Everything stored from this board. */
  total: number;
  /** Of those, the ones being pursued or drafted for. */
  tracked: number;
}

/**
 * What un-following a board would leave behind.
 *
 * Postings are keyed to a board by company name and ATS, because that is what
 * the adapters write. Both are compared, so two companies sharing a name on
 * different systems stay apart.
 */
export async function companyPostings(id: number): Promise<PostingCount> {
  const row = (await dbGet(`SELECT COUNT(*) AS total, SUM(CASE WHEN ${TRACKED} THEN 1 ELSE 0 END) AS tracked
         FROM jobs j JOIN companies c ON c.name = j.company AND c.ats = j.source
        WHERE c.id = ?`, id)) as { total: number; tracked: number | null };
  return { total: row.total, tracked: row.tracked ?? 0 };
}

export interface RemovalReport {
  removed: boolean;
  /** Postings deleted along with the board. */
  deleted: number;
  /** Postings left behind: tracked ones, or all of them if you kept them. */
  kept: number;
}

/**
 * Stop following a board, and optionally take its postings with it.
 *
 * Removing the board alone used to be the only option, and it stranded every
 * posting already fetched: they stayed in the list, still ranked, and nothing
 * would ever refresh them again. A stale posting that can never update is
 * worse than no posting, so deleting them is offered here rather than left as
 * a manual cleanup.
 *
 * Tracked postings are never deleted, whatever is asked. Their applications
 * and drafts cascade, and losing those to a tidy-up is not a trade worth
 * making. They are counted in `kept` so the caller can say so.
 */
export async function removeCompany(id: number, withPostings = false): Promise<RemovalReport> {
  const before = await companyPostings(id);

  return tx(async () => {
    let deleted = 0;
    if (withPostings) {
      deleted = (await dbRun(`DELETE FROM jobs WHERE id IN (
             SELECT j.id FROM jobs j JOIN companies c ON c.name = j.company AND c.ats = j.source
              WHERE c.id = ? AND NOT (${TRACKED}))`, id)).changes;
    }
    const removed = (await dbRun(`DELETE FROM companies WHERE id = ?`, id)).changes > 0;
    return { removed, deleted, kept: before.total - deleted };
  });
}

/* ----------------------------------------------------------------------- jobs */

/*
  location_tokens is written here, beside the location it comes from.

  Matching a place used to call JavaScript from inside SQLite. libSQL runs the
  query on a server this process cannot reach into, so the parts a match needs
  are worked out on the way in and matched with an ordinary LIKE. Any other
  path that writes a job has to set this column too, or that job stops
  matching any short place name.
*/
const UPSERT_JOB = `
  INSERT INTO jobs (source, source_job_id, company, title, location, location_tokens,
                    remote, url, description, posted_at)
  VALUES (@source, @sourceJobId, @company, @title, @location, @locationTokens,
          @remote, @url, @description, @postedAt)
  ON CONFLICT (source, source_job_id) DO UPDATE SET
    company         = excluded.company,
    title           = excluded.title,
    location        = excluded.location,
    location_tokens = excluded.location_tokens,
    remote          = excluded.remote,
    url             = excluded.url,
    description     = excluded.description,
    posted_at       = excluded.posted_at,
    last_seen_at    = datetime('now')
`;

export interface UpsertResult {
  seen: number;
  inserted: number;
}

/** Write postings to the database. Returns how many were new. */
export async function upsertJobs(jobs: SourceJob[]): Promise<UpsertResult> {
  return tx(async () => {
    let inserted = 0;
    for (const job of jobs) {
      const before = await dbGet(
        `SELECT 1 FROM jobs WHERE source = ? AND source_job_id = ?`,
        job.source,
        job.sourceJobId,
      );
      await dbRun(UPSERT_JOB, {
        source: job.source,
        sourceJobId: job.sourceJobId,
        company: job.company,
        title: job.title,
        location: job.location,
        locationTokens: locationTokens(job.location),
        remote: job.remote ? 1 : 0,
        url: job.url,
        description: job.description,
        postedAt: job.postedAt,
      });
      if (!before) inserted += 1;
    }
    return { seen: jobs.length, inserted };
  });
}

export interface JobFilter {
  titleAny?: string[];
  titleNone?: string[];
  textAny?: string[];
  textNone?: string[];
  companyAny?: string[];
  remoteOnly?: boolean;
  /** Places to accept, already expanded into the forms boards use. */
  locationAny?: string[];
  /** Also accept remote postings wherever they are based. */
  includeRemote?: boolean;
  statusAny?: string[];
  untrackedOnly?: boolean;
  assessedOnly?: boolean;
  unassessedOnly?: boolean;
  minFitScore?: number;
  minMatchScore?: number;
  newSince?: string;
  limit?: number;
}

/** Build the WHERE clause shared by searchJobs and countJobs. */
function buildWhere(filter: JobFilter): { where: string[]; params: InValue[] } {
  const where: string[] = [];
  const params: InValue[] = [];

  const anyLike = (column: string, needles: string[] | undefined, negate: boolean) => {
    if (!needles || needles.length === 0) return;
    const clause = needles.map(() => `${column} LIKE ?`).join(" OR ");
    for (const needle of needles) params.push(`%${needle}%`);
    where.push(negate ? `NOT (${clause})` : `(${clause})`);
  };

  anyLike("j.title", filter.titleAny, false);
  anyLike("j.title", filter.titleNone, true);
  anyLike("COALESCE(j.title, '') || ' ' || COALESCE(j.description, '')", filter.textAny, false);
  anyLike("COALESCE(j.title, '') || ' ' || COALESCE(j.description, '')", filter.textNone, true);
  anyLike("j.company", filter.companyAny, false);
  // Location and remote are one decision, not two filters. A posting counts if
  // it is in a place the person will work, or — when they are open to it — if
  // it is remote wherever it is based.
  if (filter.locationAny && filter.locationAny.length > 0) {
    /*
      This was `loc_matches(j.location, ?) = 1`, a JavaScript function
      registered on the SQLite connection. libSQL runs the query on a server
      that cannot call into this process, so the same rule is expressed in SQL
      instead: a long place name matches the location text, a short one
      matches a stored token. `location-sql.test.mts` holds the two forms to
      the same answers.
    */
    const clauses: string[] = [];
    for (const place of filter.locationAny) {
      const clause = locationClause(place);
      if (!clause) continue;
      clauses.push(clause.sql);
      params.push(clause.param);
    }
    if (clauses.length > 0) {
      const joined = clauses.join(" OR ");
      where.push(filter.includeRemote ? `((${joined}) OR j.remote = 1)` : `(${joined})`);
    }
  }
  // includeRemote only ever widens a place filter. With no place named the
  // search is already everywhere, and remote postings belong in it.

  if (filter.remoteOnly) where.push(`j.remote = 1`);
  if (filter.untrackedOnly) where.push(`a.id IS NULL`);
  if (filter.assessedOnly) where.push(`s.fit_score IS NOT NULL`);
  if (filter.unassessedOnly) where.push(`s.fit_score IS NULL`);
  if (filter.minFitScore != null) {
    where.push(`s.fit_score >= ?`);
    params.push(filter.minFitScore);
  }
  if (filter.minMatchScore != null) {
    where.push(`m.score >= ?`);
    params.push(filter.minMatchScore);
  }
  if (filter.newSince) {
    where.push(`j.first_seen_at >= ?`);
    params.push(filter.newSince);
  }
  if (filter.statusAny && filter.statusAny.length > 0) {
    where.push(`a.status IN (${filter.statusAny.map(() => "?").join(", ")})`);
    params.push(...filter.statusAny);
  }

  return { where, params };
}

/** How many postings match, ignoring the limit. */
export async function countJobs(filter: JobFilter = {}): Promise<number> {
  const { where, params } = buildWhere(filter);
  const row = (await dbGet(`SELECT COUNT(*) AS n
         FROM jobs j
         LEFT JOIN applications a ON a.job_id = j.id
         LEFT JOIN job_assessments s ON s.job_id = j.id
         LEFT JOIN job_match m ON m.job_id = j.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, ...params)) as { n: number };
  return row.n;
}

export async function searchJobs(filter: JobFilter = {}): Promise<JobWithStatus[]> {
  const { where, params } = buildWhere(filter);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);

  // The agent's own judgement wins where it exists; the keyword match orders
  // the rest. Ties break on when the company posted the job, not on when this
  // app happened to fetch it — fetch order is an artifact of the sync, and
  // sorting by it looks like relevance while meaning nothing.
  return (await dbAll(
      `SELECT j.*, a.status, s.fit_score, s.reasoning, s.model, m.score AS match_score
         FROM jobs j
         LEFT JOIN applications a ON a.job_id = j.id
         LEFT JOIN job_assessments s ON s.job_id = j.id
         LEFT JOIN job_match m ON m.job_id = j.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY COALESCE(s.fit_score, m.score, -1) DESC,
                 COALESCE(j.posted_at, j.first_seen_at) DESC
        LIMIT ?`,
    ...(params as InValue[]),
    limit,
  )) as JobWithStatus[];
}

export async function getJob(id: number): Promise<JobWithStatus | undefined> {
  return (await dbGet(`SELECT j.*, a.status, s.fit_score, s.reasoning, s.model, m.score AS match_score
         FROM jobs j
         LEFT JOIN applications a ON a.job_id = j.id
         LEFT JOIN job_assessments s ON s.job_id = j.id
         LEFT JOIN job_match m ON m.job_id = j.id
        WHERE j.id = ?`, id)) as JobWithStatus | undefined;
}

export async function saveAssessment(jobId: number, fitScore: number, reasoning: string): Promise<void> {
  if (!await getJob(jobId)) throw new Error(`No job with id ${jobId}`);
  (await dbRun(`INSERT INTO job_assessments (job_id, fit_score, reasoning, assessed_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (job_id) DO UPDATE SET
       fit_score = excluded.fit_score,
       reasoning = excluded.reasoning,
       assessed_at = excluded.assessed_at`, jobId, fitScore, reasoning));
}

/* --------------------------------------------------------------- applications */

export interface ApplicationRow {
  id: number;
  job_id: number;
  status: Status;
  notes: string | null;
  applied_at: string | null;
  updated_at: string;
  title: string;
  company: string;
  url: string;
  location: string | null;
}

export async function listApplications(statuses?: string[]): Promise<ApplicationRow[]> {
  const where =
    statuses && statuses.length > 0
      ? `WHERE a.status IN (${statuses.map(() => "?").join(", ")})`
      : "";
  return (await dbAll(`SELECT a.id, a.job_id, a.status, a.notes, a.applied_at, a.updated_at,
              j.title, j.company, j.url, j.location
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
        ${where}
        ORDER BY a.updated_at DESC`, ...(statuses ?? []))) as ApplicationRow[];
}

/** Start tracking a job. Idempotent: an existing application is returned unchanged. */
export async function trackJob(jobId: number, note?: string): Promise<ApplicationRow> {
  return tx(async () => {
  if (!await getJob(jobId)) throw new Error(`No job with id ${jobId}`);
  const existing = (await dbGet(`SELECT id FROM applications WHERE job_id = ?`, jobId)) as
    | { id: number }
    | undefined;

  if (!existing) {
    const info = (await dbRun(`INSERT INTO applications (job_id, status, notes) VALUES (?, 'interested', ?)`, jobId, note ?? null));
    (await dbRun(`INSERT INTO application_events (application_id, from_status, to_status, note)
       VALUES (?, NULL, 'interested', ?)`, info.lastInsertRowid, note ?? null));
  }
  return (await dbGet(`SELECT a.id, a.job_id, a.status, a.notes, a.applied_at, a.updated_at,
              j.title, j.company, j.url, j.location
         FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.job_id = ?`, jobId)) as ApplicationRow;
  });
}

/**
 * Move an application to a new status. Rejects a transition the status machine
 * does not allow, and records every accepted move in application_events.
 */
export async function setStatus(
  jobId: number,
  to: string,
  note?: string,
): Promise<ApplicationRow> {
  return tx(async () => {
    if (!isStatus(to)) throw new Error(`"${to}" is not a known status`);

    const current = (await dbGet(`SELECT id, status FROM applications WHERE job_id = ?`, jobId)) as { id: number; status: Status } | undefined;

    if (!current) {
      throw new Error(`Job ${jobId} is not tracked yet. Call track_job first.`);
    }
    if (current.status === to) {
      return listApplicationByJob(jobId);
    }
    if (!canTransition(current.status, to)) {
      throw new Error(
        `Cannot move from "${current.status}" to "${to}". Allowed: ${
          allowedNext(current.status).join(", ") || "none (terminal status)"
        }`,
      );
    }

    (await dbRun(`UPDATE applications
          SET status = ?, updated_at = datetime('now'),
              applied_at = CASE WHEN ? = 'applied' AND applied_at IS NULL
                                THEN datetime('now') ELSE applied_at END
        WHERE id = ?`, to, to, current.id));

    (await dbRun(`INSERT INTO application_events (application_id, from_status, to_status, note)
       VALUES (?, ?, ?, ?)`, current.id, current.status, to, note ?? null));

    return listApplicationByJob(jobId);
  });
}

async function listApplicationByJob(jobId: number): Promise<ApplicationRow> {
  return (await dbGet(`SELECT a.id, a.job_id, a.status, a.notes, a.applied_at, a.updated_at,
              j.title, j.company, j.url, j.location
         FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.job_id = ?`, jobId)) as ApplicationRow;
}

export async function applicationHistory(jobId: number) {
  return (await dbAll(`SELECT e.from_status, e.to_status, e.note, e.at
         FROM application_events e
         JOIN applications a ON a.id = e.application_id
        WHERE a.job_id = ? ORDER BY e.at`, jobId));
}

/* -------------------------------------------------------------- conversations */

export async function createConversation(title?: string): Promise<number> {
  return Number(
    (await dbRun(`INSERT INTO conversations (title) VALUES (?)`, title ?? null)).lastInsertRowid,
  );
}

export async function getSdkSessionId(conversationId: number): Promise<string | null> {
  const row = (await dbGet(`SELECT sdk_session_id FROM conversations WHERE id = ?`, conversationId)) as { sdk_session_id: string | null } | undefined;
  return row?.sdk_session_id ?? null;
}

export async function setSdkSessionId(conversationId: number, sessionId: string): Promise<void> {
  (await dbRun(`UPDATE conversations SET sdk_session_id = ?, updated_at = datetime('now') WHERE id = ?`, sessionId, conversationId));
}

export async function addMessage(conversationId: number, role: "user" | "assistant", content: string) {
  (await dbRun(`INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`, conversationId,
    role,
    content));
}

export async function listMessages(conversationId: number) {
  return (await dbAll(`SELECT role, content, at FROM messages WHERE conversation_id = ? ORDER BY id`, conversationId));
}

export async function stats() {
  const jobs = (await dbGet(`SELECT COUNT(*) AS n FROM jobs`)) as { n: number };
  const byStatus = (await dbAll(`SELECT status, COUNT(*) AS n FROM applications GROUP BY status`)) as { status: string; n: number }[];
  return { jobs: jobs.n, byStatus };
}

import { db } from "./db/client.js";
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

export function listCompanies(): CompanyRow[] {
  return db
    .prepare(
      `SELECT c.id, c.name, c.ats, c.board_token, c.active,
              (SELECT COUNT(*) FROM jobs j WHERE j.company = c.name) AS jobs
         FROM companies c ORDER BY c.name`,
    )
    .all() as CompanyRow[];
}

export function addCompany(name: string, ats: string, boardToken: string): CompanyRow {
  db.prepare(
    `INSERT INTO companies (name, ats, board_token) VALUES (?, ?, ?)
     ON CONFLICT (ats, board_token) DO UPDATE SET name = excluded.name, active = 1`,
  ).run(name, ats, boardToken);
  return db
    .prepare(`SELECT id, name, ats, board_token, active FROM companies WHERE ats = ? AND board_token = ?`)
    .get(ats, boardToken) as CompanyRow;
}

export function removeCompany(id: number): boolean {
  return db.prepare(`DELETE FROM companies WHERE id = ?`).run(id).changes > 0;
}

/* ----------------------------------------------------------------------- jobs */

const upsertJob = db.prepare(`
  INSERT INTO jobs (source, source_job_id, company, title, location, remote, url, description, posted_at)
  VALUES (@source, @sourceJobId, @company, @title, @location, @remote, @url, @description, @postedAt)
  ON CONFLICT (source, source_job_id) DO UPDATE SET
    company      = excluded.company,
    title        = excluded.title,
    location     = excluded.location,
    remote       = excluded.remote,
    url          = excluded.url,
    description  = excluded.description,
    posted_at    = excluded.posted_at,
    last_seen_at = datetime('now')
`);

export interface UpsertResult {
  seen: number;
  inserted: number;
}

/** Write postings to the database. Returns how many were new. */
export const upsertJobs = db.transaction((jobs: SourceJob[]): UpsertResult => {
  let inserted = 0;
  for (const job of jobs) {
    const before = db
      .prepare(`SELECT 1 FROM jobs WHERE source = ? AND source_job_id = ?`)
      .get(job.source, job.sourceJobId);
    upsertJob.run({
      source: job.source,
      sourceJobId: job.sourceJobId,
      company: job.company,
      title: job.title,
      location: job.location,
      remote: job.remote ? 1 : 0,
      url: job.url,
      description: job.description,
      postedAt: job.postedAt,
    });
    if (!before) inserted += 1;
  }
  return { seen: jobs.length, inserted };
});

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
function buildWhere(filter: JobFilter): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

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
    const clause = filter.locationAny.map(() => `loc_matches(j.location, ?) = 1`).join(" OR ");
    for (const place of filter.locationAny) params.push(place);
    where.push(filter.includeRemote ? `((${clause}) OR j.remote = 1)` : `(${clause})`);
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
export function countJobs(filter: JobFilter = {}): number {
  const { where, params } = buildWhere(filter);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM jobs j
         LEFT JOIN applications a ON a.job_id = j.id
         LEFT JOIN job_assessments s ON s.job_id = j.id
         LEFT JOIN job_match m ON m.job_id = j.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
    )
    .get(...params) as { n: number };
  return row.n;
}

export function searchJobs(filter: JobFilter = {}): JobWithStatus[] {
  const { where, params } = buildWhere(filter);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);

  return db
    .prepare(
      // The agent's own judgement wins where it exists; the keyword match
      // orders the rest. Ties break on when the company posted the job, not on
      // when this app happened to fetch it — fetch order is an artifact of the
      // sync, and sorting by it looks like relevance while meaning nothing.
      `SELECT j.*, a.status, s.fit_score, s.reasoning, s.model, m.score AS match_score
         FROM jobs j
         LEFT JOIN applications a ON a.job_id = j.id
         LEFT JOIN job_assessments s ON s.job_id = j.id
         LEFT JOIN job_match m ON m.job_id = j.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY COALESCE(s.fit_score, m.score, -1) DESC,
                 COALESCE(j.posted_at, j.first_seen_at) DESC
        LIMIT ?`,
    )
    .all(...params, limit) as JobWithStatus[];
}

export function getJob(id: number): JobWithStatus | undefined {
  return db
    .prepare(
      `SELECT j.*, a.status, s.fit_score, s.reasoning, s.model, m.score AS match_score
         FROM jobs j
         LEFT JOIN applications a ON a.job_id = j.id
         LEFT JOIN job_assessments s ON s.job_id = j.id
         LEFT JOIN job_match m ON m.job_id = j.id
        WHERE j.id = ?`,
    )
    .get(id) as JobWithStatus | undefined;
}

export function saveAssessment(jobId: number, fitScore: number, reasoning: string): void {
  if (!getJob(jobId)) throw new Error(`No job with id ${jobId}`);
  db.prepare(
    `INSERT INTO job_assessments (job_id, fit_score, reasoning, assessed_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (job_id) DO UPDATE SET
       fit_score = excluded.fit_score,
       reasoning = excluded.reasoning,
       assessed_at = excluded.assessed_at`,
  ).run(jobId, fitScore, reasoning);
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

export function listApplications(statuses?: string[]): ApplicationRow[] {
  const where =
    statuses && statuses.length > 0
      ? `WHERE a.status IN (${statuses.map(() => "?").join(", ")})`
      : "";
  return db
    .prepare(
      `SELECT a.id, a.job_id, a.status, a.notes, a.applied_at, a.updated_at,
              j.title, j.company, j.url, j.location
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
        ${where}
        ORDER BY a.updated_at DESC`,
    )
    .all(...(statuses ?? [])) as ApplicationRow[];
}

/** Start tracking a job. Idempotent: an existing application is returned unchanged. */
export const trackJob = db.transaction((jobId: number, note?: string): ApplicationRow => {
  if (!getJob(jobId)) throw new Error(`No job with id ${jobId}`);
  const existing = db.prepare(`SELECT id FROM applications WHERE job_id = ?`).get(jobId) as
    | { id: number }
    | undefined;

  if (!existing) {
    const info = db
      .prepare(`INSERT INTO applications (job_id, status, notes) VALUES (?, 'interested', ?)`)
      .run(jobId, note ?? null);
    db.prepare(
      `INSERT INTO application_events (application_id, from_status, to_status, note)
       VALUES (?, NULL, 'interested', ?)`,
    ).run(info.lastInsertRowid, note ?? null);
  }
  return db
    .prepare(
      `SELECT a.id, a.job_id, a.status, a.notes, a.applied_at, a.updated_at,
              j.title, j.company, j.url, j.location
         FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.job_id = ?`,
    )
    .get(jobId) as ApplicationRow;
});

/**
 * Move an application to a new status. Rejects a transition the status machine
 * does not allow, and records every accepted move in application_events.
 */
export const setStatus = db.transaction(
  (jobId: number, to: string, note?: string): ApplicationRow => {
    if (!isStatus(to)) throw new Error(`"${to}" is not a known status`);

    const current = db
      .prepare(`SELECT id, status FROM applications WHERE job_id = ?`)
      .get(jobId) as { id: number; status: Status } | undefined;

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

    db.prepare(
      `UPDATE applications
          SET status = ?, updated_at = datetime('now'),
              applied_at = CASE WHEN ? = 'applied' AND applied_at IS NULL
                                THEN datetime('now') ELSE applied_at END
        WHERE id = ?`,
    ).run(to, to, current.id);

    db.prepare(
      `INSERT INTO application_events (application_id, from_status, to_status, note)
       VALUES (?, ?, ?, ?)`,
    ).run(current.id, current.status, to, note ?? null);

    return listApplicationByJob(jobId);
  },
);

function listApplicationByJob(jobId: number): ApplicationRow {
  return db
    .prepare(
      `SELECT a.id, a.job_id, a.status, a.notes, a.applied_at, a.updated_at,
              j.title, j.company, j.url, j.location
         FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.job_id = ?`,
    )
    .get(jobId) as ApplicationRow;
}

export function applicationHistory(jobId: number) {
  return db
    .prepare(
      `SELECT e.from_status, e.to_status, e.note, e.at
         FROM application_events e
         JOIN applications a ON a.id = e.application_id
        WHERE a.job_id = ? ORDER BY e.at`,
    )
    .all(jobId);
}

/* -------------------------------------------------------------- conversations */

export function createConversation(title?: string): number {
  return Number(
    db.prepare(`INSERT INTO conversations (title) VALUES (?)`).run(title ?? null).lastInsertRowid,
  );
}

export function getSdkSessionId(conversationId: number): string | null {
  const row = db
    .prepare(`SELECT sdk_session_id FROM conversations WHERE id = ?`)
    .get(conversationId) as { sdk_session_id: string | null } | undefined;
  return row?.sdk_session_id ?? null;
}

export function setSdkSessionId(conversationId: number, sessionId: string): void {
  db.prepare(
    `UPDATE conversations SET sdk_session_id = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(sessionId, conversationId);
}

export function addMessage(conversationId: number, role: "user" | "assistant", content: string) {
  db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`).run(
    conversationId,
    role,
    content,
  );
}

export function listMessages(conversationId: number) {
  return db
    .prepare(`SELECT role, content, at FROM messages WHERE conversation_id = ? ORDER BY id`)
    .all(conversationId);
}

export function stats() {
  const jobs = db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number };
  const byStatus = db
    .prepare(`SELECT status, COUNT(*) AS n FROM applications GROUP BY status`)
    .all() as { status: string; n: number }[];
  return { jobs: jobs.n, byStatus };
}

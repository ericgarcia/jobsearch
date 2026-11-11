PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- A company whose ATS board we poll.
CREATE TABLE IF NOT EXISTS companies (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  ats         TEXT    NOT NULL CHECK (ats IN ('greenhouse', 'lever', 'ashby')),
  board_token TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ats, board_token)
);

-- A posting as the source published it. Facts only; no judgement.
CREATE TABLE IF NOT EXISTS jobs (
  id             INTEGER PRIMARY KEY,
  source         TEXT    NOT NULL,
  source_job_id  TEXT    NOT NULL,
  company        TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  location       TEXT,
  remote         INTEGER NOT NULL DEFAULT 0,
  url            TEXT    NOT NULL,
  description    TEXT,
  posted_at      TEXT,
  first_seen_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, source_job_id)
);

CREATE INDEX IF NOT EXISTS jobs_company_idx ON jobs (company);
CREATE INDEX IF NOT EXISTS jobs_first_seen_idx ON jobs (first_seen_at DESC);

-- The agent's read on a job. Separate from the posting, so a re-fetch
-- of the posting never overwrites judgement.
CREATE TABLE IF NOT EXISTS job_assessments (
  job_id     INTEGER PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  fit_score  INTEGER CHECK (fit_score BETWEEN 0 AND 100),
  reasoning  TEXT,
  model      TEXT,
  assessed_at TEXT   NOT NULL DEFAULT (datetime('now'))
);

-- One row per job the user is actually pursuing.
CREATE TABLE IF NOT EXISTS applications (
  id         INTEGER PRIMARY KEY,
  job_id     INTEGER NOT NULL UNIQUE REFERENCES jobs (id) ON DELETE CASCADE,
  status     TEXT    NOT NULL DEFAULT 'interested',
  notes      TEXT,
  applied_at TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS applications_status_idx ON applications (status);

-- Append-only history. Every status change writes a row here.
CREATE TABLE IF NOT EXISTS application_events (
  id             INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  from_status    TEXT,
  to_status      TEXT    NOT NULL,
  note           TEXT,
  at             TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A named set of search criteria the user can re-run.
CREATE TABLE IF NOT EXISTS search_criteria (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  titles      TEXT    NOT NULL DEFAULT '[]',
  locations   TEXT    NOT NULL DEFAULT '[]',
  include     TEXT    NOT NULL DEFAULT '[]',
  exclude     TEXT    NOT NULL DEFAULT '[]',
  remote_only INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One chat thread in the UI, mapped to an Agent SDK session.
CREATE TABLE IF NOT EXISTS conversations (
  id             INTEGER PRIMARY KEY,
  sdk_session_id TEXT,
  title          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT    NOT NULL,
  at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Local settings, including the agent credential. This database lives outside
-- the repository and is chmod 600. The API never returns a secret value.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ----------------------------------------------------------------- profile */
/* The profile holds facts about the person. A resume may only restate a fact
   that is stored here. Nothing generated is ever written back into it.        */

CREATE TABLE IF NOT EXISTS profile (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  name       TEXT,
  headline   TEXT,
  email      TEXT,
  phone      TEXT,
  location   TEXT,
  links      TEXT NOT NULL DEFAULT '[]',
  summary    TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profile_roles (
  id         INTEGER PRIMARY KEY,
  company    TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  location   TEXT,
  start_date TEXT,
  end_date   TEXT,
  summary    TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- One atomic, reusable claim. This is the unit a resume is assembled from.
CREATE TABLE IF NOT EXISTS profile_bullets (
  id         INTEGER PRIMARY KEY,
  role_id    INTEGER REFERENCES profile_roles (id) ON DELETE CASCADE,
  text       TEXT    NOT NULL,
  skills     TEXT    NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS profile_bullets_role_idx ON profile_bullets (role_id);

CREATE TABLE IF NOT EXISTS profile_education (
  id         INTEGER PRIMARY KEY,
  school     TEXT    NOT NULL,
  degree     TEXT,
  field      TEXT,
  start_date TEXT,
  end_date   TEXT,
  note       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profile_skills (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  category TEXT,
  years    INTEGER
);

/* ----------------------------------------------------------------- resumes */

CREATE TABLE IF NOT EXISTS resumes (
  id         INTEGER PRIMARY KEY,
  job_id     INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  label      TEXT,
  summary    TEXT,
  warnings   TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
  One line on a tailored resume. source_bullet_id is required, so every line
  traces to a stored fact. rendered_text is the reworded form; when it differs
  from the source it is checked and any warning is kept here.
*/
CREATE TABLE IF NOT EXISTS resume_lines (
  id               INTEGER PRIMARY KEY,
  resume_id        INTEGER NOT NULL REFERENCES resumes (id) ON DELETE CASCADE,
  source_bullet_id INTEGER NOT NULL REFERENCES profile_bullets (id) ON DELETE CASCADE,
  rendered_text    TEXT,
  warnings         TEXT NOT NULL DEFAULT '[]',
  sort_order       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS resume_lines_resume_idx ON resume_lines (resume_id);

CREATE TABLE IF NOT EXISTS cover_letters (
  id         INTEGER PRIMARY KEY,
  job_id     INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  warnings   TEXT    NOT NULL DEFAULT '[]',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

/*
  A cheap, deterministic match between a posting and the stored profile.
  Separate from job_assessments, which holds the agent's judgement: this is
  arithmetic over keywords, computed for every posting, and is only ever used
  to decide what is worth reading.
*/
CREATE TABLE IF NOT EXISTS job_match (
  job_id    INTEGER PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  score     INTEGER NOT NULL,
  matched   TEXT    NOT NULL DEFAULT '[]',
  scored_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS job_match_score_idx ON job_match (score DESC);

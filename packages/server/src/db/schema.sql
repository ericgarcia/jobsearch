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

/*
  What the person wants next, as opposed to what they have done.

  Matching read only the profile, which is a record of the past. Someone moving
  towards a different kind of work got ranked against the work they are leaving.
  These are the terms they choose, and they outweigh the ones inferred from
  their history.
*/
CREATE TABLE IF NOT EXISTS interests (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  titles     TEXT NOT NULL DEFAULT '[]',
  include    TEXT NOT NULL DEFAULT '[]',
  exclude    TEXT NOT NULL DEFAULT '[]',
  note       TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One chat thread in the UI, mapped to an Agent SDK session.
CREATE TABLE IF NOT EXISTS conversations (
  id             INTEGER PRIMARY KEY,
  sdk_session_id TEXT,
  title          TEXT,
  -- What the app was showing in this conversation: the open tab, what was
  -- selected in it, the search. A conversation is a piece of work, and
  -- coming back to it should put back what you were looking at.
  workspace      TEXT,
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

/*
  A project: the long-form writing, and the one line that goes on a resume.

  Two fields rather than one because they do different jobs. `blurb` is
  resume-length and meant to be read by a stranger in a hurry. `narrative` is
  as long as it needs to be — what the problem was, what you tried, what it
  cost — and it is source material, not resume content. The fact-checker
  reads it, so a tailored summary can draw on it honestly, and the agent
  distils bullets from it that you approve into profile_bullets.

  narrative_public is off by default, and that default is the point. The
  long form is where someone writes candidly for their own use. A blurb is
  written to be read; a narrative has to be published deliberately.
*/
CREATE TABLE IF NOT EXISTS profile_projects (
  id              INTEGER PRIMARY KEY,
  role_id         INTEGER REFERENCES profile_roles (id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  blurb           TEXT,
  narrative       TEXT,
  start_date      TEXT,
  end_date        TEXT,
  narrative_public INTEGER NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS profile_projects_role_idx ON profile_projects (role_id);

/*
  A block of prose that is not tied to a role: values, how someone works,
  what they are looking for. Authored to be shown, so it is public unless
  turned off.
*/
CREATE TABLE IF NOT EXISTS profile_sections (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL DEFAULT 'values',
  heading    TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  is_public  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

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

/* ----------------------------------------------------------------- layouts */
/*
  How a surface is laid out and styled. Data, not code: a hosted copy offers
  the same customising as a local one, and nothing stored here is executable.

  spec   — the sections, in order, each shown or hidden (JSON).
  tokens — overrides on the design tokens (JSON). Every value is checked
           against a type before it is written, because it reaches a
           stylesheet. There is no user-authored CSS anywhere in this system.
*/
CREATE TABLE IF NOT EXISTS layouts (
  id         INTEGER PRIMARY KEY,
  surface    TEXT    NOT NULL CHECK (surface IN ('profile', 'resume')),
  name       TEXT    NOT NULL,
  spec       TEXT    NOT NULL DEFAULT '{}',
  tokens     TEXT    NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS layouts_surface_idx ON layouts (surface);

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

-- What the person says about their situation, once, for every application:
-- work authorization, sponsorship, relocation, notice, pay. These are the
-- answers an agent must copy rather than infer, so they are stored in the
-- person's own words and read back verbatim.
CREATE TABLE IF NOT EXISTS standing_answers (
  topic      TEXT PRIMARY KEY,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Voluntary self-identification: gender, race, veteran and disability status,
-- and pronouns. Deliberately its own table and not columns on profile, so
-- that nothing which reads the profile can read these by accident.
--
-- Nothing here is ever sent to the model. The tools can report which keys
-- are set, never a value, and the step that fills a form matches the stored
-- value to the form's options in code. The person types them; the browser
-- receives them; nothing in between needs to know.
CREATE TABLE IF NOT EXISTS self_identification (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
  What an application field was judged to be asking, and by which model.

  Classification is a model call on the form's own words (apply/classify.ts),
  so it is cached by the question and the heading above it. Employers ask the
  same questions as each other — "Are you legally authorized to work…" is one
  sentence shared by thousands of forms — so the second application that asks
  it costs nothing. Nothing of the person's is in this table: a label is the
  employer's words, and the answer is not stored here.

  A row expires three ways, because a judgement cached forever is a judgement
  that can never be corrected. It expires by age; it expires when the model
  changes; and it expires when the rules it was made under change, which is
  what `rules` is — a fingerprint of the instructions the model was given. A
  wrong classification is therefore fixed by editing the prompt, not by
  finding and deleting rows.
*/
CREATE TABLE IF NOT EXISTS field_classifications (
  fingerprint TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  section     TEXT,
  kind        TEXT NOT NULL,
  topic       TEXT,
  self_id_key TEXT,
  slot        TEXT,
  model       TEXT NOT NULL,
  rules       TEXT NOT NULL,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
  What a voluntary question's options mean, in the fixed vocabulary.

  The inversion that lets a model help with these without ever being shown
  one of the person's answers: it is asked what the employer's wording means,
  and the comparison happens in code. So this table holds an employer's
  option list and a translation of it — nothing of the person's, which is why
  it can be cached at all.

  Keyed by the option list, so one UK ethnicity list is read once and serves
  every employer who uses it. Expires the three ways field_classifications
  does.
*/
CREATE TABLE IF NOT EXISTS option_meanings (
  fingerprint TEXT PRIMARY KEY,
  self_id_key TEXT NOT NULL,
  question    TEXT NOT NULL,
  meanings    TEXT NOT NULL,
  model       TEXT NOT NULL,
  rules       TEXT NOT NULL,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
  Whether the person asked for an application's voluntary section to be
  filled in.

  One row per application, written only when they say. No row means blank,
  because declining is a complete answer to every question in that section
  and nobody should have it answered for them by default. The answers
  themselves are in self_identification; this says only yes or no, about one
  employer.
*/
CREATE TABLE IF NOT EXISTS voluntary_answers (
  job_id INTEGER PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  fill   INTEGER NOT NULL,
  at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- What went on the form, so "what did I tell them?" has an answer in three
-- weeks' time. Written as the form is filled and frozen when the person says
-- they have sent it.
--
-- A self-identification field is recorded as having been filled and never
-- with what: those values live in one table and stay there. The row exists
-- so the record is complete — it says the section was answered — without
-- copying someone's disability status into a second place.
CREATE TABLE IF NOT EXISTS application_answers (
  id      INTEGER PRIMARY KEY,
  job_id  INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  label   TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  value   TEXT,
  at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, label)
);

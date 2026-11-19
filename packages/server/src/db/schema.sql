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
  -- A fingerprint of the rules the assistant was last run under in this
  -- conversation. A conversation carries its own precedent: once the
  -- assistant has said it cannot do something, it goes on saying so for the
  -- rest of the thread, and editing the rules does not retract it. This is
  -- how a thread finds out the rules changed under it. See agent/prompt.ts.
  rules_at       TEXT,
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

/* ------------------------------------------------------------------- facts */

/*
  What the person has told this app about themselves, as rows rather than a
  closed list.

  This replaces an enum of eight topics, and the enum was the bug. A question
  outside it — a security clearance, years with a language, a degree, whether
  they are over 18 — had nowhere to go, so it was answered once, for one
  employer, written to application_answers and never seen again. The next
  form asking the same thing asked the person again. Employers ask what they
  ask; the store has to be open or it cannot learn.

  Three things a row carries that an answer on its own cannot:

    state   answered, declined, or asked and not yet answered. A decline is
            not a missing answer. Asking again on the next application is the
            app overriding them, so the refusal is written down and read
            back.

    share   whether the answer may be offered to an employer at all. An
            answer kept for their own records is not an answer to send. For
            an open fact this is 'always' or 'never'; for a private one it is
            'ask' or 'never', because which voluntary details go on a form is
            confirmed per application and a standing yes would answer for
            every employer at once.

    source  where it came from — onboarding, a resume, a particular
            application. "Where did this answer come from" is the question
            worth asking when a form was filled with something unexpected,
            and it should have an answer.

  A private row — the voluntary self-identification questions — carries all
  of that and never the answer. Those values stay in self_identification,
  which nothing but the person's own page and the form filler reads. The
  semantics are shared; the storage is deliberately not.
*/
CREATE TABLE IF NOT EXISTS facts (
  slug        TEXT PRIMARY KEY,
  question    TEXT NOT NULL,
  answer      TEXT,
  state       TEXT NOT NULL DEFAULT 'answered',
  sensitivity TEXT NOT NULL DEFAULT 'open',
  share       TEXT NOT NULL DEFAULT 'always',
  source      TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (state IN ('answered', 'declined', 'asked')),
  CHECK (sensitivity IN ('open', 'private')),
  CHECK (share IN ('always', 'ask', 'never')),
  -- The invariant the separation rests on: a private fact has no answer here.
  CHECK (sensitivity = 'open' OR answer IS NULL)
);

/*
  Which voluntary questions the person wants included, on one application.

  Per question and not per section. "Fill in the voluntary part" is not one
  decision: someone may be glad to state their pronouns to an employer and
  have no intention of stating a disability, and a single yes answers both.
  So each question is confirmed on its own, and an absent row means not yet
  decided, which means blank.

  Confirmed again on every application, because the decision is about this
  employer. The one standing answer the app will take is a refusal: see
  voluntary_default in settings, which when set to 'never' stops both the
  filling and the asking for good.
*/
CREATE TABLE IF NOT EXISTS voluntary_choices (
  job_id  INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  key     TEXT    NOT NULL,
  include INTEGER NOT NULL,
  at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, key)
);

/*
  Which stored fact a form's question was read to be asking for.

  The join the fact store needs. A closed list of topics could be matched by
  name, and that is exactly what made it closed: a question only had an
  answer if its topic was one of the eight the code knew. An open store has
  to be searched instead, and searching by meaning is a model's job — see
  apply/match.ts.

  Cached like a classification, and for the same reason: employers ask each
  other's questions, so the second form wanting a clearance costs nothing. It
  expires by age, by model, and by the rules the match was made under.

  A row with a NULL slug is a cached "nothing on file answers this", which is
  the common answer and the one worth not paying for twice. The presence of
  the row is the cache hit, not the slug.

  The candidate slugs are part of the fingerprint, so storing a new fact
  re-asks every question once rather than being invisible to the questions it
  could answer. Nothing of the person's is in this table: a label is the
  employer's words and a slug is the name of a question, not its answer.
*/
CREATE TABLE IF NOT EXISTS fact_matches (
  fingerprint TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  section     TEXT,
  slug        TEXT,
  model       TEXT NOT NULL,
  rules       TEXT NOT NULL,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
  A document the person handed over, read into a proposal.

  Kept as its own row, and kept unedited, because of the rule the profile
  rests on: a resume may only restate a fact that is stored here, and nothing
  generated is ever written back. An import inverts the direction for the one
  case where it is the person's own document doing the telling — so the thing
  that was read is written down once, verbatim, and applying it can only copy
  from this row.

  That is why the proposal is stored rather than handed to the agent and
  passed back. A round trip through the agent is a round trip through
  something that writes prose for a living, and a bullet it improved on the
  way would land in the profile as the person's own words.

  applied_at says it has been accepted. Nothing here is applied when it is
  read: the person sees it first.
*/
CREATE TABLE IF NOT EXISTS imports (
  id         INTEGER PRIMARY KEY,
  source     TEXT    NOT NULL,
  origin     TEXT,
  proposal   TEXT    NOT NULL,
  at         TEXT    NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);

/*
  The one thing the assistant is proposing to change, right now.

  One row, and the CHECK is the design rather than a tidiness. Onboarding kept
  turning into a form: the import reads a whole document, so the conversation
  about it arrived as six numbered decisions and a request to answer them all.
  Telling the assistant to ask one at a time does not work, because nothing
  stopped it doing otherwise.

  One slot stops it. A second proposal has nowhere to go until the first is
  answered, so "one at a time" is a property of the table instead of an
  instruction that can be ignored.

  Nothing here is stored in the profile. The person sees the proposed value in
  the field it would go in, edits it if they want, and keeps or skips it —
  which is also why `value` may be the text already there: "fix the tense on
  this line" is them editing their own sentence, not the assistant writing one.
*/
CREATE TABLE IF NOT EXISTS pending_edit (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  target     TEXT    NOT NULL,
  target_id  INTEGER,
  -- Facts are keyed by a slug rather than a row id.
  target_key TEXT,
  field      TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  why        TEXT    NOT NULL,
  -- Which queued question this answers, when it answers one.
  question_id INTEGER,
  -- "set" or "delete". Dropping a line is as much an edit as changing one,
  -- and the case that asked for it was a role carrying a company's sales
  -- copy among its achievements.
  action     TEXT    NOT NULL DEFAULT 'set',
  -- Which answer the assistant recommends: "use", "leave" or "drop". The
  -- card highlights that one, so a card never argues for an answer nobody
  -- chose. See pending.ts.
  recommend  TEXT    NOT NULL DEFAULT 'use',
  at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

/*
  Answers the assistant wanted and could not give.

  What a card can do is a closed set, because the server has to carry it out
  and because a label read off an imported document must never be able to
  invent a button. But a closed set is a guess about what the work needs, and
  the assistant is the one that meets the cases the guess missed — the line
  that wants splitting in two, the role that wants merging with another.

  So a want is recorded rather than acted on: the assistant says what it
  would have chosen, the same want gets a vote instead of a second row, and
  the admin page shows what is piling up. Nothing here changes what a card
  does. It is a list for whoever decides what the next action type is.
*/
CREATE TABLE IF NOT EXISTS wished_actions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  -- A short name for the answer, as the assistant would label the button.
  name    TEXT    NOT NULL,
  -- The latest account of what it was for, in the assistant's own words.
  why     TEXT    NOT NULL,
  votes   INTEGER NOT NULL DEFAULT 1,
  first_at TEXT   NOT NULL DEFAULT (datetime('now')),
  last_at  TEXT   NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name)
);

/*
  The cases behind a want, which are what make it buildable.

  "Somebody wanted splitting" is not a thing anyone can build or check. A
  case is: here is the line as it stood, here is the card that was up, here
  is what the assistant would have done to it, and here is what should be
  true afterwards. That last part is an acceptance test written at the only
  moment anybody knows what it was for — while the assistant is looking at
  the case it cannot answer.

  `shape` is the card's own contract as JSON — target, action, field, the
  answers it offered, whether anything was stored — rather than the name of
  whatever component drew it. The server knows the contract and does not
  know the component tree, and a component path would be a guess that goes
  stale at the next rename, while the target kind is what a test is written
  against anyway.

  Twelve per want. The first telling is usually the clearest and the recent
  ones are the live ones; the repetitions in between say nothing a vote has
  not already said.
*/
CREATE TABLE IF NOT EXISTS wish_cases (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  wish_id INTEGER NOT NULL REFERENCES wished_actions(id) ON DELETE CASCADE,
  -- The text the card was about, as it stood.
  saw     TEXT    NOT NULL,
  -- The card's contract, as JSON. See wishes.ts.
  shape   TEXT    NOT NULL,
  -- What the assistant would have done, had the answer existed.
  wanted  TEXT    NOT NULL,
  -- What should be true afterwards: the test this case is waiting for.
  expect  TEXT    NOT NULL,
  at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS wish_cases_by_wish ON wish_cases (wish_id, at);

/*
  Bugs the assistant ran into, with what it takes to reproduce them.

  It used to work around them in silence. A card it had put on the screen
  twice came back unanswered both times, so it said so in the thread and made
  the change itself — which was the right thing to do for the person in front
  of it and left nothing behind for anybody to fix. The thread scrolls away;
  the next conversation meets the same fault with no record that the first
  one did.

  So a report is filed, and the app fills in most of it. What the assistant
  writes is what only it knows: what it was doing, what it expected, what
  happened instead. What is attached comes off the server at the moment of
  filing — the card that was up or the fact that none was, the conversation
  it happened in, where the queue stood — because that is the part a model
  misremembers and the part a fix needs.

  Occurrences rather than rows: the same bug met twice is one report that has
  happened twice, matched by meaning. Twelve of them, as with a want.
*/
CREATE TABLE IF NOT EXISTS bug_reports (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  -- One line, as the assistant would title it.
  title    TEXT    NOT NULL,
  -- What it was doing when it happened.
  doing    TEXT    NOT NULL,
  -- What it expected to happen.
  expected TEXT    NOT NULL,
  -- What happened instead.
  happened TEXT    NOT NULL,
  hits     INTEGER NOT NULL DEFAULT 1,
  -- Set when somebody says it is dealt with; it then leaves the open list.
  fixed_at TEXT,
  first_at TEXT    NOT NULL DEFAULT (datetime('now')),
  last_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (title)
);

CREATE TABLE IF NOT EXISTS bug_occurrences (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id  INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  -- The state of the app when it was filed, as JSON. See bugs.ts.
  context TEXT    NOT NULL,
  -- What the assistant said this time, which is not always what it said last.
  said    TEXT    NOT NULL,
  at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS bug_occurrences_by_bug ON bug_occurrences (bug_id, at);

/*
  The things still worth asking somebody about their profile, in order.

  This exists because of one screenshot. An import had been read, and the
  assistant put six numbered decisions on the screen at once and asked for
  the answers to one and two — which is a form, and a form is what somebody
  was avoiding by handing over a resume. The questions were all good. There
  were just six of them at once, because the whole list arrived at once and
  nothing metered it.

  So the list is a queue. One row comes out at a time, is asked about, and is
  settled; the rest wait. What fills it is the import's own "unsure" notes —
  the things the reader could not decide — then the gaps in the profile, then
  the questions real employers asked that nothing on file could answer.

  A row carries a note in prose rather than a ready-made change, because the
  assistant still has to read it and decide what to put in front of the
  person. Where the thing to change is already known, the target columns say
  so and save it guessing.
*/
CREATE TABLE IF NOT EXISTS question_queue (
  id         INTEGER PRIMARY KEY,
  /** import:3, gap, or asked — where this came from. */
  source     TEXT    NOT NULL,
  note       TEXT    NOT NULL,
  target     TEXT,
  target_id  INTEGER,
  target_key TEXT,
  field      TEXT,
  /*
    The exact text this question would store, when it has one: the paragraph
    an import left out, kept so it can be offered back word for word. The
    note is prose about a decision; this is the thing the decision was about.
  */
  value      TEXT,
  state      TEXT    NOT NULL DEFAULT 'waiting',
  /** What happened, once it is settled. */
  outcome    TEXT,
  at         TEXT    NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT,
  CHECK (state IN ('waiting', 'done')),
  UNIQUE (source, note)
);

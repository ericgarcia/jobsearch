import { all, get, run } from "./db/client.js";
import { changed } from "./notify.js";
import { whatIsMissing } from "./onboard.js";

/**
 * What is still worth asking somebody about their profile, one at a time.
 *
 * This file exists because of a screenshot. An import had just been read and
 * the assistant put six numbered decisions on the screen at once, ending with
 * "tell me your answers in 1–2 and I'll import it". The questions were all
 * good ones. There were six of them at once because the whole list arrived at
 * once and nothing metered it, and a numbered list of six decisions is a
 * form — which is the thing somebody avoids by handing over a resume.
 *
 * So the list became a queue. Something takes one row out, asks about it, and
 * settles it; the rest wait. Between that and the single slot in pending.ts,
 * the shape of the conversation is decided by the data rather than by the
 * assistant remembering to be patient.
 *
 * Three things fill it, in the order they are worth asking:
 *
 *   the import's own "unsure" notes — what the reader could not settle about
 *   a document, which is the most immediate thing and the only one that is
 *   about something in front of them;
 *
 *   the gaps — the parts of the profile with nothing in them;
 *
 *   the questions real employers asked that nothing on file could answer,
 *   which is already ranked and already filtered of the employer's own
 *   questions. See onboard.whatIsMissing.
 *
 * A row holds a note in prose, not a ready-made change. The assistant reads
 * it and decides what to put in front of the person, because "the summary
 * says the PhD is in signal processing but the education section says
 * electrical engineering" is a thing to ask about, not a value to write.
 */

export interface Question {
  id: number;
  source: string;
  note: string;
  target: string | null;
  target_id: number | null;
  target_key: string | null;
  field: string | null;
  /** The exact text to propose, when the question carries one. */
  value: string | null;
}

export interface Waiting {
  /** The one to ask about now, or null when there is nothing left. */
  question: Question | null;
  /** How many are still waiting, this one included. */
  left: number;
  /** How many have been settled, so progress can be said out loud. */
  settled: number;
}

interface Entry {
  source: string;
  note: string;
  target?: string | null;
  target_id?: number | null;
  target_key?: string | null;
  field?: string | null;
  value?: string | null;
}

/**
 * Add things to ask about, ignoring any already asked.
 *
 * The uniqueness is on the source and the note together, so re-reading a
 * document does not queue its notes twice and a question settled last week
 * does not come back. Returns how many were new.
 */
export async function enqueue(entries: Entry[]): Promise<number> {
  let added = 0;
  for (const entry of entries) {
    if (!entry.note.trim()) continue;
    const written = await run(
      `INSERT INTO question_queue (source, note, target, target_id, target_key, field, value)
            VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, note) DO NOTHING`,
      entry.source,
      entry.note.trim(),
      entry.target ?? null,
      entry.target_id ?? null,
      entry.target_key ?? null,
      entry.field ?? null,
      entry.value ?? null,
    );
    if (written.changes > 0) added += 1;
  }
  if (added > 0) changed("profile");
  return added;
}

/** The import's own notes about what it could not settle. */
export async function enqueueFromImport(
  importId: number,
  unsure: string[],
): Promise<number> {
  return await enqueue(unsure.map((note) => ({ source: `import:${importId}`, note })));
}

/* What clearQueue writes, and what counts() must not call an answer. */
const PUT_AWAY = "left for another time";

/*
  Answered, and still waiting.

  A question put away is neither. It is marked done so that it does not come
  back, but counting it as answered makes the bar say somebody has dealt
  with something they explicitly set aside — forty questions abandoned read
  as forty answered, and the bar jumped from 20 to 60.
*/
async function counts(): Promise<{ left: number; settled: number }> {
  const row = await get<{ left: number; settled: number }>(
    `SELECT SUM(state = 'waiting') AS left,
            SUM(state = 'done' AND COALESCE(outcome, '') != ?) AS settled
       FROM question_queue`,
    PUT_AWAY,
  );
  return { left: row?.left ?? 0, settled: row?.settled ?? 0 };
}

/**
 * The next thing to ask about.
 *
 * Refills from the profile itself when nothing is waiting, so that finishing
 * a document's questions runs straight on into the gaps it did not fill and
 * then into what employers have actually been asking. The refill is lazy
 * rather than scheduled: a queue built in advance is a queue that is wrong by
 * the time it is read.
 */
export async function nextQuestion(): Promise<Waiting> {
  let left = (await counts()).left;
  if (left === 0) await refill();

  const question = await get<Question>(
    `SELECT id, source, note, target, target_id, target_key, field, value
       FROM question_queue WHERE state = 'waiting' ORDER BY id LIMIT 1`,
  );
  const now = await counts();
  return { question: question ?? null, left: now.left, settled: now.settled };
}

/*
  What the profile itself says is missing, as questions.

  The gaps first, because a profile with no email cannot be applied with, and
  then the questions employers put to them — which is the better list and the
  slower one to act on, since each answer is a thing to decide rather than a
  thing to copy.
*/
async function refill(): Promise<void> {
  const missing = await whatIsMissing();

  const gaps: Entry[] = missing.gaps.map((gap) => ({
    source: "gap",
    note: `Their profile has no ${gap}. Ask for it.`,
    ...(["name", "email", "location"].includes(gap)
      ? { target: "profile", field: gap }
      : {}),
  }));

  const asked: Entry[] = missing.asked.map((question) => ({
    source: "asked",
    note: `An application asked “${question.label}” and nothing on file answered it. Put it to them as: ${question.question}`,
    target: "fact",
    target_key: question.slug,
    field: "answer",
  }));

  const unanswered: Entry[] = missing.unanswered.map((question) => ({
    source: "gap",
    note: `No answer stored for: ${question.question}`,
    target: "fact",
    target_key: question.slug,
    field: "answer",
  }));

  await enqueue([...gaps, ...unanswered, ...asked]);
}

/**
 * Mark one as asked and answered.
 *
 * Settled rather than deleted, so re-reading the same document does not put
 * a question somebody has already dealt with back in front of them. A
 * question that ends in no change is as settled as one that ends in an edit —
 * "I looked at it and it is fine" is an answer.
 */
export async function settleQuestion(id: number, outcome: string): Promise<boolean> {
  const done = await run(
    `UPDATE question_queue SET state = 'done', outcome = ?, settled_at = datetime('now')
      WHERE id = ? AND state = 'waiting'`,
    outcome.trim() || "settled",
    id,
  );
  if (done.changes > 0) changed("profile");
  return done.changes > 0;
}

/**
 * How far through the queue they are.
 *
 * The same two numbers nextQuestion carries, on their own, so the page can
 * show progress without asking for a question and taking one out.
 */
export async function progress(): Promise<{ left: number; settled: number }> {
  return await counts();
}

/** Everything still waiting, for the person's own page rather than the agent. */
export async function waitingQuestions(): Promise<Question[]> {
  return await all<Question>(
    `SELECT id, source, note, target, target_id, target_key, field, value
       FROM question_queue WHERE state = 'waiting' ORDER BY id`,
  );
}

/** Put the queue away — when somebody says they have had enough for now. */
export async function clearQueue(): Promise<number> {
  const done = await run(
    `UPDATE question_queue SET state = 'done', outcome = ?,
            settled_at = datetime('now')
      WHERE state = 'waiting'`,
    PUT_AWAY,
  );
  if (done.changes > 0) changed("profile");
  return done.changes;
}

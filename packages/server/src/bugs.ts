import { all, get, run } from "./db/client.js";
import { sameAs } from "./likeness.js";
import { askingThread } from "./asking.js";

/**
 * Bugs the assistant ran into, filed rather than worked around in silence.
 *
 * It used to do the sensible thing and say nothing useful: a card it had put
 * on the screen twice came back unanswered both times, so it told the person
 * so and made the change itself. Right for the person in front of it, and
 * nothing left behind — the thread scrolls away, and the next conversation
 * meets the same fault with no record that the first one did.
 *
 * What the assistant writes is the part only it knows: what it was doing,
 * what it expected, what happened instead. What is attached is read off the
 * server as it files — the card that was waiting or the fact that none was,
 * the conversation it happened in, where the queue stood. That is the part a
 * model misremembers and the part a fix actually needs, so it is not asked
 * for.
 *
 * The same bug met twice is one report that has happened twice, matched by
 * meaning rather than by wording. See likeness.ts.
 */

/** How many occurrences a report keeps, as with a want. */
const OCCURRENCES = 12;

/**
 * The app as it stood, at the moment of filing.
 *
 * Everything here is the server's own answer to a question the assistant was
 * not asked. A report that said "there was a card up" because the model
 * believed there was would be worse than no report: it would send whoever
 * reads it looking for a fault in the wrong place.
 */
export interface Context {
  /** The card waiting when this was filed, or null when there was none. */
  card: {
    target: string;
    target_id: number | null;
    field: string;
    action: string;
    answers: string[];
    recommend: string;
    question_id: number | null;
    /** When it was put up, which says how long it had been waiting. */
    at: string;
  } | null;
  /** The conversation that was asking, so its transcript can be read. */
  conversation: number | null;
  queue: { left: number; settled: number };
  at: string;
}

export interface Occurrence {
  id: number;
  context: Context;
  said: string;
  at: string;
}

export interface Bug {
  id: number;
  title: string;
  doing: string;
  expected: string;
  happened: string;
  hits: number;
  fixed_at: string | null;
  first_at: string;
  last_at: string;
  occurrences: Occurrence[];
}

interface BugRow {
  id: number;
  title: string;
  doing: string;
  expected: string;
  happened: string;
  hits: number;
  fixed_at: string | null;
  first_at: string;
  last_at: string;
}

interface OccurrenceRow {
  id: number;
  bug_id: number;
  context: string;
  said: string;
  at: string;
}

/** What has been filed. Open ones first, each with its occurrences. */
export async function bugReports(includeFixed = true): Promise<Bug[]> {
  const rows = await all<BugRow>(
    `SELECT id, title, doing, expected, happened, hits, fixed_at, first_at, last_at
       FROM bug_reports
      ${includeFixed ? "" : "WHERE fixed_at IS NULL"}
      ORDER BY fixed_at IS NOT NULL, last_at DESC`,
  );
  if (rows.length === 0) return [];

  const seen = await all<OccurrenceRow>(
    `SELECT id, bug_id, context, said, at FROM bug_occurrences ORDER BY at DESC, id DESC`,
  );
  return rows.map((row) => ({
    ...row,
    occurrences: seen
      .filter((one) => one.bug_id === row.id)
      .map(({ bug_id: _bug, context, ...rest }) => ({ ...rest, context: readContext(context) })),
  }));
}

function readContext(stored: string): Context {
  try {
    return JSON.parse(stored) as Context;
  } catch {
    return { card: null, conversation: null, queue: { left: 0, settled: 0 }, at: "" };
  }
}

/** Read off the server, never asked of the assistant. */
async function nowShowing(): Promise<Context> {
  const [{ pendingEdit }, { progress }] = await Promise.all([
    import("./pending.js"),
    import("./queue.js"),
  ]);
  const card = await pendingEdit();

  return {
    card: card
      ? {
          target: card.target,
          target_id: card.target_id,
          field: card.field,
          action: card.action,
          answers: card.answers,
          recommend: card.recommend,
          question_id: card.question_id,
          at: card.at,
        }
      : null,
    conversation: await askingThread(),
    queue: await progress(),
    at: new Date().toISOString(),
  };
}

export interface Filed {
  bug: Bug;
  /** True when this joined a report already filed rather than making one. */
  again: boolean;
}

/**
 * File one, or add an occurrence to the report it already is.
 *
 * The account is kept from the latest telling. A second sighting usually
 * describes the fault better than the first, because by then the assistant
 * has seen it twice.
 */
export async function reportBug(report: {
  title: string;
  doing: string;
  expected: string;
  happened: string;
}): Promise<Filed> {
  const title = report.title.trim();
  if (!title) throw new Error("Give it a one-line title.");
  if (!report.doing.trim()) throw new Error("Say what you were doing.");
  if (!report.expected.trim()) throw new Error("Say what you expected to happen.");
  if (!report.happened.trim()) throw new Error("Say what happened instead.");

  const context = await nowShowing();

  const open = await bugReports();
  const which = await sameAs(
    `${title} — ${report.happened.trim()}`,
    open.map((one) => one.title),
  );
  const found = which == null ? undefined : open[which];

  let id: number;
  let again: boolean;

  if (found) {
    /*
      A report that was marked fixed and has happened again is open again.
      Keeping it shut because somebody once said it was done is how a list
      like this stops being worth reading.
    */
    await run(
      `UPDATE bug_reports
          SET hits = hits + 1, doing = ?, expected = ?, happened = ?,
              fixed_at = NULL, last_at = datetime('now')
        WHERE id = ?`,
      report.doing.trim(),
      report.expected.trim(),
      report.happened.trim(),
      found.id,
    );
    id = found.id;
    again = true;
  } else {
    await run(
      `INSERT INTO bug_reports (title, doing, expected, happened) VALUES (?, ?, ?, ?)
         ON CONFLICT (title) DO UPDATE
          SET hits = hits + 1, doing = excluded.doing, expected = excluded.expected,
              happened = excluded.happened, fixed_at = NULL, last_at = datetime('now')`,
      title,
      report.doing.trim(),
      report.expected.trim(),
      report.happened.trim(),
    );
    const made = await get<BugRow>(`SELECT id, hits FROM bug_reports WHERE title = ?`, title);
    id = made!.id;
    again = made!.hits > 1;
  }

  await run(
    `INSERT INTO bug_occurrences (bug_id, context, said) VALUES (?, ?, ?)`,
    id,
    JSON.stringify(context),
    report.happened.trim(),
  );

  /* The first sighting and the newest eleven, as with a want's cases. */
  await run(
    `DELETE FROM bug_occurrences
      WHERE bug_id = ?
        AND id NOT IN (SELECT MIN(id) FROM bug_occurrences WHERE bug_id = ?)
        AND id NOT IN (
          SELECT id FROM bug_occurrences WHERE bug_id = ? ORDER BY id DESC LIMIT ?
        )`,
    id,
    id,
    id,
    OCCURRENCES - 1,
  );

  const fresh = (await bugReports()).find((one) => one.id === id)!;
  return { bug: fresh, again };
}

/** Somebody says it is dealt with. It comes back if it happens again. */
export async function markFixed(id: number, fixed = true): Promise<{ ok: boolean }> {
  const done = await run(
    `UPDATE bug_reports SET fixed_at = ${fixed ? "datetime('now')" : "NULL"} WHERE id = ?`,
    id,
  );
  return { ok: done.changes > 0 };
}

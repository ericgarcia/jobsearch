import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "./config.js";
import { all, get, run } from "./db/client.js";
import { credentialEnv, readCredential } from "./settings.js";

/**
 * Answers the assistant wanted and could not give.
 *
 * What a card can do is a closed set: the server has to carry an answer out,
 * and what a button does must never come from text, because the assistant
 * reads documents and postings somebody else wrote. See the note on `Answer`
 * in pending.ts.
 *
 * A closed set is still a guess about what the work needs, though, and the
 * assistant is what meets the cases the guess missed — the line that wants
 * splitting in two, the two roles that want merging, the date that wants
 * marking unknown rather than wrong. Those used to go nowhere. The
 * assistant worked around the card, explained the limit in the thread, and
 * the next conversation hit the same wall with no trace that the first one
 * had.
 *
 * So a want is recorded instead of acted on. Nothing here changes what a
 * card does; this is a list for whoever decides what the next answer type
 * is, shown on the admin page with how often it has come up.
 *
 * The same want gets a vote rather than a second row, and sameness is a
 * judgement about meaning: "split this in two" and "break the line up" are
 * one want described twice, and no comparison of the strings will say so. A
 * model reads the existing names and says which one this is, if any, and
 * falls back to exact-name matching when there is no credential or the call
 * fails. A duplicate row is a worse outcome than a slow one, not a wrong
 * one, so the fallback is allowed to be blunt.
 */

export const WISH_MODEL = process.env.JOBSEARCH_WISH_MODEL ?? "claude-haiku-5-5";

/** How many cases a want keeps. See the note on wish_cases in schema.sql. */
const CASES = 12;

/**
 * The card a case was taken from, as a contract rather than as a component.
 *
 * What is recorded is what the server knows and a test would be written
 * against: which kind of thing the card was about, what it was doing, which
 * answers it could offer. Not the name of whatever drew it — the server has
 * no view of the component tree, so that would be a guess, and a guess that
 * goes stale at the next rename while the target kind does not.
 */
export interface Shape {
  target: string;
  action: string;
  field: string;
  answers: string[];
  recommended: string;
  /** Whether anything was stored for it already. */
  had_value: boolean;
}

export interface WishCase {
  id: number;
  saw: string;
  shape: Shape;
  wanted: string;
  expect: string;
  at: string;
}

export interface Wish {
  id: number;
  name: string;
  why: string;
  votes: number;
  first_at: string;
  last_at: string;
  /** The cases behind it, newest first. Up to twelve. */
  cases: WishCase[];
}

/**
 * The seam where a case would be scrubbed.
 *
 * Nothing today: the database is one person's, it is not encrypted, and it
 * already holds the whole profile unredacted, so replacing names in a case
 * beside it would protect nothing from anybody who has the file.
 *
 * It is a function rather than nothing at all because of where this is
 * going. Once the app is a site that other people's data passes through,
 * these cases become the part most likely to be handed around — pasted into
 * an issue, read by whoever builds the answer, kept as a fixture — and the
 * redaction then belongs here, in one body, rather than in a migration over
 * rows already written without it.
 */
function asStored(text: string): string {
  return text;
}

interface WishRow {
  id: number;
  name: string;
  why: string;
  votes: number;
  first_at: string;
  last_at: string;
}

interface CaseRow {
  id: number;
  wish_id: number;
  saw: string;
  shape: string;
  wanted: string;
  expect: string;
  at: string;
}

/** What is piling up, the most wanted first, each with its cases. */
export async function wishedActions(): Promise<Wish[]> {
  const rows = await all<WishRow>(
    `SELECT id, name, why, votes, first_at, last_at
       FROM wished_actions ORDER BY votes DESC, last_at DESC`,
  );
  const cases = await all<CaseRow>(
    `SELECT id, wish_id, saw, shape, wanted, expect, at FROM wish_cases ORDER BY at DESC, id DESC`,
  );
  return rows.map((row) => ({
    ...row,
    cases: cases
      .filter((one) => one.wish_id === row.id)
      .map(({ wish_id: _wish, shape, ...rest }) => ({ ...rest, shape: readShape(shape) })),
  }));
}

/** A shape written by an older version, or by hand, is still worth showing. */
function readShape(stored: string): Shape {
  try {
    const read = JSON.parse(stored) as Partial<Shape>;
    return {
      target: read.target ?? "",
      action: read.action ?? "",
      field: read.field ?? "",
      answers: Array.isArray(read.answers) ? read.answers : [],
      recommended: read.recommended ?? "",
      had_value: Boolean(read.had_value),
    };
  } catch {
    return { target: "", action: "", field: "", answers: [], recommended: "", had_value: false };
  }
}

const INSTRUCTIONS = `You match one request against a list of existing ones.

You are given NAMES, a numbered list of answer types somebody has already
asked for, and WANT, a new request. Say which existing one means the same
thing as WANT — the same effect on the profile, however differently it is
worded.

Reply with the number alone, or the word "new" if none of them is the same
thing. Nothing else. Two requests are the same only if carrying one out
would carry out the other; "split this line in two" and "break this bullet
up" are the same, "drop this line" and "shorten this line" are not.`;

/** Which existing want this is, by meaning. Null when it is a new one. */
async function sameAs(want: string, names: string[]): Promise<number | null> {
  if (names.length === 0) return null;

  const credential = await readCredential();
  if (!credential) return byName(want, names);

  const listed = names.map((name, index) => `${index + 1}. ${name}`).join("\n");
  let text = "";
  try {
    for await (const message of query({
      prompt: `NAMES\n\n${listed}\n\nWANT\n\n${want}`,
      options: {
        model: WISH_MODEL,
        cwd: DATA_DIR,
        systemPrompt: INSTRUCTIONS,
        tools: [],
        settingSources: [],
        maxTurns: 1,
        env: credentialEnv(credential),
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") text += block.text;
        }
      }
      if (message.type === "result" && message.subtype !== "success") {
        throw new Error(`matching stopped: ${message.subtype}`);
      }
    }
  } catch {
    return byName(want, names);
  }

  const said = text.trim().toLowerCase();
  if (said.startsWith("new")) return null;
  const which = Number.parseInt(said, 10);
  if (!Number.isInteger(which) || which < 1 || which > names.length) {
    return byName(want, names);
  }
  return which - 1;
}

/** The blunt fallback: the same name, give or take case and spacing. */
function byName(want: string, names: string[]): number | null {
  const flat = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  const found = names.findIndex((name) => flat(name) === flat(want));
  return found === -1 ? null : found;
}

export interface Wished {
  wish: Wish;
  /** True when this joined a want already on the list rather than making one. */
  voted: boolean;
  /** True when a card was up to take a case from. */
  withCase: boolean;
}

/**
 * Keep a case, and keep the list of them short.
 *
 * The first telling stays whatever else happens: it is usually the clearest,
 * written before the assistant had worked out a way around the limit. The
 * rest of the room goes to the newest, which are the ones still happening.
 */
async function keepCase(
  wishId: number,
  snapshot: { saw: string; shape: Shape; wanted: string; expect: string },
): Promise<void> {
  await run(
    `INSERT INTO wish_cases (wish_id, saw, shape, wanted, expect) VALUES (?, ?, ?, ?, ?)`,
    wishId,
    asStored(snapshot.saw),
    JSON.stringify(snapshot.shape),
    snapshot.wanted.trim(),
    snapshot.expect.trim(),
  );

  await run(
    `DELETE FROM wish_cases
      WHERE wish_id = ?
        AND id NOT IN (SELECT MIN(id) FROM wish_cases WHERE wish_id = ?)
        AND id NOT IN (
          SELECT id FROM wish_cases WHERE wish_id = ? ORDER BY id DESC LIMIT ?
        )`,
    wishId,
    wishId,
    wishId,
    CASES - 1,
  );
}

/**
 * Record a want, or add a vote to the one it already is.
 *
 * `why` is kept from the latest telling rather than the first: the newest
 * account is the one written with the most cases behind it, and the votes
 * say how long it has been accumulating.
 */
export async function wishForAnswer(
  name: string,
  why: string,
  /**
   * The case, when there was a card up to take one from.
   *
   * `saw`, the shape and the recommendation all come off the waiting card
   * rather than from the assistant, so none of it can be misremembered or
   * made up; what the assistant brings is the part only it knows — what it
   * would have done, and what should be true afterwards.
   */
  about?: { wanted: string; expect: string },
): Promise<Wished> {
  const wanted = name.trim();
  if (!wanted) throw new Error("Say what the answer would be called.");
  if (!why.trim()) throw new Error("Say what it is for, in one line.");
  if (about && !about.wanted.trim()) throw new Error("Say what you would have done.");
  if (about && !about.expect.trim()) {
    throw new Error("Say what should be true afterwards. It is the test this case is for.");
  }

  const snapshot = about ? await fromWaitingCard(about) : undefined;

  const already = await wishedActions();
  const which = await sameAs(`${wanted} — ${why.trim()}`, already.map((one) => one.name));

  const found = which == null ? undefined : already[which];
  let id: number;
  let voted: boolean;

  if (found) {
    await run(
      `UPDATE wished_actions
          SET votes = votes + 1, why = ?, last_at = datetime('now')
        WHERE id = ?`,
      why.trim(),
      found.id,
    );
    id = found.id;
    voted = true;
  } else {
    await run(
      `INSERT INTO wished_actions (name, why) VALUES (?, ?)
         ON CONFLICT (name) DO UPDATE
          SET votes = votes + 1, why = excluded.why, last_at = datetime('now')`,
      wanted,
      why.trim(),
    );
    const made = await get<WishRow>(`SELECT id, votes FROM wished_actions WHERE name = ?`, wanted);
    id = made!.id;
    voted = made!.votes > 1;
  }

  if (snapshot) await keepCase(id, snapshot);

  const fresh = (await wishedActions()).find((one) => one.id === id)!;
  return { wish: fresh, voted, withCase: Boolean(snapshot) };
}

/**
 * The card that was on the screen, turned into a case.
 *
 * Nothing is asked of the assistant that the server already has. A wish
 * raised with no card waiting records the want and no case: there is nothing
 * to take a snapshot of, and a case invented from memory is the one kind of
 * fixture that is worse than none.
 */
async function fromWaitingCard(about: {
  wanted: string;
  expect: string;
}): Promise<{ saw: string; shape: Shape; wanted: string; expect: string } | undefined> {
  const { pendingEdit } = await import("./pending.js");
  const card = await pendingEdit();
  if (!card) return undefined;

  return {
    saw: card.current ?? card.value,
    shape: {
      target: card.target,
      action: card.action,
      field: card.field,
      answers: card.answers,
      recommended: card.recommend,
      had_value: card.current != null,
    },
    wanted: about.wanted,
    expect: about.expect,
  };
}

import { all, get, run } from "../db/client.js";
import { changed } from "../notify.js";
import { TOPIC_QUESTIONS, TOPICS } from "./form.js";

/**
 * What the person has told this app about themselves.
 *
 * One open store, replacing a closed list of eight topics. The list was the
 * reason this app could not learn: a question outside it had nowhere to go,
 * so it was answered once for one employer and thrown away, and the next
 * form asking the same thing asked the person again. "Do you hold a security
 * clearance?", "How many years of Python?", "Highest degree?" — all facts
 * about them, none of them storable.
 *
 * Open, then, and the eight topics are now seed rows rather than a ceiling.
 *
 * Two distinctions in here are easy to collapse and expensive to get wrong.
 *
 * A refusal is not a missing answer. "Nothing stored" is a question to ask;
 * `state: "declined"` is a question already answered, with "I would rather
 * not say". An app that cannot tell them apart asks again on every
 * application, which is the person being overruled once per employer.
 *
 * And declining to tell *this app* is not the same as declining to tell an
 * employer. "Prefer not to disclose" is an option printed on the form: a
 * person who wants it ticked has an answer, stored as the `decline` token,
 * and this store says `answered`. A person who does not want the app to hold
 * the thing at all is `declined`, and nothing is stored to tick anything
 * with. The first goes on the form; the second keeps the field blank.
 *
 * A private fact — the voluntary self-identification questions — has a row
 * here carrying its state, its sharing and where it came from, and never its
 * answer. Those values live in self_identification and are read by two
 * callers: the person's own page, and the code that types into a form. The
 * semantics are shared across both kinds of fact; the storage is not, and the
 * CHECK on the table is there so a mistake in this file fails loudly rather
 * than quietly copying someone's disability status into a second place.
 */

export type FactState = "answered" | "declined" | "asked";
export type Sensitivity = "open" | "private";
export type Share = "always" | "ask" | "never";

export interface Fact {
  slug: string;
  question: string;
  /** Their own words. Always null for a private fact: the value is elsewhere. */
  answer: string | null;
  state: FactState;
  sensitivity: Sensitivity;
  /**
   * Whether the answer may be offered to an employer.
   *
   * `always` fills the field when a form asks — what a standing answer has
   * always done. `ask` offers it only once confirmed for that application,
   * which is every private fact. `never` keeps it on file and off forms.
   */
  share: Share;
  /** onboarding, resume:3, linkedin, application:2037, profile. */
  source: string | null;
  updated_at: string;
}

interface Row {
  slug: string;
  question: string;
  answer: string | null;
  state: string;
  sensitivity: string;
  share: string;
  source: string | null;
  updated_at: string;
}

function factOf(row: Row): Fact {
  return {
    slug: row.slug,
    question: row.question,
    answer: row.answer,
    state: row.state as FactState,
    sensitivity: row.sensitivity as Sensitivity,
    share: row.share as Share,
    source: row.source,
    updated_at: row.updated_at,
  };
}

const COLUMNS = `slug, question, answer, state, sensitivity, share, source, updated_at`;

export async function listFacts(sensitivity?: Sensitivity): Promise<Fact[]> {
  const rows = sensitivity
    ? await all<Row>(`SELECT ${COLUMNS} FROM facts WHERE sensitivity = ? ORDER BY slug`, sensitivity)
    : await all<Row>(`SELECT ${COLUMNS} FROM facts ORDER BY slug`);
  return rows.map(factOf);
}

export async function getFact(slug: string): Promise<Fact | null> {
  const row = await get<Row>(`SELECT ${COLUMNS} FROM facts WHERE slug = ?`, slug);
  return row ? factOf(row) : null;
}

/**
 * The facts a form may be filled from.
 *
 * Answered, and shareable. A declined fact is not here, and neither is one
 * the person keeps for themselves — both of which are different from having
 * nothing, and both of which the caller would otherwise have to remember.
 */
export async function shareableFacts(): Promise<Fact[]> {
  const rows = await all<Row>(
    `SELECT ${COLUMNS} FROM facts
       WHERE state = 'answered' AND share <> 'never' AND answer IS NOT NULL
       ORDER BY slug`,
  );
  return rows.map(factOf);
}

/**
 * The facts a form's question could be asking for.
 *
 * Wider than shareableFacts on purpose: a question the person has refused is
 * still a question with a name, and matching a field to it is how the app can
 * say "you asked not to be asked this" instead of "nothing on file answers
 * this". A fact in the `asked` state is left out — there is neither an answer
 * nor a refusal to report.
 */
export async function candidateFacts(): Promise<Fact[]> {
  const rows = await all<Row>(
    `SELECT ${COLUMNS} FROM facts
       WHERE sensitivity = 'open' AND state IN ('answered', 'declined')
       ORDER BY slug`,
  );
  return rows.map(factOf);
}

interface Written {
  slug: string;
  question?: string;
  answer?: string | null;
  state?: FactState;
  sensitivity?: Sensitivity;
  share?: Share;
  source?: string | null;
}

/*
  One writer, and the general form of it.

  `recordFact` is for a caller that is setting the state of a question rather
  than answering it — a private fact, whose answer is kept elsewhere, or a
  question a form asked. Prefer setFact, declineFact and noteAsked where they
  fit; they say what they mean.

  Every path into this table goes through here — the person's page, an
  onboarding import, an answer kept from an application — so the invariant
  about private answers is enforced in one place and the row keeps whatever
  the caller did not mention. A patch that dropped the question or reset the
  sharing on an unrelated write is the kind of bug that shows up weeks later
  as a form filled with something the person thought they had withheld.
*/
export async function recordFact(patch: Written): Promise<Fact> {
  return await write(patch);
}

async function write(patch: Written): Promise<Fact> {
  const existing = await getFact(patch.slug);
  const sensitivity = patch.sensitivity ?? existing?.sensitivity ?? "open";

  if (sensitivity === "private" && patch.answer != null && patch.answer !== "") {
    throw new Error(
      `A private fact's answer is not stored in facts: ${patch.slug}. Write it with setSelfIdentification.`,
    );
  }

  const question =
    patch.question ?? existing?.question ?? patch.slug.replace(/_/g, " ");
  const state = patch.state ?? existing?.state ?? "answered";
  const share = patch.share ?? existing?.share ?? (sensitivity === "private" ? "ask" : "always");
  const answer = sensitivity === "private" ? null : (patch.answer ?? existing?.answer ?? null);
  const source = patch.source !== undefined ? patch.source : (existing?.source ?? null);

  await run(
    `INSERT INTO facts (${COLUMNS})
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (slug) DO UPDATE SET
          question = excluded.question, answer = excluded.answer,
          state = excluded.state, sensitivity = excluded.sensitivity,
          share = excluded.share, source = excluded.source,
          updated_at = excluded.updated_at`,
    patch.slug,
    question,
    answer,
    state,
    sensitivity,
    share,
    source,
  );

  changed("profile");
  return (await getFact(patch.slug))!;
}

/**
 * Store an answer, in their own words.
 *
 * An empty answer is a removal rather than an empty string, because a stored
 * blank would read as answered and fill a form with nothing.
 */
export async function setFact(patch: Written & { answer: string }): Promise<Fact | null> {
  if (!patch.answer.trim()) {
    await forgetFact(patch.slug);
    return null;
  }
  return await write({ ...patch, answer: patch.answer.trim(), state: "answered" });
}

/**
 * Record that they would rather not say, so that nothing asks again.
 *
 * The answer goes, including the private one in its own table: a row that
 * says "declined" while holding a value says two things, and the one a form
 * would act on is the value.
 */
export async function declineFact(patch: Omit<Written, "answer" | "state">): Promise<Fact> {
  const sensitivity = patch.sensitivity ?? (await getFact(patch.slug))?.sensitivity ?? "open";
  if (sensitivity === "private") {
    await run(`DELETE FROM self_identification WHERE key = ?`, patch.slug);
  }
  return await write({ ...patch, answer: null, state: "declined", share: "never" });
}

/** Undo a refusal, leaving the question asked and unanswered. */
export async function reopenFact(slug: string): Promise<Fact | null> {
  const existing = await getFact(slug);
  if (!existing || existing.state !== "declined") return existing;
  return await write({
    slug,
    state: "asked",
    share: existing.sensitivity === "private" ? "ask" : "always",
  });
}

export async function setFactShare(slug: string, share: Share): Promise<Fact | null> {
  const existing = await getFact(slug);
  if (!existing) return null;
  return await write({ slug, share });
}

/**
 * Note that a form asked something nothing can answer.
 *
 * The point of writing these down is that "the questions you keep being
 * asked and have nothing on file for" becomes a query rather than a guess —
 * which is the list worth putting in front of someone who is rounding out
 * their profile. It never overwrites an answer and never reopens a refusal.
 */
export async function noteAsked(patch: Omit<Written, "answer" | "state">): Promise<Fact | null> {
  const existing = await getFact(patch.slug);
  if (existing) return existing;
  return await write({ ...patch, state: "asked" });
}

export async function forgetFact(slug: string): Promise<boolean> {
  const existing = await getFact(slug);
  if (!existing) return false;
  await run(`DELETE FROM facts WHERE slug = ?`, slug);
  if (existing.sensitivity === "private") {
    await run(`DELETE FROM self_identification WHERE key = ?`, slug);
  }
  changed("profile");
  return true;
}

/**
 * The eight situation questions, as seed rows.
 *
 * They are seeds and not a schema: a seed can be declined, edited or deleted,
 * and a question the list has never heard of is stored beside them with the
 * same standing. That is the whole difference from the enum this replaces.
 */
export function seedQuestions(): { slug: string; question: string }[] {
  return TOPICS.map((topic) => ({ slug: topic, question: TOPIC_QUESTIONS[topic] }));
}

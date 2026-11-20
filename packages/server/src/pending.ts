import { randomUUID } from "node:crypto";
import { get, run } from "./db/client.js";
import { changed } from "./notify.js";
import { noteAsking } from "./asking.js";
import * as profile from "./profile.js";
import { forgetFact, getFact, setFact } from "./apply/facts.js";

/**
 * The one change the assistant is proposing, waiting for an answer.
 *
 * Onboarding kept turning into a form. The import reads a whole document in
 * one go, so the conversation about it arrived as six numbered decisions and
 * "tell me your answers in 1–2" — which is a form, and a form is the thing
 * somebody was avoiding by handing over a resume in the first place.
 *
 * The fix is not a better instruction. There is one slot: a second proposal
 * has nowhere to go until the first is answered, so asking one thing at a
 * time is a property of the table rather than a rule the assistant has to
 * keep. See schema.sql.
 *
 * What it proposes is never stored by proposing it. The value appears in the
 * field it would go into, highlighted, with the page scrolled to it; the
 * person types over it if they want to and keeps or skips it. Writing happens
 * on their click, with whatever text is in the box at that moment.
 *
 * That last part is also what lets the assistant draft. It can write a line
 * and propose it, because proposing is not storing: the person reads it in
 * the box, rewrites it there if they want to, and presses Keep or Skip. The
 * approval is a step in the table rather than a caution in a prompt, which is
 * the enforcement that does not depend on the model.
 *
 * So the line it may not cross is substance, not authorship. A figure, a
 * date, an employer, a result that is in neither the profile nor the
 * conversation does not belong in a proposal, whatever it would do for the
 * sentence. Wording is the assistant's to offer; facts are not its to make.
 * An earlier version of this comment forbade composing a sentence at all,
 * and the assistant obeyed it by answering "help me make this line better"
 * with a critique and no draft — which is the work the person was asking it
 * to do.
 */

/**
 * What can be proposed, and on what.
 *
 * Widening this list means widening both `currently` and `resolve` below, so
 * a target that is listed here is a target that can actually be written. A
 * proposal that could be made and not carried out would be a question nobody
 * can answer.
 */
const FIELDS: Record<string, readonly string[]> = {
  profile: ["name", "headline", "email", "phone", "location", "summary"],
  role: ["company", "title", "location", "start_date", "end_date"],
  bullet: ["text"],
  fact: ["answer"],
  education: ["school", "degree", "field", "start_date", "end_date"],
  skills: ["names"],
};

/*
  The skills list, which is a section rather than a row.

  Everything else here names one thing: this line, that degree, this field of
  the profile. The skills list is one box of many short names, and the
  question that keeps coming up about it is always the same — their lines
  show them using something that is not in the list. Until this existed the
  assistant had no row to put that on, so it asked in the conversation, named
  three tools, and the person read about a section the page highlighted in no
  way at all.

  So a skills proposal carries names rather than a value: "Claude Code,
  Playwright, UNet" in one card, offered in place among the pills already
  there. One card for the set and not one per name, because four cards
  answered one after another is the form this app exists to avoid.
*/

/** The names in a skills proposal, in the order they were written. */
export function namesIn(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[,\n]/)) {
    const name = part.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** Which targets are a row that can be removed outright. */
const REMOVABLE = new Set(["role", "bullet", "fact", "education"]);

/**
 * What a proposal is doing.
 *
 * "ask" is the one that is not a proposal at all. Some of what the queue
 * holds is a question nobody can answer from the document — two roles whose
 * dates overlap, a degree the summary and the education section disagree
 * about — and the assistant had no way to put one of those on the page. It
 * asked in the conversation instead, and the profile highlighted nothing,
 * so the person was asked about a role without being shown which one.
 *
 * An "ask" highlights the thing and carries the question, with the stored
 * text in the box to correct. Keeping it writes whatever is in the box,
 * exactly as a "set" does, so an answer and a correction are the same
 * gesture.
 */
export type EditAction = "set" | "delete" | "ask" | "add";

/**
 * The answers a card can be given. A closed set, for two reasons.
 *
 * The server has to carry the answer out, so an answer it does not know is a
 * button that does nothing. And the assistant reads documents and postings
 * that somebody else wrote: if what a button does came from text rather than
 * from this list, a line in an imported resume could name its own effect.
 * Wording is the assistant's; effect is not.
 *
 * "use" writes what is in the box, "leave" writes nothing and changes
 * nothing, "drop" removes the row the card is about. Which of the three a
 * card offers follows from what it is asking — see `answersFor`.
 *
 * When none of them is what the assistant wanted, it says so with
 * wish_for_answer and the want is recorded for whoever decides the next one.
 * See wishes.ts: a want is data, never a fourth answer at runtime.
 */
export type Answer = "use" | "leave" | "drop";

const ANSWERS = new Set<Answer>(["use", "leave", "drop"]);

/**
 * Which answers this card offers, and in which order.
 *
 * The card used to work this out from the action as it rendered, which is
 * how it came to ask "keep it as it is, trim it, or drop it?" above two
 * buttons, neither of which dropped anything. The question is the
 * assistant's, so the answers have to be able to match it.
 */
export function answersFor(edit: {
  action: EditAction;
  target: string;
  target_id: number | null;
  target_key: string | null;
}): Answer[] {
  /*
    The skills list answers for itself. A card that offers names to add is
    keep-or-not; a card about names already on the list is the opposite
    question — "no line of yours shows these, do they stay?" — and the only
    two answers to that are leaving them and dropping them. There is nothing
    to update, because the card is about which names are there rather than
    about the text of any one of them.
  */
  if (edit.target === "skills") {
    return edit.action === "ask" ? ["leave", "drop"] : ["use", "leave"];
  }
  if (edit.action === "add") return ["use", "leave"];
  if (edit.action === "delete") return ["use", "leave"];

  /* A row that exists can be removed outright; a profile field cannot. */
  const named =
    edit.target === "fact" ? Boolean(edit.target_key) : edit.target_id != null;
  return REMOVABLE.has(edit.target) && named ? ["use", "leave", "drop"] : ["use", "leave"];
}

/*
  "add" proposes something that is not there yet.

  The import deliberately leaves lines out — a company tagline among
  somebody's own work, a paragraph that describes the product rather than
  what they did — and then asks whether they want them after all. Until this
  existed there was no way to put that question on the page: set, delete and
  ask all name a row that exists, and the line in question is precisely the
  one that does not. So the assistant asked in the conversation, and the
  profile highlighted nothing, because there was nothing yet to highlight.

  For an add, target_id names the parent rather than the row: the role the
  line would go under. There is no current value, so the card shows the
  proposed line alone.
*/

export interface PendingEdit {
  target: string;
  target_id: number | null;
  /** For a fact, whose key is a slug rather than a row id. */
  target_key: string | null;
  /** The queued question this answers, when it answers one. */
  question_id: number | null;
  field: string;
  action: EditAction;
  /** What would be stored, if they keep it as it stands. */
  value: string;
  /** One line on why, shown beside the field. */
  why: string;
  /** What is there now, so the page can show this as a change. */
  current: string | null;
  /** The answers this card offers, in the order it shows them. */
  answers: Answer[];
  /** The one it recommends, which is the highlighted button. */
  recommend: Answer;
  /**
   * The phrase inside the stored text that the question is about.
   *
   * A card highlights a whole field, which is right for a line of a resume
   * and wrong for a four-paragraph summary: the question "where did you
   * build low-latency serving?" is about four words of it, and showing the
   * person all four paragraphs leaves them to find the part in question.
   *
   * It is a span of the stored text and not free text, checked against it
   * when the card is made: a quote that is not there, or that is there
   * twice, is refused rather than shown unmarked. So the mark on the page
   * is always the assistant's own words pointing at the person's.
   */
  quote: string | null;
  /**
   * The fields of this row the question is about, with what is stored in
   * each, when it is about more than the one the box writes.
   *
   * A card takes one field. The question "were you doing NuMundo alongside
   * Preact?" is about a role's two dates, and with one field to point at,
   * the assistant put the card on the job title — which says nothing about
   * dates, and left the person reading a question about an overlap beside a
   * box containing the word "CTO". Now the card can show both dates, and
   * say which of them the box writes.
   *
   * Resolved here rather than on the page, since the stored values are the
   * server's to read. Empty when the question is about one field alone.
   */
  fields: { field: string; value: string | null; edits: boolean }[];
  /**
   * What this card is, for anything that has to say "this one and not that".
   *
   * It was `at` until a card arrived in the same second as the one it
   * replaced, at which point the two were the same card as far as the page
   * could tell: the box did not re-seed, because the effect watching for a
   * new card saw no change, and the registry that records which card is on
   * the screen could not tell a claim from a release. A second is a short
   * time to a person and a long one to a replacement that happens on their
   * click. So the card carries something nothing else will have.
   */
  token: string;
  at: string;
}

interface Row {
  target: string;
  target_id: number | null;
  target_key: string | null;
  question_id: number | null;
  field: string;
  action: string;
  value: string;
  why: string;
  recommend: string;
  quote: string | null;
  fields: string | null;
  token: string | null;
  at: string;
}

/**
 * Whether the row a card is about is still there.
 *
 * A proposal names a row by id, and ids outlive the rows they named. The
 * assistant read a question queued against a line, proposed a rewrite of it,
 * and the line had been deleted an hour earlier — so the card had no row to
 * paint itself over, fell through to the fallback at the top of the pane,
 * and offered three buttons of which none could do anything: an update that
 * wrote to a missing id, a drop that deleted nothing.
 *
 * Checked when the card is made, so the assistant is told to ask about
 * something that exists, and again when it is answered, because a row can
 * go between the two — which is the case the fallback was built for.
 */
async function stillThere(row: {
  target: string;
  target_id: number | null;
  target_key: string | null;
}): Promise<boolean> {
  if (row.target === "role") {
    return (await profile.listRoles()).some((one) => one.id === row.target_id);
  }
  if (row.target === "bullet") {
    return (await profile.listBullets()).some((one) => one.id === row.target_id);
  }
  if (row.target === "education") {
    return (await profile.listEducation()).some((one) => one.id === row.target_id);
  }
  if (row.target === "fact") {
    return Boolean(row.target_key && (await getFact(row.target_key)));
  }
  /* The profile and the skills list are always there. */
  return true;
}

/**
 * What a card's `target_id` names, which is not always the card's target.
 *
 * For an add it is the role the line would join, because the line itself
 * does not exist yet. Everywhere else it is the row the card is about.
 *
 * One function because the two callers got out of step the day they were
 * written apart: the check when a card is made knew about the add, and the
 * check when it is answered did not, so it looked for a *bullet* with the
 * role's number. Bullet 7 had been deleted, role 7 had not, and an offered
 * line under role 7 closed itself saying the line was no longer on the
 * profile. The numbers were not colliding — a bullet and a role may both be
 * 7 — the lookup was simply in the wrong table, and the one place to make
 * sure that cannot differ is here.
 */
function whatItNames(edit: {
  target: string;
  target_id: number | null;
  target_key: string | null;
  action: EditAction;
}): { target: string; target_id: number | null; target_key: string | null } {
  if (edit.action === "add" && edit.target === "bullet") {
    return { target: "role", target_id: edit.target_id, target_key: null };
  }
  return { target: edit.target, target_id: edit.target_id, target_key: edit.target_key };
}

/** What is stored for this thing right now, so the page can show a change. */
async function currently(row: {
  target: string;
  target_id: number | null;
  target_key: string | null;
  field: string;
  action?: string;
}): Promise<string | null> {
  const text = (value: unknown) => (typeof value === "string" ? value : null);

  if (row.target === "profile") {
    const kept = await profile.getProfile();
    return text((kept as unknown as Record<string, unknown>)[row.field]);
  }
  if (row.target === "role" && row.target_id != null) {
    const kept = (await profile.listRoles()).find((one) => one.id === row.target_id);
    return kept ? text((kept as unknown as Record<string, unknown>)[row.field]) : null;
  }
  if (row.target === "bullet" && row.target_id != null) {
    /* For an add, target_id is the role it would join: nothing is stored yet. */
    if (row.action === "add") return null;
    const kept = (await profile.listBullets()).find((one) => one.id === row.target_id);
    return kept?.text ?? null;
  }
  if (row.target === "education" && row.target_id != null) {
    const kept = (await profile.listEducation()).find((one) => one.id === row.target_id);
    return kept ? text((kept as unknown as Record<string, unknown>)[row.field]) : null;
  }
  if (row.target === "fact" && row.target_key) {
    return (await getFact(row.target_key))?.answer ?? null;
  }
  return null;
}

export async function pendingEdit(): Promise<PendingEdit | null> {
  const row = await get<Row>(
    `SELECT target, target_id, target_key, question_id, field, action, value, why, recommend, quote, fields, token, at
       FROM pending_edit WHERE id = 1`,
  );
  if (!row) return null;
  const action: EditAction =
    row.action === "delete"
      ? "delete"
      : row.action === "ask"
        ? "ask"
        : row.action === "add"
          ? "add"
          : "set";
  const answers = answersFor({ ...row, action });
  /*
    A recommendation the card cannot offer is not one. It can only happen to
    a row written before this column existed, or to a line that was removed
    by hand after the card was made, and the first answer is the safe
    reading: it is the one the question is chiefly about.
  */
  const wanted = row.recommend as Answer;

  /*
    The named fields with what is stored in each. Read here because the
    stored values are the server's to read, and because a page that fetched
    them itself would show a different moment than the card was made in.
  */
  let named: string[] = [];
  try {
    const parsed: unknown = row.fields ? JSON.parse(row.fields) : [];
    if (Array.isArray(parsed)) named = parsed.filter((one): one is string => typeof one === "string");
  } catch {
    named = [];
  }
  const fields = await Promise.all(
    named.map(async (field) => ({
      field,
      value: await currently({ ...row, field }),
      edits: field === row.field,
    })),
  );

  return {
    ...row,
    action,
    answers,
    fields,
    /* A card written before this column existed keeps its old identity. */
    token: row.token ?? row.at,
    recommend: answers.includes(wanted) ? wanted : (answers[0] ?? "use"),
    current: await currently(row),
  };
}

/**
 * Who took a proposal out of the slot without it being answered.
 *
 * Two values, because two is all that is known. See `clearEdit`.
 */
export type ClearedBy = "assistant" | "elsewhere";

/** A proposal that left the slot unanswered, and who took it. */
export interface WithdrawnEdit {
  target: string;
  target_id: number | null;
  target_key: string | null;
  field: string;
  action: EditAction;
  value: string;
  why: string;
  by: ClearedBy;
  at: string;
}

/**
 * The last proposal that went without an answer, if the assistant did not
 * take it itself.
 *
 * True until a new proposal occupies the slot or an answer arrives, both of
 * which the assistant hears about by other means. So this is a state the
 * assistant can read whenever it looks, rather than a message it has to
 * catch — a withdrawal it never asked about does not go unsaid, and one it
 * has already been told about is not repeated as news.
 */
export async function withdrawnEdit(): Promise<WithdrawnEdit | null> {
  const row = await get<{
    target: string;
    target_id: number | null;
    target_key: string | null;
    field: string;
    action: string;
    value: string;
    why: string;
    by_whom: string;
    at: string;
  }>(
    `SELECT target, target_id, target_key, field, action, value, why, by_whom, at
       FROM withdrawn_edit WHERE id = 1`,
  );
  if (!row) return null;
  const { by_whom, ...rest } = row;
  return {
    ...rest,
    action: rest.action as EditAction,
    by: by_whom === "assistant" ? "assistant" : "elsewhere",
  };
}

async function forgetWithdrawn(): Promise<void> {
  await run(`DELETE FROM withdrawn_edit WHERE id = 1`);
}

export interface Proposal {
  target: string;
  field: string;
  value: string;
  why: string;
  target_id?: number | null;
  target_key?: string | null;
  action?: EditAction;
  /** The queued question this is an answer to, from next_question. */
  question_id?: number | null;
  /**
   * The phrase in the stored text this question is about, word for word.
   *
   * Checked against what is stored: it has to appear there exactly once.
   * See the note on `quote` in PendingEdit.
   */
  quote?: string | null;
  /**
   * The other fields of this row the question is about, by name.
   *
   * Each has to be a field that can be proposed on this target. See the note
   * on `fields` in PendingEdit.
   */
  fields?: string[] | null;
  /**
   * Which answer the assistant recommends, which the card highlights.
   *
   * Left out it is the answer that carries the proposal out, except for an
   * add, where the import had already judged the line not worth keeping and
   * the card is only there so somebody can overrule that.
   */
  recommend?: Answer;
}

/**
 * Put one change in front of the person.
 *
 * Refuses while another is waiting, and says which — the refusal is the
 * mechanism, not an error. An assistant that has six things to ask about
 * gets told to finish the first.
 */
export async function proposeEdit(
  proposal: Proposal,
): Promise<{ pending: PendingEdit; waiting?: PendingEdit; withdrawn?: WithdrawnEdit }> {
  const allowed = FIELDS[proposal.target];
  if (!allowed) throw new Error(`Nothing can be proposed for "${proposal.target}" yet.`);
  if (!allowed.includes(proposal.field)) {
    throw new Error(
      `"${proposal.field}" is not one of the fields that can be proposed on ${proposal.target}: ${allowed.join(", ")}.`,
    );
  }
  if (!proposal.why.trim()) throw new Error("Say why, in one line. It is shown beside the field.");

  const action: EditAction =
    proposal.action === "delete"
      ? "delete"
      : proposal.action === "ask"
        ? "ask"
        : proposal.action === "add"
          ? "add"
          : "set";
  if (action === "add" && proposal.target !== "bullet" && proposal.target !== "skills") {
    throw new Error(`Only a bullet or a skill can be added this way, not a ${proposal.target}.`);
  }
  if (action === "add" && proposal.target === "bullet" && proposal.target_id == null) {
    throw new Error("An added line needs target_id: the id of the role it goes under.");
  }
  if (action === "add" && !proposal.value.trim()) {
    throw new Error("Nothing to add. Say the line in `value`.");
  }
  /*
    A skills card only ever offers names to add. Changing the list wholesale
    would make one button replace everything in it, and removing a skill is
    one click on the pill itself.
  */
  if (proposal.target === "skills") {
    if (action !== "add" && action !== "ask") {
      throw new Error(
        'A skills card either offers names to add (action "add") or asks about names already on the list (action "ask").',
      );
    }
    const names = namesIn(proposal.value);
    if (names.length === 0) {
      throw new Error("Name the skills in `value`, separated by commas.");
    }
    /*
      An ask is about names that are there. One naming a skill they do not
      have would mark nothing and offer to drop nothing, which is a question
      about a pill that is not on the page.
    */
    if (action === "ask") {
      const have = new Set((await profile.listSkills()).map((one) => one.name.toLowerCase()));
      const missing = names.filter((one) => !have.has(one.toLowerCase()));
      if (missing.length > 0) {
        throw new Error(
          `Not on their skills list: ${missing.join(", ")}. An ask is about skills they have; to offer new ones, use action "add".`,
        );
      }
    }
  }
  if (action === "delete" && !REMOVABLE.has(proposal.target)) {
    throw new Error(`A ${proposal.target} cannot be removed, only changed.`);
  }
  if (proposal.target === "fact") {
    if (!proposal.target_key) throw new Error("A fact is named by its topic; pass target_key.");
  } else if (
    proposal.target !== "profile" &&
    proposal.target !== "skills" &&
    proposal.target_id == null
  ) {
    throw new Error(`A ${proposal.target} is named by its id; pass target_id.`);
  }
  /* An ask has nothing to suggest, so an empty value is the normal case. */
  if (action === "set" && !proposal.value.trim()) {
    throw new Error("Nothing to set. To remove it, propose a deletion instead.");
  }

  /*
    The row has to be there. For an add the id names the role the line would
    join, so it is the role that has to exist; for everything else it is the
    row the card is about. A question queued against a line that was deleted
    afterwards is the way this happens, and the queue is where it should be
    settled rather than on a card nobody can answer.
  */
  const needs = whatItNames({
    target: proposal.target,
    target_id: proposal.target_id ?? null,
    target_key: proposal.target_key ?? null,
    action,
  });
  if (!(await stillThere(needs))) {
    throw new Error(
      `That ${needs.target} is not on their profile — it has been removed, or the id is wrong. Check the profile for what is there now, and settle the question with settle_question if it is about something that no longer exists.`,
    );
  }

  /*
    The quote has to be a span of what is stored.

    Unchecked, it would be the one thing on the card that the assistant
    writes and the person reads as their own text — a mark on words they
    never wrote, or a mark on nothing at all. So it is matched against the
    stored value: exactly once, or the call is refused and says why. Twice
    is refused as well, because a mark on the first of two identical phrases
    points at the wrong one half the time.
  */
  /*
    Every named field has to be one this target can be asked about, for the
    same reason the single field does: a card that showed "notes" or
    "manager" beside a role would be showing something the profile does not
    have. The one the box writes is included whether or not it was named, so
    the card always says which of them the answer changes.
  */
  const named = (proposal.fields ?? []).map((one) => one.trim()).filter(Boolean);
  for (const field of named) {
    if (!allowed.includes(field)) {
      throw new Error(
        `"${field}" is not one of the fields of a ${proposal.target}: ${allowed.join(", ")}.`,
      );
    }
  }
  const fields =
    named.length === 0
      ? null
      : JSON.stringify([proposal.field, ...named.filter((one) => one !== proposal.field)]);

  const quote = proposal.quote?.trim() || null;
  if (quote) {
    const stored = await currently({
      target: proposal.target,
      target_id: proposal.target_id ?? null,
      target_key: proposal.target_key ?? null,
      field: proposal.field,
      action,
    });
    if (!stored) {
      throw new Error(
        "There is nothing stored for that field, so there is no phrase in it to point at. Leave quote out.",
      );
    }
    const hits = stored.split(quote).length - 1;
    if (hits === 0) {
      throw new Error(
        `That quote is not in the stored text, word for word. Copy the phrase exactly as it is stored, or leave quote out. Stored: “${stored.slice(0, 200)}${stored.length > 200 ? "…" : ""}”`,
      );
    }
    if (hits > 1) {
      throw new Error(
        `That phrase appears ${hits} times in the stored text, so a mark on it would point at the wrong one. Quote a longer span that occurs once, or leave quote out.`,
      );
    }
  }

  /*
    Every card recommends one of its own answers.

    The card used to work the highlight out from the action, which meant it
    recommended by accident: an ask that offered three answers highlighted
    the first of them whether or not the assistant held that view. So the
    recommendation is part of the proposal and is checked against what this
    card can actually offer.
  */
  const answers = answersFor({
    action,
    target: proposal.target,
    target_id: proposal.target_id ?? null,
    target_key: proposal.target_key ?? null,
  });
  const recommend: Answer = proposal.recommend ?? (action === "add" ? "leave" : "use");
  if (!ANSWERS.has(recommend)) {
    throw new Error(`"${recommend}" is not an answer. Recommend one of: ${answers.join(", ")}.`);
  }
  if (!answers.includes(recommend)) {
    throw new Error(
      `This card cannot offer "${recommend}", so it cannot recommend it. Its answers are: ${answers.join(", ")}.`,
    );
  }

  /*
    One slot, but a second thought about the same line is not a second
    question.

    The slot stops six questions arriving at once, which is what it is for.
    It also used to stop the most natural request there is: the person looks
    at a proposed line, says "make it better", and the assistant cannot put a
    better version in the box because the box is occupied by the version they
    just asked it to improve. The only way through was withdraw_edit, which
    its own description forbids for this, so the assistant did the one thing
    left and talked about the line instead of rewriting it.

    So a proposal on the same field of the same thing replaces what is
    waiting. The question it was answering is carried over unless the new one
    names its own, since it is still that question being answered. Anything
    aimed elsewhere is a second question and still waits its turn.
  */
  const waiting = await pendingEdit();
  if (waiting) {
    const sameThing =
      waiting.target === proposal.target &&
      (waiting.target_id ?? null) === (proposal.target_id ?? null) &&
      (waiting.target_key ?? null) === (proposal.target_key ?? null) &&
      waiting.field === proposal.field;
    if (!sameThing) return { pending: waiting, waiting };
    await clearEdit("assistant");
    proposal = { ...proposal, question_id: proposal.question_id ?? waiting.question_id };
  }

  await run(
    `INSERT INTO pending_edit
            (id, target, target_id, target_key, question_id, field, action, value, why, recommend, quote, fields, token, at)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    proposal.target,
    proposal.target_id ?? null,
    proposal.target_key ?? null,
    proposal.question_id ?? null,
    proposal.field,
    action,
    proposal.value.trim(),
    proposal.why.trim(),
    recommend,
    quote,
    fields,
    randomUUID(),
  );

  /* So the progress bar can lead back to wherever this was asked. */
  await noteAsking();
  changed("focus");

  /*
    If the proposal before this one was taken away unanswered, this is where
    the assistant finds out. It is reported here rather than waiting to be
    looked up, because the assistant that most needs to know is the one
    proposing again into a slot it thought was still occupied — which is
    exactly what happened in the case this exists for.
  */
  const withdrawn = await withdrawnEdit();
  await forgetWithdrawn();
  return { pending: (await pendingEdit())!, ...(withdrawn ? { withdrawn } : {}) };
}

/** Take the row away. One place, because two answers end here. */
async function remove(edit: PendingEdit): Promise<void> {
  if (edit.target === "bullet" && edit.target_id != null) {
    await profile.deleteBullet(edit.target_id);
  } else if (edit.target === "role" && edit.target_id != null) {
    await profile.deleteRole(edit.target_id);
  } else if (edit.target === "fact" && edit.target_key) {
    await forgetFact(edit.target_key);
  } else if (edit.target === "education" && edit.target_id != null) {
    await profile.deleteEducation(edit.target_id);
  }
}

export interface Resolved {
  field: string;
  kept: boolean;
  /** True when what they kept was its removal. */
  removed?: boolean;
  /** What was stored, when it was kept. Their text, not necessarily what was proposed. */
  value?: string;
  /** True when they typed something other than what was proposed. */
  edited?: boolean;
  /** For a skills card: the names that went in, which excludes any already there. */
  added?: string[];
  /** For a skills card that asked about names on the list: the ones taken off. */
  dropped?: string[];
  /** The row went away between the question and the answer, so nothing was written. */
  gone?: boolean;
}

/**
 * Their answer, which is the only thing that writes.
 *
 * `value` is whatever was in the box when they clicked, so an edit and a
 * plain acceptance come through the same door. "leave" stores nothing and
 * leaves what was there; "drop" removes the row the card was about, which is
 * the third thing the assistant's own questions kept offering and the card
 * had no button for.
 */
export async function resolveEdit(answer: Answer, value?: string): Promise<Resolved> {
  if (!ANSWERS.has(answer)) throw new Error(`"${answer}" is not an answer.`);
  const waiting = await pendingEdit();
  if (!waiting) throw new Error("Nothing is waiting to be decided.");
  if (!waiting.answers.includes(answer)) {
    throw new Error(`This card does not offer "${answer}".`);
  }

  await run(`DELETE FROM pending_edit WHERE id = 1`);
  /* An answer is an outcome the assistant is told in the person's own voice. */
  await forgetWithdrawn();
  changed("focus");

  /*
    The question it came from is settled either way. Somebody saying "leave
    that one" has answered it as surely as somebody changing it, and a
    question that comes back because they said no is the app asking twice.
  */
  if (waiting.question_id != null) {
    const { settleQuestion } = await import("./queue.js");
    await settleQuestion(
      waiting.question_id,
      answer === "leave" ? "left as it was" : "changed",
    );
  }

  /*
    Gone between the question and the answer, which is what the fallback card
    at the top of the pane exists for. Writing to a missing id changes
    nothing and reports a change, so the answer says what actually happened
    and the queued question is settled either way, above. Checked before
    the answers are told apart, because the row is equally gone whichever
    button was pressed.
  */
  if (!(await stillThere(whatItNames(waiting)))) {
    return { field: waiting.field, kept: false, gone: true };
  }

  if (answer === "leave") return { field: waiting.field, kept: false };

  /*
    The skills list, which is answered in names rather than in text.

    Both of its cards end here, before the general branches below: the
    generic drop removes the row a card is about, and a skills card is not
    about a row. It is about which names are on a list, so dropping means
    dropping the ones it named and nothing else.
  */
  if (waiting.target === "skills") {
    const stored = await profile.listSkills();

    if (waiting.action === "ask") {
      /* "leave" has already returned, so this is the drop. */
      /*
        In the order the question named them, not the order the list keeps
        them in, so the sentence that goes back to the person reads as the
        answer to what they were asked.
      */
      const going = namesIn(waiting.value)
        .map((name) => stored.find((one) => one.name.toLowerCase() === name.toLowerCase()))
        .filter((one): one is (typeof stored)[number] => one !== undefined);
      for (const one of going) await profile.deleteSkill(one.id);
      return {
        field: waiting.field,
        kept: true,
        removed: going.length > 0,
        dropped: going.map((one) => one.name),
      };
    }

    /* Whatever is in the box, which is where an edited list of names is. */
    const said = (value ?? waiting.value).trim();
    const had = new Set(stored.map((one) => one.name.toLowerCase()));
    const added: string[] = [];
    for (const name of namesIn(said)) {
      if (had.has(name.toLowerCase())) continue;
      await profile.addSkill(name);
      added.push(name);
    }
    if (added.length > 0) changed("profile");
    return {
      field: waiting.field,
      kept: added.length > 0,
      value: said,
      added,
      ...(said !== waiting.value ? { edited: true } : {}),
    };
  }

  /*
    Dropping the row, which any card about a row that exists can do. The
    delete action below is the same ending reached from the other side: there
    the removal is what was proposed, here it is what they chose instead.
  */
  if (answer === "drop") {
    await remove(waiting);
    changed("profile");
    return { field: waiting.field, kept: true, removed: true };
  }

  /*
    One place that writes, with one branch per target. A target listed in
    FIELDS and missing here would be a question somebody could answer and
    nothing could carry out, so the two lists are kept side by side.
  */
  if (waiting.action === "delete") {
    await remove(waiting);
    changed("profile");
    return { field: waiting.field, kept: true, removed: true };
  }

  const text = (value ?? waiting.value).trim();

  /*
    An add makes the row rather than changing one, and its target_id is the
    role the line joins. Nothing in the box means they emptied it, which is
    the same as not wanting the line.
  */
  if (waiting.action === "add") {
    if (text && waiting.target_id != null) {
      await profile.addBullet(waiting.target_id, text);
    }
    return { field: waiting.field, kept: Boolean(text), value: text };
  }

  /*
    An ask with nothing typed into it is an answer, not an edit. It carries
    no suggested value, so writing what is in the box when the box is empty
    would clear the field somebody was only being asked about.
  */
  if (waiting.action === "ask" && !text) {
    return { field: waiting.field, kept: true };
  }

  if (waiting.target === "profile") {
    await profile.updateProfile({ [waiting.field]: text });
  } else if (waiting.target === "role" && waiting.target_id != null) {
    await profile.updateRole(waiting.target_id, { [waiting.field]: text });
  } else if (waiting.target === "bullet" && waiting.target_id != null) {
    await profile.updateBullet(waiting.target_id, text);
  } else if (waiting.target === "education" && waiting.target_id != null) {
    await profile.updateEducation(waiting.target_id, { [waiting.field]: text });
  } else if (waiting.target === "fact" && waiting.target_key) {
    /*
      A fact keeps the question it already had: that wording is what later
      application forms are matched against, so renaming it on somebody's
      behalf would change which questions find the answer.
    */
    const had = await getFact(waiting.target_key);
    await setFact({
      slug: waiting.target_key,
      ...(had ? { question: had.question } : {}),
      answer: text,
      source: "conversation",
    });
  }

  changed("profile");
  return {
    field: waiting.field,
    kept: true,
    value: text,
    ...(text !== waiting.value ? { edited: true } : {}),
  };
}

/**
 * Take a proposal out of the slot without an answer, and say who did it.
 *
 * `by` is not bookkeeping. The assistant is told an outcome one way only —
 * the person clicks and the page says so in their voice — so a proposal that
 * left the slot any other way left no trace at all. A developer deleting the
 * pending edit by hand while the assistant waited on it therefore looked
 * identical to a card that had swallowed an answer, and the assistant
 * reported the app as broken. It was right about what it saw.
 *
 * "assistant" is a withdrawal it made itself, which needs no record: it
 * knows. Everything else is "elsewhere" and is written down for the next
 * time the assistant touches the slot. "elsewhere" says no more than that
 * because nothing more is known — the route that clears it does not know
 * who called it, and naming the person would be a guess dressed as a fact.
 */
export async function clearEdit(by: ClearedBy): Promise<void> {
  const going = by === "assistant" ? null : await pendingEdit();
  await run(`DELETE FROM pending_edit WHERE id = 1`);

  if (by === "assistant") {
    /*
      It took the card itself, so there is nothing to tell it — and any
      earlier withdrawal is stale news now that the slot is empty by its own
      hand.
    */
    await forgetWithdrawn();
  } else if (going) {
    await run(
      `INSERT OR REPLACE INTO withdrawn_edit
              (id, target, target_id, target_key, field, action, value, why, by_whom, at)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      going.target,
      going.target_id,
      going.target_key,
      going.field,
      going.action,
      going.value,
      going.why,
      by,
    );
  }
  /*
    Clearing an already empty slot from outside leaves the earlier
    withdrawal where it is. The case that mattered deleted the pending edit
    twice, and the second delete must not erase the record of the first.
  */

  changed("focus");
}

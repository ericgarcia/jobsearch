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
};

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
  at: string;
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
    `SELECT target, target_id, target_key, question_id, field, action, value, why, at
       FROM pending_edit WHERE id = 1`,
  );
  if (!row) return null;
  return {
    ...row,
    action:
      row.action === "delete"
        ? "delete"
        : row.action === "ask"
          ? "ask"
          : row.action === "add"
            ? "add"
            : "set",
    current: await currently(row),
  };
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
): Promise<{ pending: PendingEdit; waiting?: PendingEdit }> {
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
  if (action === "add" && proposal.target !== "bullet") {
    throw new Error(`Only a bullet can be added this way, not a ${proposal.target}.`);
  }
  if (action === "add" && proposal.target_id == null) {
    throw new Error("An added line needs target_id: the id of the role it goes under.");
  }
  if (action === "add" && !proposal.value.trim()) {
    throw new Error("Nothing to add. Say the line in `value`.");
  }
  if (action === "delete" && !REMOVABLE.has(proposal.target)) {
    throw new Error(`A ${proposal.target} cannot be removed, only changed.`);
  }
  if (proposal.target === "fact") {
    if (!proposal.target_key) throw new Error("A fact is named by its topic; pass target_key.");
  } else if (proposal.target !== "profile" && proposal.target_id == null) {
    throw new Error(`A ${proposal.target} is named by its id; pass target_id.`);
  }
  /* An ask has nothing to suggest, so an empty value is the normal case. */
  if (action === "set" && !proposal.value.trim()) {
    throw new Error("Nothing to set. To remove it, propose a deletion instead.");
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
    await clearEdit();
    proposal = { ...proposal, question_id: proposal.question_id ?? waiting.question_id };
  }

  await run(
    `INSERT INTO pending_edit
            (id, target, target_id, target_key, question_id, field, action, value, why, at)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    proposal.target,
    proposal.target_id ?? null,
    proposal.target_key ?? null,
    proposal.question_id ?? null,
    proposal.field,
    action,
    proposal.value.trim(),
    proposal.why.trim(),
  );

  /* So the progress bar can lead back to wherever this was asked. */
  await noteAsking();
  changed("focus");
  return { pending: (await pendingEdit())! };
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
}

/**
 * Their answer, which is the only thing that writes.
 *
 * `value` is whatever was in the box when they clicked, so an edit and a
 * plain acceptance come through the same door. Skipping stores nothing and
 * leaves what was there.
 */
export async function resolveEdit(keep: boolean, value?: string): Promise<Resolved> {
  const waiting = await pendingEdit();
  if (!waiting) throw new Error("Nothing is waiting to be decided.");

  await run(`DELETE FROM pending_edit WHERE id = 1`);
  changed("focus");

  /*
    The question it came from is settled either way. Somebody saying "leave
    that one" has answered it as surely as somebody changing it, and a
    question that comes back because they said no is the app asking twice.
  */
  if (waiting.question_id != null) {
    const { settleQuestion } = await import("./queue.js");
    await settleQuestion(waiting.question_id, keep ? "changed" : "left as it was");
  }

  if (!keep) return { field: waiting.field, kept: false };

  /*
    One place that writes, with one branch per target. A target listed in
    FIELDS and missing here would be a question somebody could answer and
    nothing could carry out, so the two lists are kept side by side.
  */
  if (waiting.action === "delete") {
    if (waiting.target === "bullet" && waiting.target_id != null) {
      await profile.deleteBullet(waiting.target_id);
    } else if (waiting.target === "role" && waiting.target_id != null) {
      await profile.deleteRole(waiting.target_id);
    } else if (waiting.target === "fact" && waiting.target_key) {
      await forgetFact(waiting.target_key);
    } else if (waiting.target === "education" && waiting.target_id != null) {
      await profile.deleteEducation(waiting.target_id);
    }
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

/** Take back a proposal without answering it — when a conversation moves on. */
export async function clearEdit(): Promise<void> {
  await run(`DELETE FROM pending_edit WHERE id = 1`);
  changed("focus");
}

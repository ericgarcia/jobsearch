import { get, run } from "./db/client.js";
import { changed } from "./notify.js";
import * as profile from "./profile.js";

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
 * That last part is also how the assistant stays out of their prose. It may
 * propose a value in their own words from the conversation, or the text
 * already stored so they can edit it, or a deletion. It may not compose a
 * sentence about them — and because the person sees and edits before anything
 * lands, the rule has a second enforcement that does not depend on the model.
 */

/** What can be proposed. Widening this list means widening resolve() too. */
const FIELDS: Record<string, readonly string[]> = {
  profile: ["name", "headline", "email", "phone", "location", "summary"],
};

export interface PendingEdit {
  target: string;
  target_id: number | null;
  field: string;
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
  field: string;
  value: string;
  why: string;
  at: string;
}

async function currently(target: string, field: string): Promise<string | null> {
  if (target !== "profile") return null;
  const row = await profile.getProfile();
  const value = (row as unknown as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

export async function pendingEdit(): Promise<PendingEdit | null> {
  const row = await get<Row>(
    `SELECT target, target_id, field, value, why, at FROM pending_edit WHERE id = 1`,
  );
  if (!row) return null;
  return { ...row, current: await currently(row.target, row.field) };
}

export interface Proposal {
  target: string;
  field: string;
  value: string;
  why: string;
  target_id?: number | null;
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

  const waiting = await pendingEdit();
  if (waiting) return { pending: waiting, waiting };

  await run(
    `INSERT INTO pending_edit (id, target, target_id, field, value, why, at)
          VALUES (1, ?, ?, ?, ?, ?, datetime('now'))`,
    proposal.target,
    proposal.target_id ?? null,
    proposal.field,
    proposal.value.trim(),
    proposal.why.trim(),
  );

  changed("focus");
  return { pending: (await pendingEdit())! };
}

export interface Resolved {
  field: string;
  kept: boolean;
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

  if (!keep) return { field: waiting.field, kept: false };

  const text = (value ?? waiting.value).trim();
  if (waiting.target === "profile") {
    await profile.updateProfile({ [waiting.field]: text });
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

import { all, get, run } from "./db/client.js";
import { changed } from "./notify.js";
import { sameAs } from "./likeness.js";

/**
 * What the person has said about a part of their profile.
 *
 * The profile holds what is true; this holds why. The figure that cannot be
 * given because the client is under NDA. The job left off on purpose,
 * because six weeks of it reads as a detour. The line kept exactly as it is,
 * because a recruiter asked about that wording once.
 *
 * All of it arrives in conversation, mid-sentence, while something else is
 * being decided — and until this existed, all of it was lost when the thread
 * scrolled away. The review would read the profile a month later, see a
 * Preact line with no figures in it, and ask for the figures again. Being
 * asked a second time for something you have already explained is the
 * clearest possible sign that nothing you say is being kept.
 *
 * Three things make this worth having rather than a pile of transcript:
 *
 * It hangs on a row, not a section. "Experience" cannot hold "that client
 * will not be named"; the role can, and the icon then sits where the context
 * belongs.
 *
 * It records what a note forecloses. `settles` names the question this
 * answers or rules out, and the review is given it with one instruction: do
 * not ask what a note has already settled. A note of "we discussed scale" is
 * worth nothing to anybody.
 *
 * And it is context for asking, never material for claiming. Nothing that
 * writes a resume, a cover letter or an application answer reads this table,
 * and that is a property of the wiring rather than a rule in a prompt: the
 * places that could leak it do not import this file. What somebody tells you
 * about why a year is missing from their history is not a sentence to put in
 * front of an employer.
 */

export type NoteTarget = "profile" | "role" | "bullet" | "education" | "fact" | "skills";

const TARGETS = new Set<NoteTarget>([
  "profile",
  "role",
  "bullet",
  "education",
  "fact",
  "skills",
]);

export interface Note {
  id: number;
  target: NoteTarget;
  target_id: number | null;
  target_key: string | null;
  note: string;
  settles: string | null;
  source: "person" | "assistant";
  at: string;
}

interface Row extends Omit<Note, "target" | "source"> {
  target: string;
  source: string;
}

function asNote(row: Row): Note {
  return {
    ...row,
    target: (TARGETS.has(row.target as NoteTarget) ? row.target : "profile") as NoteTarget,
    source: row.source === "person" ? "person" : "assistant",
  };
}

/** Everything, newest first, for the page to hand out per row. */
export async function allNotes(): Promise<Note[]> {
  const rows = await all<Row>(
    `SELECT id, target, target_id, target_key, note, settles, source, at
       FROM context_notes ORDER BY at DESC, id DESC`,
  );
  return rows.map(asNote);
}

/** What has been said about one thing. */
export async function notesFor(
  target: NoteTarget,
  of: { id?: number | null; key?: string | null } = {},
): Promise<Note[]> {
  const rows = await all<Row>(
    `SELECT id, target, target_id, target_key, note, settles, source, at
       FROM context_notes
      WHERE target = ?
        AND (? IS NULL OR target_id = ?)
        AND (? IS NULL OR target_key = ?)
      ORDER BY at DESC, id DESC`,
    target,
    of.id ?? null,
    of.id ?? null,
    of.key ?? null,
    of.key ?? null,
  );
  return rows.map(asNote);
}

export interface Keeping {
  note: Note;
  /** True when this replaced one already there rather than adding another. */
  instead: boolean;
}

/**
 * Keep what they said.
 *
 * The same thing said twice is one note, updated, rather than two — somebody
 * explains the NDA in March and again in June, and a list that shows both is
 * a list nobody reads to the end. Sameness is a judgement about meaning, so
 * it is the matcher the wishes and the bug reports use; with no credential it
 * falls back to matching the text, which is blunt and harmless.
 */
export async function keepNote(entry: {
  target: NoteTarget;
  target_id?: number | null;
  target_key?: string | null;
  note: string;
  settles?: string | null;
  source?: "person" | "assistant";
}): Promise<Keeping> {
  if (!TARGETS.has(entry.target)) {
    throw new Error(`Nothing can be noted against "${entry.target}".`);
  }
  const text = entry.note.trim();
  if (!text) throw new Error("Say what they told you.");
  if (entry.target !== "profile" && entry.target !== "skills") {
    if (entry.target === "fact" ? !entry.target_key : entry.target_id == null) {
      throw new Error(`A note on a ${entry.target} has to say which one.`);
    }
  }

  const already = await notesFor(entry.target, {
    id: entry.target_id ?? null,
    key: entry.target_key ?? null,
  });
  const which = await sameAs(text, already.map((one) => one.note));
  const found = which == null ? undefined : already[which];

  if (found) {
    await run(
      `UPDATE context_notes
          SET note = ?, settles = COALESCE(?, settles), source = ?, at = datetime('now')
        WHERE id = ?`,
      text,
      entry.settles?.trim() || null,
      entry.source ?? "assistant",
      found.id,
    );
    changed("profile");
    const fresh = await get<Row>(
      `SELECT id, target, target_id, target_key, note, settles, source, at
         FROM context_notes WHERE id = ?`,
      found.id,
    );
    return { note: asNote(fresh!), instead: true };
  }

  const made = await run(
    `INSERT INTO context_notes (target, target_id, target_key, note, settles, source)
          VALUES (?, ?, ?, ?, ?, ?)`,
    entry.target,
    entry.target_id ?? null,
    entry.target_key ?? null,
    text,
    entry.settles?.trim() || null,
    entry.source ?? "assistant",
  );
  changed("profile");
  const fresh = await get<Row>(
    `SELECT id, target, target_id, target_key, note, settles, source, at
       FROM context_notes WHERE id = ?`,
    Number(made.lastInsertRowid),
  );
  return { note: asNote(fresh!), instead: false };
}

/** Theirs to remove, since it is their own account of their own history. */
export async function forgetNote(id: number): Promise<{ removed: boolean }> {
  const done = await run(`DELETE FROM context_notes WHERE id = ?`, id);
  if (done.changes > 0) changed("profile");
  return { removed: done.changes > 0 };
}

/**
 * What to tell a review about a row, bounded.
 *
 * Newest first and a few at most: a review prompt that carries forty notes
 * about one role has stopped being a prompt about the profile.
 */
export async function notesForReview(limit = 6): Promise<Note[]> {
  const rows = await all<Row>(
    `SELECT id, target, target_id, target_key, note, settles, source, at
       FROM context_notes ORDER BY at DESC, id DESC`,
  );
  const perTarget = new Map<string, number>();
  const kept: Note[] = [];
  for (const row of rows) {
    const key = `${row.target}:${row.target_id ?? ""}:${row.target_key ?? ""}`;
    const seen = perTarget.get(key) ?? 0;
    if (seen >= limit) continue;
    perTarget.set(key, seen + 1);
    kept.push(asNote(row));
  }
  return kept;
}

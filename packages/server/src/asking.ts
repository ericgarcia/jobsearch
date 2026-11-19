import { get, run } from "./db/client.js";

/**
 * Which conversation is working through the questions.
 *
 * The queue is one queue. It is not owned by a thread: it is filled from a
 * document somebody imported, from the gaps in their profile, and from what
 * employers have asked, and any thread can take the next one. So there is no
 * such thing as "the thread that owns this question" to link back to.
 *
 * What there is, and what somebody actually wants when they look at a
 * progress bar and want to get back to it, is the thread that last asked.
 * That is what this records.
 *
 * Two parts, because the two facts have different lifetimes. Which turn is
 * running now is a fact about this process and lives in memory; which thread
 * last asked is a fact about the work and lives in the database, so that
 * closing the app does not lose the way back.
 *
 * The in-memory half is a plain value rather than an async context: the tool
 * handlers run from the agent's own transport rather than inside the request
 * that started the turn, so a context would not reach them. One person
 * talking in one thread at a time is the case this serves; the cost of being
 * wrong is a link to the wrong thread, both of which the person can see.
 */

const KEY = "asking_thread";

let running: number | null = null;

/** Said as a turn begins, so a proposal made during it can be attributed. */
export function turnIsFrom(conversationId: number): void {
  running = conversationId;
}

/** Remember this turn's thread as the one asking. Does nothing outside a turn. */
export async function noteAsking(): Promise<void> {
  if (running == null) return;
  await run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    KEY,
    String(running),
  );
}

/** The thread to go back to, or null when nothing has asked yet. */
export async function askingThread(): Promise<number | null> {
  const row = await get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, KEY);
  const id = Number(row?.value);
  if (!Number.isInteger(id)) return null;
  /* A thread that has since been deleted is not somewhere to send anybody. */
  const alive = await get<{ id: number }>(`SELECT id FROM conversations WHERE id = ?`, id);
  return alive ? id : null;
}

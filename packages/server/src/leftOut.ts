import { all } from "./db/client.js";
import { changed } from "./notify.js";
import * as profile from "./profile.js";
import { settleQuestion } from "./queue.js";

/**
 * The lines an import left out, gathered under the role they came from.
 *
 * An import deliberately drops what is not somebody's work: a company's
 * tagline, a services menu, the commercial terms, the call to action at the
 * bottom of a consultancy's page. It is right to drop them and it is right
 * to say so, so each one is queued as a question — do you want this after
 * all?
 *
 * One at a time, though, that reads as an interrogation. One resume put nine
 * lines of a marketing page under a single role, and the queue turned them
 * into nine cards asking the same judgement nine times, each needing a turn
 * of the assistant's to reach the screen. Nobody answers that carefully by
 * the fourth one.
 *
 * So they are also an item on the page: the role says how many lines were
 * held back, shows them with the reason each was held, and takes one answer
 * for the lot or one answer each. The queue is the same queue — adding a
 * line here settles its question exactly as keeping a card would, and the
 * progress bar moves — but the work is in front of the person rather than
 * waiting on a conversation.
 */

export interface LeftOutLine {
  /** The queued question, which is what gets settled. */
  id: number;
  text: string;
  /** Why the import held it back, when it said. */
  why: string | null;
}

export interface LeftOutGroup {
  role_id: number;
  company: string;
  title: string;
  lines: LeftOutLine[];
}

interface Row {
  id: number;
  target_id: number;
  note: string;
  value: string;
}

/**
 * The reason, read back out of the note.
 *
 * The note is the sentence written for the assistant to read — "The import
 * left this line out from MuffinLabs, because Service the company sells, not
 * something you did. Offer it back..." — and the reason inside it is worth
 * showing beside the line. Reading it back out of prose is not how this
 * would be stored if it were being stored today, but it is how the rows that
 * already exist can be shown without re-importing somebody's document, and a
 * note that does not match simply shows no reason.
 */
function reasonFrom(note: string): string | null {
  const found = /,\s*because\s+([^]*?)\.\s*Offer it back/i.exec(note);
  const said = found?.[1]?.trim();
  return said ? said.charAt(0).toUpperCase() + said.slice(1) : null;
}

/** Everything held back, by role. Roles with nothing held back are left out. */
export async function leftOutLines(): Promise<LeftOutGroup[]> {
  const rows = await all<Row>(
    `SELECT id, target_id, note, value
       FROM question_queue
      WHERE state = 'waiting'
        AND source LIKE 'import:%'
        AND value IS NOT NULL
        AND target = 'bullet'
        AND target_id IS NOT NULL
      ORDER BY id`,
  );
  if (rows.length === 0) return [];

  const roles = await profile.listRoles();
  const groups = new Map<number, LeftOutGroup>();

  for (const row of rows) {
    const role = roles.find((one) => one.id === row.target_id);
    /* A role deleted since the import leaves its lines nowhere to show. */
    if (!role) continue;
    let group = groups.get(role.id);
    if (!group) {
      group = { role_id: role.id, company: role.company, title: role.title ?? "", lines: [] };
      groups.set(role.id, group);
    }
    group.lines.push({ id: row.id, text: row.value, why: reasonFrom(row.note) });
  }

  return [...groups.values()];
}

/** Put one of them on the profile, under the role it came from. */
export async function addLeftOut(id: number): Promise<{ added: boolean }> {
  const row = await all<Row>(
    `SELECT id, target_id, note, value FROM question_queue
      WHERE id = ? AND state = 'waiting'`,
    id,
  );
  const found = row[0];
  if (!found) return { added: false };

  await profile.addBullet(found.target_id, found.value);
  await settleQuestion(id, "changed");
  changed("profile");
  return { added: true };
}

/**
 * Leave them out, which is what the import already judged.
 *
 * Settled rather than deleted: the question was answered, and an answer of
 * "no" is as much an answer as any other. It does not come back.
 */
export async function leaveLeftOut(ids: number[]): Promise<{ settled: number }> {
  let settled = 0;
  for (const id of ids) {
    if (await settleQuestion(id, "left as it was")) settled += 1;
  }
  if (settled > 0) changed("profile");
  return { settled };
}

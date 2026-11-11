import { db } from "./db/client.js";

/**
 * What the person is looking for, in their own words.
 *
 * The profile says what they have done. That is the wrong thing to rank
 * against on its own: anyone moving towards different work gets measured
 * against the work they are leaving. These terms are chosen rather than
 * inferred, so matching weights them above anything read from the history.
 */
export interface Interests {
  /** Role titles wanted, for example "Staff Machine Learning Engineer". */
  titles: string[];
  /** Subjects and technologies to seek out. */
  include: string[];
  /** Subjects to avoid. A posting whose title matches one is pushed down. */
  exclude: string[];
  note: string | null;
}

export function getInterests(): Interests {
  db.prepare(`INSERT OR IGNORE INTO interests (id) VALUES (1)`).run();
  const row = db.prepare(`SELECT * FROM interests WHERE id = 1`).get() as {
    titles: string;
    include: string;
    exclude: string;
    note: string | null;
  };
  return {
    titles: JSON.parse(row.titles) as string[],
    include: JSON.parse(row.include) as string[],
    exclude: JSON.parse(row.exclude) as string[],
    note: row.note,
  };
}

export function setInterests(patch: Partial<Interests>): Interests {
  const current = getInterests();
  const next = { ...current, ...patch };
  db.prepare(
    `UPDATE interests
        SET titles = ?, include = ?, exclude = ?, note = ?, updated_at = datetime('now')
      WHERE id = 1`,
  ).run(
    JSON.stringify(next.titles),
    JSON.stringify(next.include),
    JSON.stringify(next.exclude),
    next.note,
  );
  return getInterests();
}

export function interestsAreEmpty(): boolean {
  const i = getInterests();
  return i.titles.length === 0 && i.include.length === 0;
}

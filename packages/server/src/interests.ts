import { all as dbAll, get as dbGet, run as dbRun, tx } from "./db/client.js";

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

export async function getInterests(): Promise<Interests> {
  (await dbRun(`INSERT OR IGNORE INTO interests (id) VALUES (1)`));
  const row = (await dbGet(`SELECT * FROM interests WHERE id = 1`)) as {
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

export async function setInterests(patch: Partial<Interests>): Promise<Interests> {
  const current = await getInterests();
  const next = { ...current, ...patch };
  (await dbRun(`UPDATE interests
        SET titles = ?, include = ?, exclude = ?, note = ?, updated_at = datetime('now')
      WHERE id = 1`, JSON.stringify(next.titles),
    JSON.stringify(next.include),
    JSON.stringify(next.exclude),
    next.note));
  return await getInterests();
}

export async function interestsAreEmpty(): Promise<boolean> {
  const i = await getInterests();
  return i.titles.length === 0 && i.include.length === 0;
}

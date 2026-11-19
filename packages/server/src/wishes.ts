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

export interface Wish {
  id: number;
  name: string;
  why: string;
  votes: number;
  first_at: string;
  last_at: string;
}

/** What is piling up, the most wanted first. */
export async function wishedActions(): Promise<Wish[]> {
  return all<Wish>(
    `SELECT id, name, why, votes, first_at, last_at
       FROM wished_actions ORDER BY votes DESC, last_at DESC`,
  );
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
}

/**
 * Record a want, or add a vote to the one it already is.
 *
 * `why` is kept from the latest telling rather than the first: the newest
 * account is the one written with the most cases behind it, and the votes
 * say how long it has been accumulating.
 */
export async function wishForAnswer(name: string, why: string): Promise<Wished> {
  const wanted = name.trim();
  if (!wanted) throw new Error("Say what the answer would be called.");
  if (!why.trim()) throw new Error("Say what it is for, in one line.");

  const already = await wishedActions();
  const which = await sameAs(`${wanted} — ${why.trim()}`, already.map((one) => one.name));

  const found = which == null ? undefined : already[which];
  if (found) {
    await run(
      `UPDATE wished_actions
          SET votes = votes + 1, why = ?, last_at = datetime('now')
        WHERE id = ?`,
      why.trim(),
      found.id,
    );
    const fresh = await get<Wish>(
      `SELECT id, name, why, votes, first_at, last_at FROM wished_actions WHERE id = ?`,
      found.id,
    );
    return { wish: fresh!, voted: true };
  }

  await run(
    `INSERT INTO wished_actions (name, why) VALUES (?, ?)
       ON CONFLICT (name) DO UPDATE
        SET votes = votes + 1, why = excluded.why, last_at = datetime('now')`,
    wanted,
    why.trim(),
  );
  const fresh = await get<Wish>(
    `SELECT id, name, why, votes, first_at, last_at FROM wished_actions WHERE name = ?`,
    wanted,
  );
  return { wish: fresh!, voted: fresh!.votes > 1 };
}

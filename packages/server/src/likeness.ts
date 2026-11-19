import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "./config.js";
import { credentialEnv, readCredential } from "./settings.js";

/**
 * Which of these existing things is this one, by meaning.
 *
 * Two lists in this app grow by being added to from the inside — the answers
 * the assistant wished a card had, and the bugs it has run into — and both
 * are useless if the same thing arrives twice under different words. "Split
 * this in two" and "break the line up" are one want; "the card vanished
 * before I could answer" and "my proposal disappeared with no answer" are
 * one bug. No comparison of the strings will say so.
 *
 * So a model reads the existing titles and says which one this is, if any,
 * and falls back to matching the name exactly when there is no credential or
 * the call fails. A duplicate row is a worse outcome than a slow one, not a
 * wrong one, so the fallback is allowed to be blunt.
 */

export const LIKENESS_MODEL = process.env.JOBSEARCH_LIKENESS_MODEL ?? "claude-haiku-5-5";

const INSTRUCTIONS = `You match one request against a list of existing ones.

You are given NAMES, a numbered list of answer types somebody has already
asked for, and WANT, a new request. Say which existing one means the same
thing as WANT — the same effect on the profile, however differently it is
worded.

Reply with the number alone, or the word "new" if none of them is the same
thing. Nothing else. Two requests are the same only if carrying one out
would carry out the other; "split this line in two" and "break this bullet
up" are the same, "drop this line" and "shorten this line" are not.`;

/** Which existing one this is, by meaning. Null when it is a new one. */
export async function sameAs(want: string, names: string[]): Promise<number | null> {
  if (names.length === 0) return null;

  const credential = await readCredential();
  if (!credential) return byName(want, names);

  const listed = names.map((name, index) => `${index + 1}. ${name}`).join("\n");
  let text = "";
  try {
    for await (const message of query({
      prompt: `NAMES\n\n${listed}\n\nWANT\n\n${want}`,
      options: {
        model: LIKENESS_MODEL,
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


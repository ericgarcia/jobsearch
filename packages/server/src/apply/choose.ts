import crypto from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "../config.js";
import { get, run } from "../db/client.js";
import { credentialEnv, readCredential } from "../settings.js";
import { isTokenised, SELF_ID_VALUES, type SelfIdKey } from "./answers.js";

/**
 * Which option on a form a stored answer means.
 *
 * The last heuristic in the filling path, and the weakest. Forms word the
 * same choice differently — "Yes" / "Yes, I am authorized" / "I am legally
 * authorized to work in the United States" — and the string rules in fill.ts
 * settle the easy ones and give up honestly on the rest. Giving up means a
 * field the person has already answered, once, in their profile, handed back
 * to them to answer again.
 *
 * So the hard ones are read. Two routes, and they are different because what
 * may be sent is different:
 *
 *   standing   the question, the options, and the stored answer. These are
 *              the person's own words about their working situation, they are
 *              already returned by agent tools, and the model is asked which
 *              of the form's options means the same thing.
 *
 *   voluntary  the question and the options, and nothing else. The model is
 *              asked what each option *means*, in the fixed vocabulary of
 *              answers.ts, and the comparison with what the person stored
 *              happens afterwards, in code, here. Their answer is never in a
 *              prompt — that is the whole reason the vocabulary exists.
 *
 * The second route is also the better one. A UK employer's ethnicity list has
 * fourteen entries and not one of them is the word "White" on its own, so no
 * amount of string matching finds it; asked what the options mean, a model
 * answers in one call, and the answer is cached for every other employer
 * using the same list.
 */

export const CHOOSE_MODEL = process.env.JOBSEARCH_CHOOSE_MODEL ?? "claude-haiku-5-5";

/* Same reasoning as the classification cache: see apply/classify.ts. */
const TRUST_DAYS = Number(process.env.JOBSEARCH_CLASSIFY_TRUST_DAYS ?? 90);

const MEANING_RULES = `
You are given one question from a job application's voluntary
self-identification section, and the exact answers it offers. Say what each
answer means, using only these words:

{{VOCABULARY}}

You are not answering the question. You do not know who is applying and you
are not told. You are translating the employer's wording into fixed terms so
that an answer the person already gave, which you will never see, can be
matched to the right option by a program.

Rules:
- Use "decline" for any option that means refusing to say: "Prefer not to
  disclose", "I do not wish to answer", "Choose not to disclose".
- Leave an option out if none of the words above means what it says. A rough
  match is worse than no match: the result is a form sent to an employer
  stating something about the person that they did not state.
- A list may offer several options that map to the same word. Say so; the
  program will not choose between them.
- An option that is a prompt rather than an answer — "Select...", "--", an
  empty choice — is left out.

Reply with JSON only: {"meanings": {"<the option, exactly as given>": "<word>"}}
`.trim();

const SETTLE_RULES = `
You are given one question from a job application, the answers it offers, and
what the person applying has already said about their situation, in their own
words. Say which of the offered answers means the same thing as what they
said.

These questions are legally significant — the right to work in a country,
visa sponsorship, a notice period — so:

- Choose an option only if it clearly means what they said. If their answer
  is not among the options, or you are weighing two that both nearly fit,
  answer null. An answer that is nearly right to a question about someone's
  right to work is an answer that is wrong, and it is sent to an employer in
  their name.
- Read the question, not just the options. "Will you need sponsorship?" and
  "Are you authorised to work here?" have opposite shapes and are often asked
  in one sentence.
- Never infer anything they did not say.

Reply with JSON only: {"option": "<the option, exactly as given>"} or
{"option": null}
`.trim();

const RULES = crypto
  .createHash("sha256")
  .update(MEANING_RULES)
  .digest("hex")
  .slice(0, 16);

/*
  The option list is the key: one employer's wording, cached for all of them.

  Sorted, because the translation is a map from option text to meaning and
  nothing in it depends on the order the form happens to list them in. Two
  employers using the same categories in a different order are asking the
  same question, and should not be read twice.
*/
function fingerprint(key: SelfIdKey, options: string[]): string {
  const listed = options
    .map((option) => option.trim().toLowerCase())
    .sort()
    .join("\u0001");
  return crypto.createHash("sha256").update(`${key}\u0000${listed}`).digest("hex").slice(0, 32);
}

async function askOnce(rules: string, prompt: string, env: Record<string, string>): Promise<string> {
  let text = "";
  for await (const message of query({
    prompt,
    options: {
      model: CHOOSE_MODEL,
      cwd: DATA_DIR,
      systemPrompt: rules,
      tools: [],
      settingSources: [],
      maxTurns: 1,
      env,
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") text += block.text;
      }
    }
    if (message.type === "result" && message.subtype !== "success") {
      throw new Error(`stopped: ${message.subtype}`);
    }
  }
  return text;
}

function parseObject(text: string): Record<string, unknown> | null {
  const found = text.match(/\{[\s\S]*\}/);
  if (!found) return null;
  try {
    const parsed = JSON.parse(found[0]) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What each option of a voluntary question means, as tokens.
 *
 * Cached, and expiring the three ways the classification cache does: by age,
 * by the model, and by the rules it was made under. Nothing of the person's
 * is in the table — the keys are the employer's own option text.
 */
export async function cachedMeanings(
  key: SelfIdKey,
  options: string[],
): Promise<Map<string, string> | null> {
  const row = await get<{ meanings: string }>(
    `SELECT meanings FROM option_meanings
      WHERE fingerprint = ? AND model = ? AND rules = ? AND at > datetime('now', ?)`,
    fingerprint(key, options),
    CHOOSE_MODEL,
    RULES,
    `-${Math.max(1, TRUST_DAYS)} days`,
  );
  if (!row) return null;
  try {
    return new Map(Object.entries(JSON.parse(row.meanings) as Record<string, string>));
  } catch {
    return null; // A row we cannot read is a row to replace.
  }
}

/** Write one translation down. Exported so the expiry can be tested. */
export async function rememberMeanings(
  key: SelfIdKey,
  question: string,
  options: string[],
  meanings: Map<string, string>,
): Promise<void> {
  await run(
    `INSERT INTO option_meanings (fingerprint, self_id_key, question, meanings, model, rules, at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (fingerprint) DO UPDATE SET
          meanings = excluded.meanings, model = excluded.model,
          rules = excluded.rules, at = excluded.at`,
    fingerprint(key, options),
    key,
    question,
    JSON.stringify(Object.fromEntries(meanings)),
    CHOOSE_MODEL,
    RULES,
  );
}

export async function meaningsOf(
  key: SelfIdKey,
  question: string,
  options: string[],
  env: Record<string, string>,
): Promise<Map<string, string>> {
  const known = await cachedMeanings(key, options);
  if (known) return known;

  const vocabulary = (SELF_ID_VALUES[key] ?? []).map((value) => value.token).join(", ");
  const answered = await askOnce(
    MEANING_RULES.replace("{{VOCABULARY}}", vocabulary),
    `QUESTION\n${question}\n\nANSWERS OFFERED\n${options.map((option) => `- ${option}`).join("\n")}`,
    env,
  );

  const parsed = parseObject(answered);
  const given = (parsed?.meanings ?? {}) as Record<string, unknown>;
  const allowed = new Set((SELF_ID_VALUES[key] ?? []).map((value) => value.token));

  const meanings = new Map<string, string>();
  for (const [option, token] of Object.entries(given)) {
    if (typeof token !== "string" || !allowed.has(token)) continue;
    // Only options the form actually offers; a hallucinated one cannot be clicked.
    const real = options.find((offered) => offered.trim() === option.trim());
    if (real) meanings.set(real, token);
  }

  await rememberMeanings(key, question, options, meanings);

  await run(
    `DELETE FROM option_meanings WHERE at <= datetime('now', ?)`,
    `-${Math.max(1, TRUST_DAYS)} days`,
  );

  return meanings;
}

/**
 * The option a stored voluntary answer means, without the answer leaving here.
 *
 * Exactly one option may match. A list offering "White" and "White: Any other
 * White background" gives two options meaning `white`, and which of those
 * someone means is a thing only they know — so it goes back to them.
 */
export async function voluntaryOption(
  key: SelfIdKey,
  stored: string,
  question: string,
  options: string[],
  env: Record<string, string>,
): Promise<string | null> {
  if (!isTokenised(key)) return null;
  const meanings = await meaningsOf(key, question, options, env);
  const hits = [...meanings.entries()].filter(([, token]) => token === stored.trim());
  return hits.length === 1 ? (hits[0]?.[0] ?? null) : null;
}

/**
 * The option a stored standing answer means.
 *
 * Not cached. It depends on what the person has stored, which they can change,
 * and a stale answer to "are you authorised to work here" is the one kind of
 * mistake this file exists to avoid. It is also only reached when the string
 * rules have already failed, which is rare.
 */
export async function standingOption(
  stored: string,
  question: string,
  options: string[],
  env: Record<string, string>,
): Promise<string | null> {
  const answered = await askOnce(
    SETTLE_RULES,
    `QUESTION\n${question}\n\nANSWERS OFFERED\n${options.map((option) => `- ${option}`).join("\n")}\n\nWHAT THEY SAID\n${stored}`,
    env,
  );
  const parsed = parseObject(answered);
  const chosen = parsed?.option;
  if (typeof chosen !== "string") return null;
  return options.find((offered) => offered.trim() === chosen.trim()) ?? null;
}

/** Whether there is a credential to make any of these calls with. */
export async function canChoose(): Promise<Record<string, string> | null> {
  const credential = await readCredential();
  return credential ? credentialEnv(credential) : null;
}

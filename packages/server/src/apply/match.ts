import crypto from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "../config.js";
import { all, run } from "../db/client.js";
import { credentialEnv, readCredential } from "../settings.js";
import { candidateFacts, type Fact } from "./facts.js";
import { topicOf } from "./form.js";
import type { Asked } from "./classify.js";

/**
 * Which stored answer a form's question is asking for.
 *
 * The join the fact store needs, and the thing that makes it worth having.
 * Storing an answer to "Do you hold a security clearance?" is no use if the
 * only way a field finds it is by its topic being one of eight names the code
 * knows. That lookup is what made the old store closed; an open one has to be
 * searched.
 *
 * Searching by name does not work. Two employers ask the same thing as
 * "Do you require sponsorship to work in the US?" and "Will you now or in the
 * future need the company to file for immigration status on your behalf?",
 * and no amount of key matching joins those. Meaning is the only thing they
 * have in common, so a model reads them.
 *
 * What is sent is the form's own words and the *questions* this app has
 * answers to — never the answers. A slug and the wording of a question say
 * what is on file; they do not say what it says. That keeps this call to the
 * same standard as the rest of the filling path and makes it cheap to cache,
 * because a question's meaning does not depend on anybody's answer to it.
 *
 * Two rules in the prompt do the real work, and both exist because the
 * failure is not a blank field but a wrong answer sent to an employer in
 * someone's name:
 *
 *   An employer's own question has no answer on file, whatever is stored.
 *   "Why do you want to work here?" is not answered by anything, and a model
 *   looking for the nearest match will find one if it is not told so.
 *
 *   Sponsorship and the right to work are asked in one sentence and mean
 *   opposite things. A near match between those is worse than no match.
 */

export const MATCH_MODEL = process.env.JOBSEARCH_MATCH_MODEL ?? "claude-haiku-5-5";

/* Same reasoning as the classification cache: see apply/classify.ts. */
const TRUST_DAYS = Number(process.env.JOBSEARCH_CLASSIFY_TRUST_DAYS ?? 90);

const INSTRUCTIONS = `
You are given the questions a job application form asks, and a list of
questions this person has already answered somewhere else. Say which of their
stored questions each form question is asking for.

You are not given their answers and you do not need them. You are matching
one question to another.

Rules:
- Match only where the two are the same question in different words. "What
  notice do you have to give?" and "What is your notice period?" are the same
  question. "Are you willing to relocate?" and "Where are you based?" are not.
- A question about this employer has no answer on file, whatever is stored.
  "Why do you want to work here?", "What interests you about this role?",
  "Have you worked for us before?", "How did you hear about us?" — answer
  null for all of these. They are written for one application by the person
  applying.
- Needing sponsorship and being allowed to work somewhere are opposite
  questions, and employers ask them in one sentence: "will you require
  sponsorship to retain or extend your work authorization". Read which one is
  being asked. If the stored question is the other one, answer null.
- A question that asks for several things at once matches nothing. One stored
  answer put into a field that asked for two is an answer that is wrong.
- If you cannot tell, answer null. A wrong match is an answer sent to an
  employer to a question they did not ask; a null is a question the person is
  asked themselves, which is the thing that happens today anyway.

Reply with JSON only, one entry per form question, as
[{"i": 0, "slug": "<their question's name>"}] or [{"i": 0, "slug": null}].
`.trim();

const RULES = crypto.createHash("sha256").update(INSTRUCTIONS).digest("hex").slice(0, 16);

/*
  The question, the heading above it, and which facts were on offer.

  The candidates are in the key because a match is only as good as the list
  it was made against: storing a clearance answer has to make the clearance
  question match, and a cache keyed on the label alone would keep saying no.
  Sorted, because the set is what matters and not the order it was read in.
*/
export function fingerprintOf(asked: Asked, slugs: string[]): string {
  const offered = [...slugs].map((slug) => slug.trim().toLowerCase()).sort().join("\u0001");
  return crypto
    .createHash("sha256")
    .update(`${asked.label.trim()}\u0000${asked.section?.trim() ?? ""}\u0000${offered}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * The matches still worth trusting.
 *
 * A present row with a null slug is a remembered "nothing answers this",
 * which is the common case and the one worth not paying for twice. So the
 * map holds nulls, and a missing key is what "not cached" means.
 */
export async function cachedMatches(keys: string[]): Promise<Map<string, string | null>> {
  if (keys.length === 0) return new Map();
  const rows = await all<{ fingerprint: string; slug: string | null }>(
    `SELECT fingerprint, slug FROM fact_matches
      WHERE fingerprint IN (${keys.map(() => "?").join(",")})
        AND model = ? AND rules = ? AND at > datetime('now', ?)`,
    ...keys,
    MATCH_MODEL,
    RULES,
    `-${Math.max(1, TRUST_DAYS)} days`,
  );
  return new Map(rows.map((row) => [row.fingerprint, row.slug]));
}

/** Write one match down. Exported so the expiry can be tested. */
export async function rememberMatch(
  asked: Asked,
  slugs: string[],
  slug: string | null,
): Promise<void> {
  await run(
    `INSERT INTO fact_matches (fingerprint, label, section, slug, model, rules, at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (fingerprint) DO UPDATE SET
          slug = excluded.slug, model = excluded.model,
          rules = excluded.rules, at = excluded.at`,
    fingerprintOf(asked, slugs),
    asked.label,
    asked.section ?? null,
    slug,
    MATCH_MODEL,
    RULES,
  );
}

export async function forgetMatches(): Promise<void> {
  await run(
    `DELETE FROM fact_matches WHERE at <= datetime('now', ?)`,
    `-${Math.max(1, TRUST_DAYS)} days`,
  );
}

/**
 * The fallback, and only the fallback.
 *
 * It ran first, once, on the grounds that the eight seeded questions have
 * patterns over their wording and a pattern costs nothing. That was wrong,
 * and the example that shows why is "Visa or permit number": the sponsorship
 * pattern matches the word "visa", so a question asking for a document number
 * would have been answered with "No, I do not need sponsorship". Matching one
 * question to another is the judgement a pattern cannot make — it is the
 * reason this file exists — so the patterns now run only where no judgement
 * can be had: no credential, or a call that failed.
 *
 * Unlike the string rules in choose.ts, which compare a stored answer against
 * the options a form prints and can be checked against them, there is nothing
 * here to check a wrong match against. It is kept because an app that fills
 * nothing is worse than one that fills the obvious eight, and the report says
 * which route a field came through.
 */
export function matchByWords(asked: Asked, slugs: Set<string>): string | null {
  const topic = topicOf(asked.label);
  return topic !== "other" && slugs.has(topic) ? topic : null;
}

/** One call for every question a form asks that no pattern settled. */
async function ask(
  questions: Asked[],
  facts: Fact[],
  env: Record<string, string>,
): Promise<Map<number, string | null>> {
  const onFile = facts.map((fact) => `- ${fact.slug}: ${fact.question}`).join("\n");
  const listed = questions
    .map((asked, index) =>
      [
        `[${index}]`,
        asked.section ? `section: ${asked.section}` : "section: (none)",
        `label: ${asked.label}`,
      ].join("\n  "),
    )
    .join("\n\n");

  let text = "";
  for await (const message of query({
    prompt: `QUESTIONS THEY HAVE ALREADY ANSWERED\n${onFile}\n\nFORM QUESTIONS\n\n${listed}`,
    options: {
      model: MATCH_MODEL,
      cwd: DATA_DIR,
      systemPrompt: INSTRUCTIONS,
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
      throw new Error(`matching stopped: ${message.subtype}`);
    }
  }

  const found = text.match(/\[[\s\S]*\]/);
  if (!found) throw new Error("the matching reply could not be read");
  const replies = JSON.parse(found[0]) as { i?: number; slug?: string | null }[];
  if (!Array.isArray(replies)) throw new Error("the matching reply was not a list");

  const known = new Set(facts.map((fact) => fact.slug));
  const matches = new Map<number, string | null>();
  for (const reply of replies) {
    const index = typeof reply.i === "number" ? reply.i : -1;
    if (index < 0 || index >= questions.length) continue;
    /*
      A slug nothing is stored under is not a match, it is an invented one.
      Filling a field from it would read a missing answer as an empty string
      and send a blank where the person expected their own words.
    */
    const slug = typeof reply.slug === "string" && known.has(reply.slug) ? reply.slug : null;
    matches.set(index, slug);
  }
  return matches;
}

/**
 * Which stored fact answers each of these questions.
 *
 * Keyed by the label, holding only the questions something answers — a
 * caller asking about a question that matched nothing gets undefined, which
 * is what it means.
 *
 * Never throws. A form that cannot be matched falls back to the patterns over
 * the eight seeded questions, which is what the app did before this file
 * existed. Worse is not the same as broken.
 */
export async function matchFacts(questions: Asked[]): Promise<Map<string, string>> {
  const matched = new Map<string, string>();
  if (questions.length === 0) return matched;

  /*
    Refused questions are candidates too. A field matched to one is reported
    as refused rather than as unanswered, which is the difference between the
    app respecting a decision and the app asking again.
  */
  const facts = await candidateFacts();
  if (facts.length === 0) return matched;

  const slugs = facts.map((fact) => fact.slug);
  const have = new Set(slugs);

  const seen = await cachedMatches(questions.map((asked) => fingerprintOf(asked, slugs)));
  const unseen: Asked[] = [];
  for (const asked of questions) {
    const key = fingerprintOf(asked, slugs);
    if (seen.has(key)) {
      const slug = seen.get(key);
      if (slug && have.has(slug)) matched.set(asked.label, slug);
    } else {
      unseen.push(asked);
    }
  }
  if (unseen.length === 0) return matched;

  await forgetMatches();

  /* Nothing judged is nothing written down, so the patterns stand in. */
  const byWords = () => {
    for (const asked of unseen) {
      const guess = matchByWords(asked, have);
      if (guess) matched.set(asked.label, guess);
    }
  };

  const credential = await readCredential();
  if (!credential) {
    byWords();
    return matched;
  }

  try {
    const fresh = await ask(unseen, facts, credentialEnv(credential));
    for (const [index, asked] of unseen.entries()) {
      const slug = fresh.get(index) ?? null;
      if (slug) matched.set(asked.label, slug);
      /*
        The nulls are written down too. "Why do you want to work here?" is on
        every form, it matches nothing, and asking about it once per
        application would be paying repeatedly for the same no.
      */
      if (fresh.has(index)) await rememberMatch(asked, slugs, slug);
    }
  } catch (error) {
    console.log(
      `[apply] matching the form to stored answers fell back to keywords: ${error instanceof Error ? error.message : String(error)}`,
    );
    byWords();
  }

  return matched;
}

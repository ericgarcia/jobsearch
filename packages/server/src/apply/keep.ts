import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "../config.js";
import { credentialEnv, readCredential } from "../settings.js";
import { SELF_ID_KEYS } from "./answers.js";
import { candidateFacts, getFact, type Fact } from "./facts.js";

/**
 * Whether an answer written for one application is worth keeping.
 *
 * The last gap in the loop. An employer asks something the store has no
 * answer for, the person answers it, and until now that answer went into
 * that application's record and nowhere else — so the next form asking the
 * same thing asked them again. The store is open and the matcher can find
 * anything in it; what was missing is anything putting things in.
 *
 * Two kinds of question arrive as "custom" and only one of them is keepable:
 *
 *   a fact about them   "Do you hold a security clearance?", "How many years
 *                       of Python?", "What is your highest degree?" — true
 *                       whoever is asking, and asked by form after form.
 *
 *   a letter            "Why do you want to work here?", "What interests you
 *                       about this role?", "Have you worked for us before?" —
 *                       written for one employer, and worthless to the next.
 *
 * Telling those apart is a judgement about meaning, so a model makes it. The
 * answer goes in the prompt along with the question, which is the same
 * standing as the rest of the standing-answer path: these are the person's own
 * words about their situation, they already travel in prompts, and the answer
 * often decides it — "No" to a clearance question is a fact, and three
 * sentences about a compiler team is not.
 *
 * Nothing is stored from here. It proposes, the person is asked, and the
 * agent stores it with set_standing_answer if they say yes. An app that
 * quietly kept every answer someone gave an employer would be building a
 * profile of them out of things they said to somebody else.
 */

export const KEEP_MODEL = process.env.JOBSEARCH_KEEP_MODEL ?? "claude-haiku-5-5";

const INSTRUCTIONS = `
You are given one question from a job application, the answer the person
gave it, and the questions they already have answers on file for. Say
whether this answer is worth keeping for the next application.

Keep it when the answer is a fact about the person that does not depend on
who asked: years of experience with something, a degree or certification, a
clearance, a licence, a visa or work status, a notice period, whether they
are over a given age, what they are paid now, how soon they can start,
whether they will travel or relocate.

Do not keep it when the answer was written for this employer. "Why do you
want to work here?", "What interests you about this role?", "How did you
hear about us?", "Have you worked for us before?", "Who do you know here?",
anything about that company's product or team, anything that reads as a
paragraph of motivation rather than a statement of fact. The next employer
cannot use a word of it, and storing it would mean offering it to them.

Also do not keep:
- an answer to more than one question at once
- an answer that is only meaningful beside that form's other fields, such as
  "If yes, please explain" or "see above"
- anything about gender, race, ethnicity, veteran status, disability,
  pronouns, transgender identity, sexual orientation, age or a demographic
  survey's country, whatever the question looks like. Those are kept
  somewhere else, by the person, and never by you.

If you keep it, give:
- slug: a short name in snake_case, lower case, no spaces. If one of the
  questions already on file is the same question, use its name exactly;
  otherwise invent one.
- question: how the person would be asked this, in plain words and in the
  second person. "Do you hold a security clearance?", not "clearance" and
  not the employer's own sentence. If the answer will go out of date — a
  current salary, a current employer — word the question so that is obvious.

If you cannot tell, do not keep it.

Reply with JSON only: {"keep": true, "slug": "...", "question": "..."} or
{"keep": false}.
`.trim();

export interface Keepable {
  slug: string;
  question: string;
  /** Whether something is already stored under this name. */
  known: boolean;
}

const SLUG = /^[a-z][a-z0-9_]{1,46}$/;

/**
 * Whether this is worth keeping, and under what name.
 *
 * Null for "no", for anything it could not read, and for no credential. The
 * caller's job is to offer it; nothing here writes.
 */
export async function keepable(label: string, answer: string): Promise<Keepable | null> {
  if (!label.trim() || !answer.trim()) return null;

  const credential = await readCredential();
  if (!credential) return null;

  const facts = await candidateFacts();
  const onFile = facts.map((fact) => `- ${fact.slug}: ${fact.question}`).join("\n") || "- (none)";

  let text = "";
  try {
    for await (const message of query({
      prompt: `QUESTION\n${label}\n\nTHEIR ANSWER\n${answer}\n\nALREADY ON FILE\n${onFile}`,
      options: {
        model: KEEP_MODEL,
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
      if (message.type === "result" && message.subtype !== "success") return null;
    }
  } catch (error) {
    console.log(
      `[apply] could not judge whether to keep an answer: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  const found = text.match(/\{[\s\S]*\}/);
  if (!found) return null;

  let reply: { keep?: unknown; slug?: unknown; question?: unknown };
  try {
    reply = JSON.parse(found[0]) as typeof reply;
  } catch {
    return null;
  }

  if (reply.keep !== true) return null;
  if (typeof reply.slug !== "string" || typeof reply.question !== "string") return null;

  const slug = reply.slug.trim().toLowerCase();
  return vet(slug, String(reply.question), await getFact(slug));
}

/**
 * Whether a proposed name may be used.
 *
 * Pure, and separate from the call, because these are the checks worth having
 * a test for. Each guards against something the model is told about and could
 * still get wrong, and the cost of being wrong is not a weak suggestion — it
 * is a row in the wrong half of the store.
 */
export function vet(slug: string, question: string, existing: Fact | null): Keepable | null {
  const asked = question.trim();
  if (!SLUG.test(slug) || !asked) return null;

  /*
    A voluntary key is refused outright. An open fact called "gender" would
    sit beside the private one of that name, be matched to a demographic
    question, and be offered to an employer by the ordinary standing-answer
    path — which fills without asking. The separation in facts.ts is by
    sensitivity on a single slug, so two meanings for one slug is the one way
    to break it.
  */
  if ((SELF_ID_KEYS as readonly string[]).includes(slug)) return null;

  /*
    And a refusal is not reopened by a suggestion. If they have said they do
    not answer this, offering to store it is the app asking again with extra
    steps — whatever they happened to put on one employer's form.
  */
  if (existing && (existing.state === "declined" || existing.sensitivity === "private")) return null;

  /*
    An existing question keeps its own wording. The person may have edited it,
    and a proposal that quietly renamed what they wrote would also change what
    later forms are matched against.
  */
  return {
    slug,
    question: existing?.question ?? asked,
    known: existing?.state === "answered",
  };
}

const ASKING_RULES = `
You are given questions that job application forms asked somebody, and which
nothing on file could answer. Say which of them are worth asking the person
once, so that no later form has to ask again.

Worth asking: a question about a fact that does not depend on who asked —
years of experience with something, a degree or certification, a clearance,
a licence, a notice period, how soon they can start, whether they will
relocate or travel, what they are paid now.

Not worth asking: anything written for one employer. "Why do you want to
work here?", "What interests you about this role?", "How did you hear about
us?", "Have you worked for us before?", anything about that company in
particular, and anything that is a field of a form rather than a question —
"If yes, please explain", "Additional information", "Other".

Also never: gender, race, ethnicity, veteran status, disability, pronouns,
transgender identity, sexual orientation, age, or a demographic survey's
country. Those are the person's own and are kept elsewhere. And never
whether they may work in a country, whether they need sponsorship, or any
visa status — the app asks those itself, in its own words, and must not
inherit an employer's wording for them.

For each one worth asking, give a short snake_case slug and the question as
you would put it to them, in the second person and in plain words.

Reply with JSON only: [{"i": 0, "slug": "...", "question": "..."}], leaving
out every question not worth asking.
`.trim();

/**
 * Which of the questions nobody could answer are worth putting to the person.
 *
 * The list of unanswered questions comes out of fact_matches, which records
 * every form question nothing on file matched. Most of that list is the
 * employer's own — "Why do you want to work here?" is on every form and
 * belongs on nobody's profile — so showing it raw would be handing someone a
 * list of things to do that is mostly noise.
 *
 * Returns an empty list rather than throwing, and an empty list when there is
 * no credential: a profile page that cannot suggest anything is a profile
 * page, and one full of junk suggestions is worse than one with none.
 */
export async function worthAsking(
  labels: string[],
): Promise<{ label: string; slug: string; question: string }[]> {
  const asked = labels.map((label) => label.trim()).filter(Boolean).slice(0, 60);
  if (asked.length === 0) return [];

  const credential = await readCredential();
  if (!credential) return [];

  let text = "";
  try {
    for await (const message of query({
      prompt: `QUESTIONS\n${asked.map((label, index) => `[${index}] ${label}`).join("\n")}`,
      options: {
        model: KEEP_MODEL,
        cwd: DATA_DIR,
        systemPrompt: ASKING_RULES,
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
      if (message.type === "result" && message.subtype !== "success") return [];
    }
  } catch (error) {
    console.log(
      `[onboard] could not judge which questions are worth asking: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  const found = text.match(/\[[\s\S]*\]/);
  if (!found) return [];

  let replies: { i?: unknown; slug?: unknown; question?: unknown }[];
  try {
    const parsed = JSON.parse(found[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    replies = parsed as typeof replies;
  } catch {
    return [];
  }

  const out: { label: string; slug: string; question: string }[] = [];
  for (const reply of replies) {
    const index = typeof reply.i === "number" ? reply.i : -1;
    const label = asked[index];
    if (!label || typeof reply.slug !== "string" || typeof reply.question !== "string") continue;
    const slug = reply.slug.trim().toLowerCase();
    /* The same checks as a kept answer: see vet above. */
    const allowed = vet(slug, reply.question, await getFact(slug));
    if (allowed) out.push({ label, slug: allowed.slug, question: allowed.question });
  }
  return out;
}

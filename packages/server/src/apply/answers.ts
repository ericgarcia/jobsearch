import { all, get, run } from "../db/client.js";
import { changed } from "../notify.js";
import {
  topicOf,
  TOPIC_QUESTIONS,
  TOPICS,
  type ApplicationForm,
  type FormField,
  type Topic,
} from "./form.js";

// Re-exported so callers have one place to ask about situation questions.
export { topicOf, TOPIC_QUESTIONS, TOPICS, type Topic };

/**
 * The answers that are the same at every company, and the ones that are
 * nobody's business but the person's.
 *
 * Two stores, kept apart on purpose.
 *
 * Standing answers — work authorization, sponsorship, relocation, notice,
 * pay — are legally significant and identical on every form. An agent that
 * worked them out from a resume would be guessing about someone's right to
 * work in a country. So they are typed once, stored in the person's own
 * words, and copied.
 *
 * Self-identification is gender, race, veteran and disability status, and
 * pronouns. Those are stored too, because the person asked for their forms
 * to be filled in — but they are never sent to the model. The tools can say
 * which are set; the step that fills a form matches them to the form's
 * options in code. Nothing between the keyboard and the browser needs to
 * read them, so nothing does.
 */

/* ---------------------------------------------------------------- standing */

export interface StandingAnswer {
  topic: string;
  question: string;
  answer: string;
}

export async function listStandingAnswers(): Promise<StandingAnswer[]> {
  return await all<StandingAnswer>(
    `SELECT topic, question, answer FROM standing_answers ORDER BY topic`,
  );
}

export async function setStandingAnswer(
  topic: string,
  answer: string,
  question?: string,
): Promise<void> {
  const asked =
    question ?? TOPIC_QUESTIONS[topic as (typeof TOPICS)[number]] ?? topic.replace(/_/g, " ");

  if (!answer.trim()) {
    await run(`DELETE FROM standing_answers WHERE topic = ?`, topic);
  } else {
    await run(
      `INSERT INTO standing_answers (topic, question, answer, updated_at)
            VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (topic) DO UPDATE SET
            question = excluded.question,
            answer = excluded.answer,
            updated_at = excluded.updated_at`,
      topic,
      asked,
      answer.trim(),
    );
  }
  changed("profile");
}

/* ------------------------------------------------------- self-identification */

/*
  What a voluntary section can ask, and so what there has to be room to store.

  The first five were the legally reported ones. The rest are here because
  real surveys ask them and nothing could answer them: a question with no
  key is left blank with "nothing stored", which is correct and is also the
  app declining to do the thing it was asked to do.

  `location` is a country asked inside a demographic survey, and it is kept
  apart from the profile's location on purpose. The profile holds a city
  because an employer needs to post a contract to it. Answering a
  demographic question from it would be taking something given for one
  purpose and disclosing it for another, which is the person's call and not
  this file's — so it is stored again, here, by them, or not at all.
*/
export const SELF_ID_KEYS = [
  "gender",
  "race",
  "veteran",
  "disability",
  "pronouns",
  "transgender",
  "sexual_orientation",
  "age",
  "location",
] as const;
export type SelfIdKey = (typeof SELF_ID_KEYS)[number];

/*
  Order is load-bearing, specific before general. "Do you identify as
  transgender?" is a gender question by its words, and matching it to the
  gender answer would put "Woman" in front of a yes/no.
*/
const SELF_ID_PATTERNS: [SelfIdKey, RegExp][] = [
  ["pronouns", /\bpronoun/i],
  ["disability", /\bdisabilit/i],
  ["veteran", /\bveteran|\bmilitary\b/i],
  ["transgender", /\btransgender|\btrans\b/i],
  ["sexual_orientation", /\bsexual orientation|\borientation\b|\blgbt/i],
  ["age", /\bage\b|\bdate of birth\b|\bbirth year\b|\bgeneration\b/i],
  ["race", /\b(?:race|racial|ethnic|hispanic|latin)/i],
  ["gender", /\b(?:gender|sex\b)/i],
  ["location", /\blocation\b|\bcountry\b|\bwhere do you live\b/i],
];

/** Which self-identification question a field is, if it is one. */
export function selfIdKeyOf(label: string): SelfIdKey | null {
  for (const [key, pattern] of SELF_ID_PATTERNS) {
    if (pattern.test(label)) return key;
  }
  return null;
}

/**
 * The stored values.
 *
 * Deliberately not exported through any agent tool. The only callers are
 * the person's own page and the code that fills a form.
 */
export async function readSelfIdentification(): Promise<Record<string, string>> {
  const rows = await all<{ key: string; value: string }>(
    `SELECT key, value FROM self_identification`,
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function setSelfIdentification(key: string, value: string): Promise<void> {
  if (!value.trim()) {
    await run(`DELETE FROM self_identification WHERE key = ?`, key);
  } else {
    await run(
      `INSERT INTO self_identification (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value.trim(),
    );
  }
  changed("profile");
}

/** Which of them are set. The values themselves never leave this module. */
export async function selfIdentificationKeysSet(): Promise<string[]> {
  const rows = await all<{ key: string }>(`SELECT key FROM self_identification ORDER BY key`);
  return rows.map((row) => row.key);
}

/* -------------------------------------------------- filling them in, or not */

/**
 * Whether the person asked for this application's voluntary section to be
 * filled in.
 *
 * Per application, and unanswered until they say. Declining to disclose is
 * a complete answer to every one of these questions, so silence means
 * blank: an app that filled them because they were stored would be making
 * the disclosure decision on their behalf, once per employer, invisibly.
 *
 * It is asked per application rather than once, because the decision is
 * about this employer. Somewhere they want to work and somewhere they are
 * applying to on a whim are not the same company, and a standing "yes"
 * would answer for both.
 */
export async function voluntaryChoice(jobId: number): Promise<boolean | null> {
  const row = await get<{ fill: number }>(
    `SELECT fill FROM voluntary_answers WHERE job_id = ?`,
    jobId,
  );
  return row ? row.fill === 1 : null;
}

export async function setVoluntaryChoice(jobId: number, fill: boolean): Promise<void> {
  await run(
    `INSERT INTO voluntary_answers (job_id, fill, at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (job_id) DO UPDATE SET fill = excluded.fill, at = excluded.at`,
    jobId,
    fill ? 1 : 0,
  );
  changed("applications");
}

export interface VoluntarySection {
  /** The questions, which are the labels and never the answers. */
  questions: { label: string; required: boolean; stored: boolean }[];
  /** Which of them this app could answer from what is stored. */
  answerable: number;
  /** What the person has decided for this application. */
  choice: "fill" | "blank" | null;
}

/**
 * The voluntary part of one application, and what has been decided about it.
 *
 * Labels are questions, not answers, so they are safe to show and to say
 * out loud. Which keys are set is safe too. The values are not here and are
 * not reachable from here.
 */
export async function voluntarySection(
  form: ApplicationForm,
  jobId: number,
): Promise<VoluntarySection> {
  const [keys, choice] = await Promise.all([
    selfIdentificationKeysSet(),
    voluntaryChoice(jobId),
  ]);
  const have = new Set(keys);

  const questions = form.fields
    .filter((field) => field.kind === "eeo")
    .map((field) => {
      const key = selfIdKeyOf(field.label);
      return {
        label: field.label,
        required: field.required,
        stored: key !== null && have.has(key),
      };
    });

  return {
    questions,
    answerable: questions.filter((question) => question.stored).length,
    choice: choice === null ? null : choice ? "fill" : "blank",
  };
}

/* ---------------------------------------------------------------- coverage */

export interface Covered {
  label: string;
  required: boolean;
  kind: FormField["kind"];
  /** Where the answer would come from, or null when there is none. */
  from: "profile" | "documents" | "standing" | "self_identification" | null;
  /** The reason, when nothing can answer it. */
  missing?: string;
}

export interface Coverage {
  answerable: number;
  total: number;
  fields: Covered[];
  /** The questions only the person can settle, in the order they are asked. */
  needsYou: Covered[];
}

/**
 * What an application asks that this app can already answer.
 *
 * The useful question before starting, and more useful across a shortlist:
 * four applications that need nothing new are four that can be drafted now,
 * and one that asks about notice is a thing to decide once and never again.
 */
export async function coverage(form: ApplicationForm): Promise<Coverage> {
  const [standing, selfIdKeys, profile] = await Promise.all([
    listStandingAnswers(),
    selfIdentificationKeysSet(),
    get<{ name: string | null; email: string | null; phone: string | null }>(
      `SELECT name, email, phone FROM profile WHERE id = 1`,
    ),
  ]);

  const haveTopic = new Set(standing.map((row) => row.topic));
  const haveSelfId = new Set(selfIdKeys);

  const fields: Covered[] = form.fields.map((field) => {
    if (field.kind === "identity" || field.kind === "link") {
      const known = profile?.name && profile.email;
      return {
        label: field.label,
        required: field.required,
        kind: field.kind,
        from: known ? ("profile" as const) : null,
        ...(known ? {} : { missing: "The profile has no name or email yet." }),
      };
    }

    if (field.kind === "document") {
      return { label: field.label, required: field.required, kind: field.kind, from: "documents" };
    }

    if (field.kind === "standing") {
      const topic = topicOf(field.label);
      const have = topic !== "other" && haveTopic.has(topic);
      return {
        label: field.label,
        required: field.required,
        kind: field.kind,
        from: have ? ("standing" as const) : null,
        ...(have
          ? {}
          : {
              missing:
                topic === "other"
                  ? "Not one of the standing answers; it needs a decision."
                  : `No standing answer stored for ${topic.replace(/_/g, " ")}.`,
            }),
      };
    }

    if (field.kind === "eeo") {
      const key = selfIdKeyOf(field.label);
      const have = key !== null && haveSelfId.has(key);
      return {
        label: field.label,
        required: field.required,
        kind: field.kind,
        from: have ? ("self_identification" as const) : null,
        ...(have
          ? {}
          : { missing: "Voluntary, and not stored. It stays blank unless you say." }),
      };
    }

    if (field.kind === "consent") {
      return {
        label: field.label,
        required: field.required,
        kind: field.kind,
        from: null,
        missing: "A consent. Left untouched unless the person ticks it themselves.",
      };
    }

    return {
      label: field.label,
      required: field.required,
      kind: field.kind,
      from: null,
      missing: "Their own question. It needs an answer written for this application.",
    };
  });

  return {
    answerable: fields.filter((field) => field.from !== null).length,
    total: fields.length,
    fields,
    /*
      Self-identification is left out of "needs you" on purpose. Leaving it
      blank is a complete answer, and listing it as an outstanding task
      would be the app nagging someone to disclose their disability status.
    */
    /*
      Self-identification and consent ticks are left out of "needs you" on
      purpose: in both cases doing nothing is a complete answer. Listing
      them would be the app nagging someone to disclose a disability, or
      carrying a company's marketing request to them once per application.
    */
    needsYou: fields.filter(
      (field) => field.from === null && field.kind !== "eeo" && field.kind !== "consent",
    ),
  };
}

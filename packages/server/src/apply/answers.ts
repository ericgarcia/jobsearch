import { all, get, run } from "../db/client.js";
import { changed } from "../notify.js";
import type { ApplicationForm, FormField } from "./form.js";

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

export const TOPICS = [
  "work_authorization",
  "sponsorship",
  "relocation",
  "onsite",
  "notice_period",
  "start_date",
  "salary",
] as const;

export type Topic = (typeof TOPICS)[number] | "other";

/** What each topic is called when the app asks for it. */
export const TOPIC_QUESTIONS: Record<(typeof TOPICS)[number], string> = {
  work_authorization: "Are you legally authorised to work where the job is?",
  sponsorship: "Will you need visa sponsorship, now or later?",
  relocation: "Are you willing to relocate?",
  onsite: "How many days a week can you be in an office?",
  notice_period: "What notice do you have to give?",
  start_date: "When could you start?",
  salary: "What are you looking for in pay?",
};

/*
  Which topic a form field is asking about.

  Ordered, and the order matters: a sponsorship question nearly always says
  "authorization" somewhere in it — "will you require sponsorship to retain
  or extend your work authorization" — so sponsorship has to be tried first
  or every one of them answers the authorization question instead. Two
  questions with opposite meanings and the same words in them is exactly the
  case worth writing a test for.
*/
const TOPIC_PATTERNS: [(typeof TOPICS)[number], RegExp][] = [
  ["sponsorship", /\b(?:sponsor|visa)/i],
  ["work_authorization", /\b(?:authoriz|authoris|right to work|work permit|eligible to work)/i],
  ["relocation", /\brelocat|willing to move/i],
  ["onsite", /\b(?:in[-\s]?person|in[-\s]?office|on[-\s]?site|hybrid|days? (?:a|per) week)/i],
  ["notice_period", /\bnotice period|notice do you/i],
  ["start_date", /\b(?:start date|available to start|when (?:could|can) you start|earliest start)/i],
  ["salary", /\b(?:salar|compensation|desired pay|pay expectation)/i],
];

export function topicOf(label: string): Topic {
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(label)) return topic;
  }
  return "other";
}

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

export const SELF_ID_KEYS = ["gender", "race", "veteran", "disability", "pronouns"] as const;
export type SelfIdKey = (typeof SELF_ID_KEYS)[number];

const SELF_ID_PATTERNS: [SelfIdKey, RegExp][] = [
  ["pronouns", /\bpronoun/i],
  ["disability", /\bdisabilit/i],
  ["veteran", /\bveteran|\bmilitary\b/i],
  ["race", /\b(?:race|racial|ethnic|hispanic|latin)/i],
  ["gender", /\b(?:gender|sex\b)/i],
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
        ...(have ? {} : { missing: "Voluntary, and not stored. It stays blank unless you say." }),
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
    needsYou: fields.filter((field) => field.from === null && field.kind !== "eeo"),
  };
}

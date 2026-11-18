import { all, get, run } from "../db/client.js";
import { changed } from "../notify.js";
import { voluntaryDefault, type VoluntaryDefault } from "../settings.js";
import { declineFact, getFact, listFacts, recordFact, setFact, shareableFacts } from "./facts.js";
import { matchFacts } from "./match.js";
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

/*
  A standing answer is an open fact that may be sent.

  These functions are the old shape over the new store, kept because every
  caller — the person's page, the form filler, the agent tools — speaks in
  topics, and because the eight topics are still the questions worth asking
  first. What changed underneath is that they are no longer the only ones
  there is room for. `topic` here is a fact's slug; a slug the list has never
  heard of sits beside them with the same standing. See apply/facts.ts.
*/
export interface StandingAnswer {
  topic: string;
  question: string;
  answer: string;
}

export async function listStandingAnswers(): Promise<StandingAnswer[]> {
  const facts = await shareableFacts();
  return facts
    .filter((fact) => fact.sensitivity === "open")
    .map((fact) => ({ topic: fact.slug, question: fact.question, answer: fact.answer ?? "" }));
}

export async function setStandingAnswer(
  topic: string,
  answer: string,
  question?: string,
): Promise<void> {
  const asked =
    question ?? TOPIC_QUESTIONS[topic as (typeof TOPICS)[number]] ?? topic.replace(/_/g, " ");
  await setFact({ slug: topic, question: asked, answer, sensitivity: "open", source: "profile" });
}

/**
 * Record that they would rather not answer a situation question.
 *
 * Separate from storing an empty answer, which only means the app has
 * nothing. This means the app has been told, and the difference shows up as
 * the next form either asking again or not.
 */
export async function declineStandingAnswer(topic: string, question?: string): Promise<void> {
  const asked =
    question ?? TOPIC_QUESTIONS[topic as (typeof TOPICS)[number]] ?? topic.replace(/_/g, " ");
  await declineFact({ slug: topic, question: asked, sensitivity: "open", source: "profile" });
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
  What the app calls each one when it has to name it.

  Needed because these questions now have rows of their own in the fact
  store, and a row with no question in it cannot be shown to the person whose
  refusal it records. The wordings are the app's, not any employer's: a form
  asks this in its own words, and the match between the two is made by
  apply/classify.ts.
*/
export const SELF_ID_QUESTIONS: Record<SelfIdKey, string> = {
  gender: "Gender",
  race: "Race or ethnicity",
  veteran: "Veteran status",
  disability: "Disability status",
  pronouns: "Pronouns",
  transgender: "Whether you identify as transgender",
  sexual_orientation: "Sexual orientation",
  age: "Age or year of birth",
  location: "The country a demographic survey asks you to give",
};

/*
  The answers themselves, as a fixed vocabulary.

  Not decoration on a text box: it is what makes the promise about these
  values keepable. A form words the same answer a hundred ways — "White (Not
  Hispanic or Latino)", "White: Any other White background", "White or
  Caucasian" — and matching a free-text answer to one of those is a
  judgement about meaning. The only way to make that judgement well is to
  show it to a model, and the one thing that must never be shown to a model
  is this value.

  So the judgement is inverted: the model is asked what the form's options
  mean, in these tokens, and the comparison is token to token in code. For
  that to work the stored answer has to be a token too, which is why the page
  offers a list rather than a box.

  The wordings are the US federal categories, which is what the employers
  asking are reporting against. "Prefer not to disclose" is one of the
  answers, not the absence of one: it is offered on the form, and someone who
  chooses it has answered.
*/
export const DECLINE = "decline";

export const SELF_ID_VALUES: Partial<Record<SelfIdKey, { token: string; label: string }[]>> = {
  gender: [
    { token: "woman", label: "Woman" },
    { token: "man", label: "Man" },
    { token: "non_binary", label: "Non-binary" },
    { token: "other_term", label: "I use another term" },
    { token: DECLINE, label: "Prefer not to disclose" },
  ],
  race: [
    { token: "american_indian", label: "American Indian or Alaska Native" },
    { token: "asian", label: "Asian" },
    { token: "black", label: "Black or African American" },
    { token: "hispanic", label: "Hispanic or Latino" },
    { token: "pacific_islander", label: "Native Hawaiian or Other Pacific Islander" },
    { token: "white", label: "White" },
    { token: "two_or_more", label: "Two or more races" },
    { token: DECLINE, label: "Prefer not to disclose" },
  ],
  veteran: [
    { token: "yes", label: "Yes, I am a veteran" },
    { token: "no", label: "No, I am not a veteran" },
    { token: DECLINE, label: "Prefer not to disclose" },
  ],
  disability: [
    { token: "yes", label: "Yes, I have or have had a disability" },
    { token: "no", label: "No, I do not" },
    { token: DECLINE, label: "Prefer not to disclose" },
  ],
  pronouns: [
    { token: "he_him", label: "He / him" },
    { token: "she_her", label: "She / her" },
    { token: "they_them", label: "They / them" },
    { token: "other", label: "Another set" },
    { token: DECLINE, label: "Prefer not to disclose" },
  ],
  transgender: [
    { token: "yes", label: "Yes" },
    { token: "no", label: "No" },
    { token: DECLINE, label: "Prefer not to disclose" },
  ],
  sexual_orientation: [
    { token: "heterosexual", label: "Heterosexual" },
    { token: "gay", label: "Gay" },
    { token: "lesbian", label: "Lesbian" },
    { token: "bisexual", label: "Bisexual" },
    { token: "queer", label: "Queer" },
    { token: "asexual", label: "Asexual" },
    { token: "other", label: "Another orientation" },
    { token: DECLINE, label: "Prefer not to disclose" },
  ],
};

/*
  The two that are not a list. Age is a year and location is a country, and
  both are matched to a form's own options by their words — which works,
  because a country list says "United States" and not a code.
*/
export function isTokenised(key: SelfIdKey): boolean {
  return SELF_ID_VALUES[key] !== undefined;
}

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

  /*
    A row in the fact store beside it, carrying the state and never the
    value. Without one there is nowhere to write a refusal, and nowhere to
    say that this question was asked — which is what makes "stop asking me
    this" possible at all. The CHECK on the table refuses an answer here.
  */
  await noteSelfIdFact(key, value.trim() ? "answered" : "asked");
  changed("profile");
}

async function noteSelfIdFact(key: string, state: "answered" | "asked"): Promise<void> {
  const existing = await getFact(key);

  /*
    Clearing a value does not withdraw a refusal, and does not create one.
    Someone deleting what they typed has left the app with nothing, which is
    a different state from having told it not to ask.
  */
  if (state === "asked" && existing?.state === "declined") return;

  await recordFact({
    slug: key,
    question: SELF_ID_QUESTIONS[key as SelfIdKey] ?? key.replace(/_/g, " "),
    sensitivity: "private",
    state,
    // Typing a value is how a refusal is withdrawn, so sharing is offerable again.
    ...(state === "answered" ? { share: "ask" as const } : {}),
    source: "profile",
  });
}

/**
 * Record that they do not want to give a voluntary detail, ever.
 *
 * Not the same as the `decline` token, which is an answer the form itself
 * offers and which gets ticked. This one means the app should stop asking:
 * the question is left blank, it is not raised on the next application, and
 * the stored value, if there was one, goes.
 */
export async function declineSelfIdentification(key: string): Promise<void> {
  await declineFact({
    slug: key,
    question: SELF_ID_QUESTIONS[key as SelfIdKey] ?? key.replace(/_/g, " "),
    sensitivity: "private",
    source: "profile",
  });
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
export async function voluntaryChoices(jobId: number): Promise<Map<string, boolean>> {
  const rows = await all<{ key: string; include: number }>(
    `SELECT key, include FROM voluntary_choices WHERE job_id = ?`,
    jobId,
  );
  return new Map(rows.map((row) => [row.key, row.include === 1]));
}

/**
 * Record which voluntary questions to include on one application.
 *
 * Per question, because "fill in the voluntary part" is not one decision.
 * Someone may be glad to give an employer their pronouns and have no
 * intention of giving a disability status, and a single yes answers both. So
 * both lists are explicit and a key in neither stays undecided, which means
 * blank.
 */
export async function setVoluntaryChoices(
  jobId: number,
  include: string[],
  exclude: string[] = [],
): Promise<void> {
  const wanted = new Map<string, boolean>();
  for (const key of exclude) wanted.set(key, false);
  for (const key of include) wanted.set(key, true);

  for (const [key, yes] of wanted) {
    await run(
      `INSERT INTO voluntary_choices (job_id, key, include, at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT (job_id, key) DO UPDATE SET include = excluded.include, at = excluded.at`,
      jobId,
      key,
      yes ? 1 : 0,
    );
  }
  changed("applications");
}

/**
 * Which voluntary keys may be filled on this application.
 *
 * Three things have to agree, and any one of them is a no: the person has
 * not said they never disclose, they have not told the app to stop asking
 * this particular question, and they have said yes to it for this employer.
 */
export async function includedKeys(jobId: number): Promise<Set<string>> {
  const standing = await voluntaryDefault();
  if (standing === "never") return new Set();

  const [chosen, facts] = await Promise.all([voluntaryChoices(jobId), listFacts("private")]);
  const refused = new Set(
    facts.filter((fact) => fact.state === "declined" || fact.share === "never").map((f) => f.slug),
  );

  const allowed = new Set<string>();
  for (const [key, include] of chosen) {
    if (include && !refused.has(key)) allowed.add(key);
  }
  return allowed;
}

export interface VoluntaryQuestion {
  /** The employer's own words. Never an answer. */
  label: string;
  /** Which stored detail would answer it, if any. */
  key: string | null;
  required: boolean;
  /** Whether something on file could answer it. */
  stored: boolean;
  /** Whether they have told the app not to ask this again. */
  declined: boolean;
  /** Their decision for this application: null until they make one. */
  include: boolean | null;
}

export interface VoluntarySection {
  questions: VoluntaryQuestion[];
  /** How many could be answered from what is stored, refusals aside. */
  answerable: number;
  /** How many still need confirming on this application. */
  undecided: number;
  /** "never" when they have said they do not disclose, anywhere. */
  standing: VoluntaryDefault;
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
  const [keys, chosen, privateFacts, standing] = await Promise.all([
    selfIdentificationKeysSet(),
    voluntaryChoices(jobId),
    listFacts("private"),
    voluntaryDefault(),
  ]);
  const have = new Set(keys);
  const refused = new Set(
    privateFacts
      .filter((fact) => fact.state === "declined" || fact.share === "never")
      .map((fact) => fact.slug),
  );

  /*
    One row per detail, not per field.

    Lever's page carries every survey the employer ever configured and shows
    one of them, so the person was first told their form had nine voluntary
    questions — the same one three times over. Collapsing repeated labels
    fixed most of it and not all: Spotify asks "What best describes your
    gender?" and "What gender do you identify with?", which is one thing to
    decide and was listed as two.

    So the key decides, where there is one. Two labels with the same key are
    answered from the same stored detail by definition — it is the same
    function the filler uses to choose a value — so a decision about one is a
    decision about both. A question with no key falls back to its label,
    which is all there is to go on.
  */
  const asked = new Set<string>();
  const questions = form.fields
    .filter((field) => field.kind === "eeo")
    .filter((field) => {
      const once = selfIdKeyOf(field.label) ?? field.label.trim().toLowerCase();
      if (asked.has(once)) return false;
      asked.add(once);
      return true;
    })
    .map((field) => {
      const key = selfIdKeyOf(field.label);
      const declined = key !== null && refused.has(key);
      return {
        label: field.label,
        key,
        required: field.required,
        stored: key !== null && have.has(key) && !declined,
        declined,
        /*
          A refusal settles the question without the person being asked
          again. That is the point of writing one down: "no" is a decision,
          not an absence, and re-asking it once per employer is the app
          deciding it knows better.
        */
        include: declined ? false : key === null ? false : (chosen.get(key) ?? null),
      };
    });

  return {
    questions,
    answerable: questions.filter((question) => question.stored).length,
    undecided:
      standing === "never"
        ? 0
        : questions.filter((question) => question.stored && question.include === null).length,
    standing,
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
  /**
   * Whether the person has already settled this, by refusing it or by
   * keeping the answer off forms.
   *
   * Separate from `missing` because the two read alike and are not alike. A
   * field with no answer is a thing to do; a field they have decided about
   * is done, and putting it on their list is the app asking again.
   */
  settled?: boolean;
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
  const [standing, selfIdKeys, facts, matched, profile] = await Promise.all([
    listStandingAnswers(),
    selfIdentificationKeysSet(),
    listFacts(),
    /*
      Which stored answer each question wants, read rather than looked up by
      name. This is what lets a question outside the eight seeded ones be
      answered at all — see apply/match.ts. It never throws: a form it cannot
      read falls back to the patterns over those eight.
    */
    matchFacts(
      form.fields
        .filter((field) => field.kind === "standing" || field.kind === "custom")
        .map((field) => ({
          label: field.label,
          ...(field.section ? { section: field.section } : {}),
        })),
    ),
    get<{ name: string | null; email: string | null; phone: string | null }>(
      `SELECT name, email, phone FROM profile WHERE id = 1`,
    ),
  ]);

  const haveTopic = new Set(standing.map((row) => row.topic));
  const haveSelfId = new Set(selfIdKeys);
  const bySlug = new Map(facts.map((fact) => [fact.slug, fact]));
  const declined = new Set(
    facts
      .filter((fact) => fact.state === "declined" || fact.share === "never")
      .map((fact) => fact.slug),
  );

  /*
    What a question is answered by, or the reason it is not. One function
    because the answer and the excuse come from the same lookup, and a field
    that said "nothing stored" while a refusal sat on file was the bug this
    whole store exists to fix.
  */
  const answeredBy = (label: string): { slug?: string; why?: string; settled?: boolean } => {
    const slug = matched.get(label);
    if (!slug) return {};
    const fact = bySlug.get(slug);
    if (!fact) return {};
    if (fact.state === "declined") {
      return { why: "You have asked not to be asked this. Left blank.", settled: true };
    }
    if (fact.share === "never") {
      return {
        why: `You have "${fact.question}" on file but kept it off forms. Left blank.`,
        settled: true,
      };
    }
    return { slug };
  };

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
      /*
        A refusal is reported as a refusal and not as a gap. Listed as
        missing it would come back as a thing to do on every application,
        which is the app asking a question it has already answered.
      */
      const found = answeredBy(field.label);
      const topic = topicOf(field.label);
      const refusedByTopic = topic !== "other" && declined.has(topic);
      return {
        label: field.label,
        required: field.required,
        kind: field.kind,
        from: found.slug ? ("standing" as const) : null,
        ...(found.slug
          ? {}
          : {
              missing:
                found.why ??
                (refusedByTopic
                  ? "You have asked not to be asked this. Left blank."
                  : topic === "other"
                    ? "Nothing on file answers this one; it needs a decision."
                    : `No answer stored for ${topic.replace(/_/g, " ")}.`),
              ...(found.settled || refusedByTopic ? { settled: true } : {}),
            }),
      };
    }

    if (field.kind === "eeo") {
      const key = selfIdKeyOf(field.label);
      const refused = key !== null && declined.has(key);
      const have = key !== null && haveSelfId.has(key) && !refused;
      return {
        label: field.label,
        required: field.required,
        kind: field.kind,
        from: have ? ("self_identification" as const) : null,
        ...(have
          ? {}
          : {
              missing: refused
                ? "You have asked not to be asked this. Left blank."
                : "Voluntary, and not stored. It stays blank unless you say.",
            }),
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

    /*
      The employer's own question — unless something on file turns out to
      answer it. A clearance or a degree asked in the middle of a company's
      own section is still a fact about the person, and before the fact store
      existed it was answered once, for that employer, and thrown away.
    */
    const found = answeredBy(field.label);
    return {
      label: field.label,
      required: field.required,
      kind: field.kind,
      from: found.slug ? ("standing" as const) : null,
      ...(found.slug
        ? {}
        : {
            missing:
              found.why ?? "Their own question. It needs an answer written for this application.",
            ...(found.settled ? { settled: true } : {}),
          }),
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
      (field) =>
        field.from === null &&
        !field.settled &&
        field.kind !== "eeo" &&
        field.kind !== "consent",
    ),
  };
}

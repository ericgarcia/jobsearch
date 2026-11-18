import crypto from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "../config.js";
import { all, run } from "../db/client.js";
import { credentialEnv, readCredential } from "../settings.js";
import { SELF_ID_KEYS, type SelfIdKey } from "./answers.js";
import {
  byWords,
  topicOf,
  TOPICS,
  type FieldKind,
  type FormField,
  type Topic,
} from "./form.js";
import { selfIdKeyOf } from "./answers.js";

/**
 * What an application field is asking, decided by reading it.
 *
 * This replaced a page of regular expressions, and it replaced them because
 * they were wrong in the way that matters. "What is your location?" is a
 * contact detail at the top of a form and a demographic disclosure under the
 * heading "Demographic Survey", and no pattern over the label can tell those
 * apart — so one of them was answered from the profile. The words are the
 * same; the meaning is not. Meaning is what a model is for.
 *
 * Three decisions, all of them about the employer's text:
 *
 *   kind   who answers this field at all
 *   topic  which standing answer a situation question wants
 *   key    which stored voluntary answer a self-identification question wants
 *   slot   which single thing on file answers it: a profile attribute, or a
 *          kind of link
 *
 * What is sent is the form's own words: labels, section headings, the options
 * the form offers. What is never sent is anything the person stored. The
 * model is asked which question is being put, never what the answer is, and
 * self-identification values do not exist in this file — matching one to a
 * form's options stays in code, in fill.ts, for exactly that reason.
 *
 * It is cached per label, so a question asked by a second employer costs
 * nothing, and it falls back to the keyword layer when there is no
 * credential or the call fails. A fallback that fills a form slightly worse
 * is better than an app that cannot fill one at all, and the report says
 * which route a field came through.
 */

export const CLASSIFY_MODEL = process.env.JOBSEARCH_CLASSIFY_MODEL ?? "claude-haiku-5-5";

/*
  How long a verdict is trusted.

  A question's meaning does not change, so this is not about the form going
  stale. It is about this file: the kinds, the rules and the model are all
  edited, and a cache with no expiry would keep serving judgements made under
  rules that no longer exist, in the one part of the app whose mistakes get
  sent to an employer. Three months is short enough that a mistake ages out
  on its own and long enough that a season of applying is nearly free.

  The model and the rules are checked exactly, so editing either expires
  every row that depended on it immediately — which is the behaviour you want
  the moment you find a question being classified wrongly.
*/
const TRUST_DAYS = Number(process.env.JOBSEARCH_CLASSIFY_TRUST_DAYS ?? 90);

/*
  The things this app holds one of, which a field can be asking for.

  Named rather than matched, because the label does not say: "Where are you
  based?", "City", "Location" and "Country" are four labels and three
  different answers, and the pattern that read all four as the profile's
  location put a city into a list of countries. The model says which one of
  these a field wants; the value is looked up in code.
*/
export const SLOTS = [
  "full_name",
  "first_name",
  "last_name",
  "preferred_name",
  "email",
  "phone",
  "location",
  "city",
  "country",
  "postcode",
  "address",
  "linkedin",
  "github",
  "portfolio",
  "website",
  "twitter",
  "scholar",
  "other_link",
] as const;
export type Slot = (typeof SLOTS)[number];

export interface Classified {
  kind: FieldKind;
  /** Set when the kind is standing. */
  topic?: Topic;
  /** Set when the kind is eeo and a stored answer could answer it. */
  key?: SelfIdKey;
  /** Set when the kind is identity or link: the one thing on file it wants. */
  slot?: Slot;
  /** Which route decided this, for the record and for debugging a bad fill. */
  by: "model" | "words" | "cache";
}

/** One question, as the form words it. Nothing of the person's is in here. */
export interface Asked {
  label: string;
  section?: string;
  options?: string[];
  required?: boolean;
}

const KINDS = new Set<FieldKind>([
  "identity",
  "document",
  "link",
  "standing",
  "eeo",
  "consent",
  "custom",
]);

/*
  The cache key is the question and the heading it sits under, because those
  two together are the question. The options are left out: a country list and
  a shorter country list are the same question, and keying on them would pay
  for every employer's own wording of the same choice.
*/
export function fingerprint(asked: Asked): string {
  return crypto
    .createHash("sha256")
    .update(`${asked.label.trim().toLowerCase()}\u0000${(asked.section ?? "").trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

const INSTRUCTIONS = `
You read the fields of a job application form and say who answers each one.
You never answer them. You are given the employer's own words — the label,
the heading above it, and the choices it offers — and nothing about the
person applying.

For each field reply with a kind:

  identity  the applicant's name, email, phone, address or city, asked as a
            contact detail
  link      a URL: LinkedIn, GitHub, a portfolio, a personal site
  document  a file the applicant uploads: resume, CV, cover letter,
            transcript, writing sample
  standing  a question about their working situation whose answer is the same
            at every company and is legally significant: work authorisation,
            visa sponsorship, relocation, days in an office, notice period,
            start date, pay expectations, current employer
  eeo       voluntary self-identification, asked for equal-opportunity
            reporting: gender, race or ethnicity, veteran status, disability,
            pronouns, transgender identity, sexual orientation, age, or a
            demographic country. Declining is always allowed
  consent   a tick giving the employer permission for something, usually
            marketing or keeping the application on file
  custom    this employer's own question, which the applicant has to write an
            answer to

Rules, in order of precedence:

1. A field under a heading that marks a voluntary or demographic section —
   "Demographic Survey", "Voluntary Self-Identification", "Equal Employment
   Opportunity", and the like — is "eeo" whatever it asks. A country asked
   inside a demographic survey is a demographic question, not an address.
   This is the rule the form's own structure gives you, and it outranks the
   words of the label.
2. If you cannot tell what a field is, answer "custom". A question put to the
   applicant costs them a minute. A question answered by something that
   guessed wrong goes to an employer in their name.
3. Never read a question about someone's right to work as a question about
   where they live.

For "standing", also give the topic, one of:
${TOPICS.join(", ")}

For "eeo", also give the stored answer it wants, one of:
${SELF_ID_KEYS.join(", ")}
Use "location" for a country or region asked as a demographic question. Leave
the key out if none of them is what the question asks for.

For "identity" and "link", also give the slot: the one thing on file that
answers it, out of:
${SLOTS.join(", ")}

Be exact about these, because the wrong one is filled in and sent. "City",
"Location" and "Where are you based?" are the city someone lives in;
"Country" is a country and "Postcode" is a postcode, and a city is not an
answer to either. "Full name" is not "First name". A field that wants a URL
gets the link slot that names the site it asks for, and "portfolio" or
"website" for a personal site. Leave the slot out if nothing in the list is
what the field asks for.

Reply with JSON only, no prose: an array with one object per field, in the
order given, each {"i": <index>, "kind": "<kind>", "topic": "<omitted unless standing>", "key": "<omitted unless eeo>", "slot": "<omitted unless identity or link>"}.
`.trim();

/*
  A fingerprint of the instructions, so that editing them invalidates what
  they produced. It is the whole prompt, which includes the list of kinds and
  the list of stored voluntary answers — add a key and every cached eeo
  verdict is reconsidered, which is correct, because the old one was made
  without that option.
*/
const RULES = crypto.createHash("sha256").update(INSTRUCTIONS).digest("hex").slice(0, 16);

interface Reply {
  i?: number;
  kind?: string;
  topic?: string;
  key?: string;
  slot?: string;
}

function parseReply(text: string): Reply[] | null {
  const found = text.match(/\[[\s\S]*\]/);
  if (!found) return null;
  try {
    const parsed = JSON.parse(found[0]) as unknown;
    return Array.isArray(parsed) ? (parsed as Reply[]) : null;
  } catch {
    return null;
  }
}

/*
  The slot a label looks like it wants, by its words. The fallback's fallback,
  and as rough as it sounds: these are the patterns the model call replaced.
*/
const SLOT_PATTERNS: [Slot, RegExp][] = [
  ["first_name", /\bfirst name\b|\bgiven name\b/i],
  ["last_name", /\blast name\b|\bfamily name\b|\bsurname\b/i],
  ["preferred_name", /\bpreferred name\b/i],
  ["email", /e-?mail/i],
  ["phone", /\bphone\b|\bmobile\b|\btelephone\b/i],
  ["postcode", /\bpostcode\b|\bpostal code\b|\bzip\b/i],
  ["country", /\bcountry\b/i],
  ["address", /\baddress\b|\bstreet\b/i],
  ["city", /\bcity\b|\btown\b/i],
  ["location", /\blocation\b|where are you based/i],
  ["full_name", /\bname\b/i],
  ["linkedin", /linkedin/i],
  ["github", /github|gitlab/i],
  ["scholar", /scholar/i],
  ["twitter", /twitter|\bx\.com\b/i],
  ["portfolio", /\bportfolio\b/i],
  ["website", /\bwebsite\b|personal site|\bblog\b/i],
];

function slotByWords(label: string): Slot | undefined {
  for (const [slot, pattern] of SLOT_PATTERNS) {
    if (pattern.test(label)) return slot;
  }
  return undefined;
}

/** The keyword layer, which is the fallback and no longer the rule. */
export function classifyByWords(asked: Asked): Classified {
  const kind = byWords(asked.label, asked.section);
  if (kind === "standing") return { kind, topic: topicOf(asked.label), by: "words" };
  if (kind === "eeo") {
    const key = selfIdKeyOf(asked.label);
    return { kind, ...(key ? { key } : {}), by: "words" };
  }
  if (kind === "identity" || kind === "link") {
    const slot = slotByWords(asked.label);
    return { kind, ...(slot ? { slot } : {}), by: "words" };
  }
  return { kind, by: "words" };
}

/**
 * The verdicts still worth trusting, keyed by fingerprint.
 *
 * Exported so the expiry can be tested. A cache whose expiry nobody has
 * watched work is a cache that does not expire.
 */
export async function cached(keys: string[]): Promise<Map<string, Classified>> {
  if (keys.length === 0) return new Map();
  const rows = await all<{
    fingerprint: string;
    kind: string;
    topic: string | null;
    self_id_key: string | null;
    slot: string | null;
  }>(
    `SELECT fingerprint, kind, topic, self_id_key, slot FROM field_classifications
      WHERE fingerprint IN (${keys.map(() => "?").join(",")})
        AND model = ?
        AND rules = ?
        AND at > datetime('now', ?)`,
    ...keys,
    CLASSIFY_MODEL,
    RULES,
    `-${Math.max(1, TRUST_DAYS)} days`,
  );

  const found = new Map<string, Classified>();
  for (const row of rows) {
    if (!KINDS.has(row.kind as FieldKind)) continue;
    found.set(row.fingerprint, {
      kind: row.kind as FieldKind,
      ...(row.topic ? { topic: row.topic as Topic } : {}),
      ...(row.self_id_key ? { key: row.self_id_key as SelfIdKey } : {}),
      ...(row.slot ? { slot: row.slot as Slot } : {}),
      by: "cache",
    });
  }
  return found;
}

/** Write one verdict down. Exported for the same reason as `cached`. */
export async function remember(asked: Asked, verdict: Classified): Promise<void> {
  await run(
    `INSERT INTO field_classifications
            (fingerprint, label, section, kind, topic, self_id_key, slot, model, rules, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (fingerprint) DO UPDATE SET
          kind = excluded.kind, topic = excluded.topic,
          self_id_key = excluded.self_id_key, slot = excluded.slot,
          model = excluded.model, rules = excluded.rules, at = excluded.at`,
    fingerprint(asked),
    asked.label,
    asked.section ?? null,
    verdict.kind,
    verdict.topic ?? null,
    verdict.key ?? null,
    verdict.slot ?? null,
    CLASSIFY_MODEL,
    RULES,
  );
}

/**
 * Throw away what has expired.
 *
 * Rows that no read will trust again, so they are nothing but a database
 * that grows. Run when a form is classified, which is the only thing that
 * writes here.
 */
export async function forget(): Promise<void> {
  await run(
    `DELETE FROM field_classifications WHERE at <= datetime('now', ?)`,
    `-${Math.max(1, TRUST_DAYS)} days`,
  );
}

/** One call, every unseen question in it. A form is one round trip or none. */
async function ask(
  questions: Asked[],
  env: Record<string, string>,
): Promise<Map<number, Classified>> {
  const listed = questions
    .map((asked, index) =>
      [
        `[${index}]`,
        asked.section ? `section: ${asked.section}` : "section: (none)",
        `label: ${asked.label}`,
        asked.required === undefined ? "" : `required: ${asked.required}`,
        asked.options && asked.options.length > 0
          ? `choices: ${asked.options.slice(0, 12).join(" | ")}${asked.options.length > 12 ? " | …" : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("\n  "),
    )
    .join("\n\n");

  let text = "";
  for await (const message of query({
    prompt: `FIELDS\n\n${listed}`,
    options: {
      model: CLASSIFY_MODEL,
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
      throw new Error(`classification stopped: ${message.subtype}`);
    }
  }

  const replies = parseReply(text);
  if (!replies) throw new Error("the classification reply could not be read");

  const verdicts = new Map<number, Classified>();
  for (const reply of replies) {
    const index = typeof reply.i === "number" ? reply.i : -1;
    if (index < 0 || index >= questions.length) continue;
    const kind = reply.kind as FieldKind;
    if (!KINDS.has(kind)) continue;

    const topic =
      kind === "standing" && reply.topic && (TOPICS as readonly string[]).includes(reply.topic)
        ? (reply.topic as Topic)
        : undefined;
    const key =
      kind === "eeo" && reply.key && (SELF_ID_KEYS as readonly string[]).includes(reply.key)
        ? (reply.key as SelfIdKey)
        : undefined;
    const slot =
      (kind === "identity" || kind === "link") &&
      reply.slot &&
      (SLOTS as readonly string[]).includes(reply.slot)
        ? (reply.slot as Slot)
        : undefined;

    verdicts.set(index, {
      kind,
      ...(topic ? { topic } : {}),
      ...(key ? { key } : {}),
      ...(slot ? { slot } : {}),
      by: "model",
    });
  }
  return verdicts;
}

/**
 * Classify a form's questions, by label.
 *
 * Never throws. A form that cannot be classified by the model is classified
 * by its words, because the alternative is refusing to read an application.
 */
export async function classifyAsked(questions: Asked[]): Promise<Map<string, Classified>> {
  const verdicts = new Map<string, Classified>();
  if (questions.length === 0) return verdicts;

  const seen = await cached(questions.map(fingerprint));
  const unseen: { asked: Asked; at: number }[] = [];

  questions.forEach((asked, at) => {
    const hit = seen.get(fingerprint(asked));
    if (hit) verdicts.set(asked.label, hit);
    else unseen.push({ asked, at });
  });

  if (unseen.length === 0) return verdicts;

  await forget();

  const credential = await readCredential();
  if (!credential) {
    for (const { asked } of unseen) verdicts.set(asked.label, classifyByWords(asked));
    return verdicts;
  }

  try {
    const fresh = await ask(
      unseen.map((entry) => entry.asked),
      credentialEnv(credential),
    );
    for (const [index, { asked }] of unseen.entries()) {
      const verdict = fresh.get(index) ?? classifyByWords(asked);
      verdicts.set(asked.label, verdict);
      if (verdict.by === "model") await remember(asked, verdict);
    }
  } catch (error) {
    console.log(
      `[apply] classifying the form fell back to keywords: ${error instanceof Error ? error.message : String(error)}`,
    );
    for (const { asked } of unseen) verdicts.set(asked.label, classifyByWords(asked));
  }

  return verdicts;
}

/**
 * Classify a parsed form in place.
 *
 * The parsers assign a kind by words as they read, because they are pure
 * functions tested against saved pages. This is the pass that reads what
 * they found and corrects it.
 */
export async function classifyForm(fields: FormField[]): Promise<FormField[]> {
  const verdicts = await classifyAsked(
    fields.map((field) => ({
      label: field.label,
      ...(field.section ? { section: field.section } : {}),
      ...(field.options ? { options: field.options } : {}),
      required: field.required,
    })),
  );

  return fields.map((field) => {
    const verdict = verdicts.get(field.label);
    return verdict ? { ...field, kind: verdict.kind } : field;
  });
}

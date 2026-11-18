/**
 * What an application asks for, in one shape across the three boards.
 *
 * Read before anything is filled, and without a browser. All three publish
 * their form: greenhouse embeds it in the posting page, lever serves it as
 * ordinary HTML at /apply, ashby answers a GraphQL query. So "what will this
 * application ask me?" is a question with a cheap, exact answer — askable for
 * a whole shortlist before a single tab is opened.
 *
 * Nothing here fills anything in. This file reads.
 */

export type FieldType =
  | "text"
  | "email"
  | "phone"
  | "textarea"
  | "file"
  | "select"
  | "boolean"
  | "unknown";

/**
 * Who answers a field.
 *
 * The kind decides what may happen to it later, so the classification is a
 * safety boundary and not a convenience:
 *
 *   identity  the profile already knows it
 *   document  a resume or a letter, which this app produces
 *   link      a profile URL, also from the profile
 *   standing  the same answer at every company, and legally significant:
 *             work authorization, sponsorship, relocation, notice, pay.
 *             Answered once by the person and copied, never inferred.
 *   eeo       voluntary self-identification. Never answered by the agent,
 *             never inferred from a name or a history, and filled only from
 *             what the person typed about themselves.
 *   consent   a tick giving the company permission for something, usually
 *             marketing. Never ticked by anything but the person, and never
 *             put on a list of things they have left to do: not ticking it
 *             is the answer, and an app that asked about every one of these
 *             would be carrying a company's marketing request for it.
 *   custom    this employer's own question, drafted and then reviewed.
 */
export type FieldKind =
  | "identity"
  | "document"
  | "link"
  | "standing"
  | "eeo"
  | "consent"
  | "custom";

export interface FormField {
  label: string;
  type: FieldType;
  required: boolean;
  kind: FieldKind;
  /** What the form will accept, when it says. */
  options?: string[];
  /** The board's own handle for the field, for the step that fills it. */
  ref?: string;
  /**
   * The heading the field sits under, when the form has one.
   *
   * It is part of the question. "What is your location?" is a contact
   * detail at the top of a form and a demographic disclosure under the
   * heading "Demographic Survey", and the words of the label cannot tell
   * the two apart.
   */
  section?: string;
}

export interface ApplicationForm {
  ats: string;
  /** Where the form is. */
  url: string;
  fields: FormField[];
}

/*
  Classification is by label, because a label is the only thing all three
  boards agree on. It is a heuristic, and it is built to fail safe: a field
  that might be self-identification is called eeo, and a field nobody
  recognises is called custom, which is the kind that always goes to the
  person. Being wrong the other way — calling a self-identification question
  custom, and letting something answer it — is the failure worth designing
  against.
*/
/*
  Each entry is a stem with a leading word boundary and no trailing one.
  The first version closed every alternation with \b and so matched almost
  nothing it was written for: \bauthoriz\b cannot match "authorized", and
  neither could ethnic match "ethnicity" nor disabilit match "disability".
  Every one of those silently fell through to custom — the kind that gets
  answered. Stems match forward; the few terms that need an exact ending
  keep their own boundary.
*/
/*
  The situation questions, and what each one is about.

  These live here, beside the classification, because they are the same
  judgement: a field is a standing answer exactly when it is about one of
  these topics. Keeping two lists meant they drifted — "Current company" was
  a topic the store knew and the classifier did not, so the answer was there
  and the field was never matched to it.

  The order matters and is load-bearing. Almost every sponsorship question
  mentions authorisation — "sponsorship to retain or extend your work
  authorization" — and the two have opposite meanings, so sponsorship is
  tried first.
*/
export const TOPICS = [
  "sponsorship",
  "work_authorization",
  "relocation",
  "onsite",
  "notice_period",
  "start_date",
  "salary",
  "current_company",
] as const;

export type Topic = (typeof TOPICS)[number] | "other";

/** What the app calls each one when it asks. */
export const TOPIC_QUESTIONS: Record<(typeof TOPICS)[number], string> = {
  sponsorship: "Will you need visa sponsorship, now or later?",
  work_authorization: "Are you legally authorised to work where the job is?",
  relocation: "Are you willing to relocate?",
  onsite: "How many days a week can you be in an office?",
  notice_period: "What notice do you have to give?",
  start_date: "When could you start?",
  salary: "What are you looking for in pay?",
  current_company: "Where do you work now?",
};

const TOPIC_PATTERNS: [(typeof TOPICS)[number], RegExp][] = [
  ["sponsorship", /\b(?:sponsor|visa)/i],
  ["work_authorization", /\b(?:authoriz|authoris|right to work|work permit|eligible to work)/i],
  ["relocation", /\brelocat|willing to move/i],
  [
    "onsite",
    /\b(?:in[-\s]?person|in[-\s]?(?:an\s)?office|on[-\s]?site|hybrid|days? (?:a|per) week)/i,
  ],
  ["notice_period", /\bnotice\b/i],
  ["start_date", /\b(?:start date|available to start|when (?:could|can) you start|earliest start)/i],
  ["salary", /\b(?:salar|compensation|desired pay|pay expectation|looking for in pay)/i],
  ["current_company", /\b(?:current (?:company|employer)|present employer|where do you work)/i],
];

/** Which situation question a field is asking, if it is one. */
export function topicOf(label: string): Topic {
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(label)) return topic;
  }
  return "other";
}

/*
  Self-identification is tested before anything else and on its own, because
  being wrong about it is the expensive direction: a question about someone's
  disability or race treated as the employer's own is a question something
  will answer.
*/
const EEO =
  /\b(?:gender|sex\b|race\b|racial|ethnic|hispanic|latin|veteran|disabilit|self[-\s]?identif|eeoc?\b|protected (?:class|veteran)|pronoun)/i;

/*
  A heading that makes everything under it voluntary.

  Boards put the equal-opportunity questions in a section of their own and
  say so at the top of it. That heading carries information no label does:
  Lever's demographic survey opens by asking for a country, and read on its
  own "What is your location?" is indistinguishable from the contact field
  of the same name twenty lines above. One was filled from the profile.

  So the section is read, and a field inside a voluntary one is voluntary
  whatever its label says. The cost of being wrong here is a field left
  blank and reported as left blank, which is the direction this file has
  always failed in.
*/
const VOLUNTARY_SECTION =
  /\b(?:demographic|voluntary|self[-\s]?identif|equal (?:employment )?opportunit|eeoc?\b|diversity|protected veteran)/i;

/** Is this heading the top of a voluntary section? */
export function isVoluntarySection(section: string | undefined): boolean {
  return section !== undefined && VOLUNTARY_SECTION.test(section);
}

const PATTERNS: [FieldKind, RegExp][] = [
  [
    "consent",
    /\b(?:consent|opt[-\s]?in|marketing email|subscribe|keep me informed|future (?:roles|opportunities))/i,
  ],
  [
    "document",
    /\b(?:resum|résum|cv\b|cover letter|portfolio file|transcript|writing sample)/i,
  ],
  [
    "link",
    /\b(?:linkedin|github|gitlab|website|portfolio|personal site|twitter|url\b|blog\b|google scholar)/i,
  ],
  [
    "identity",
    /\b(?:first name|last name|given name|family name|full name|preferred name|^name$|e-?mail|phone|mobile|telephone|location|city\b|address|postcode|zip\b|country)/i,
  ],
];

/**
 * What a field is, judged from its words alone.
 *
 * This used to be the classification. It is now the fallback: apply/classify.ts
 * reads the form with a model, because what a question means is not a
 * property of the characters in its label — "What is your location?" is a
 * contact field in one section of a form and a demographic disclosure in
 * another, and no pattern over that string can know which.
 *
 * It is kept, and kept working, for the case where there is no credential or
 * the call fails. An app that cannot classify a form cannot fill one in, and
 * filling one slightly worse beats that. The patterns below therefore still
 * fail safe: anything that might be self-identification is eeo, and anything
 * unrecognised is custom, which is the kind that goes to the person.
 */
export function byWords(label: string, section?: string): FieldKind {
  const text = label.trim();

  // The heading first, because it outranks the label: see VOLUNTARY_SECTION.
  if (isVoluntarySection(section)) return "eeo";

  if (EEO.test(text)) return "eeo";

  /*
    Then the situation questions, before the rest.

    A field is a standing answer exactly when it asks about one of the topics
    above — one list, so the two cannot disagree. It has to be tested before
    the identity patterns: "are you legally authorized to work in the country
    where the job is located" contains the word country, and matching that
    first made a question about someone's right to work look like a question
    about their address.
  */
  if (topicOf(text) !== "other") return "standing";

  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return "custom";
}

/** A short account of what the application needs, for a person or an agent. */
export function describe(form: ApplicationForm): string {
  const required = form.fields.filter((field) => field.required);
  const of = (kind: FieldKind) => form.fields.filter((field) => field.kind === kind);

  const parts: string[] = [
    `${form.fields.length} fields, ${required.length} required, on ${form.ats}.`,
  ];

  const documents = of("document").map((field) => field.label);
  if (documents.length > 0) parts.push(`Wants: ${documents.join(", ")}.`);

  const standing = of("standing");
  if (standing.length > 0) {
    parts.push(
      `Asks ${standing.length} thing${standing.length === 1 ? "" : "s"} about your situation: ` +
        `${standing.map((field) => field.label).join(" / ")}.`,
    );
  }

  const custom = of("custom");
  if (custom.length > 0) {
    parts.push(
      `${custom.length} question${custom.length === 1 ? "" : "s"} of their own: ` +
        `${custom.map((field) => field.label).join(" / ")}.`,
    );
  }

  const consents = of("consent");
  if (consents.length > 0) {
    parts.push(
      `${consents.length} consent tick${consents.length === 1 ? "" : "s"}, left alone unless you ask.`,
    );
  }

  const eeo = of("eeo");
  if (eeo.length > 0) {
    parts.push(
      `${eeo.length} voluntary self-identification field${eeo.length === 1 ? "" : "s"}, ` +
        "which are yours alone and are never answered from anything but what you have stored.",
    );
  }

  return parts.join(" ");
}

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
 *   custom    this employer's own question, drafted and then reviewed.
 */
export type FieldKind = "identity" | "document" | "link" | "standing" | "eeo" | "custom";

export interface FormField {
  label: string;
  type: FieldType;
  required: boolean;
  kind: FieldKind;
  /** What the form will accept, when it says. */
  options?: string[];
  /** The board's own handle for the field, for the step that fills it. */
  ref?: string;
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
const PATTERNS: [FieldKind, RegExp][] = [
  [
    "eeo",
    /\b(?:gender|sex\b|race\b|racial|ethnic|hispanic|latin|veteran|disabilit|self[-\s]?identif|eeoc?\b|protected (?:class|veteran)|pronoun)/i,
  ],
  [
    "standing",
    /\b(?:authoriz|authoris|sponsor|visa\b|work permit|right to work|relocat|willing to (?:move|travel)|notice period|start date|available to start|salar|compensation|desired pay|in[-\s]?person|in[-\s]?office|hybrid|on[-\s]?site|days? (?:a|per) week)/i,
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

export function classify(label: string): FieldKind {
  const text = label.trim();
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

  const eeo = of("eeo");
  if (eeo.length > 0) {
    parts.push(
      `${eeo.length} voluntary self-identification field${eeo.length === 1 ? "" : "s"}, ` +
        "which are yours alone and are never answered from anything but what you have stored.",
    );
  }

  return parts.join(" ");
}

import { classify, type ApplicationForm, type FieldType, type FormField } from "./form.js";

/**
 * Reading each board's published form.
 *
 * One parser per board, and each one takes text rather than fetching, so
 * every shape here is tested against a saved copy of a real posting instead
 * of against the network. A board that changes its markup then fails a test
 * rather than quietly returning an empty form — which, in a thing that fills
 * in applications, is the failure that matters.
 */

/* ---------------------------------------------------------------- greenhouse

  The posting page carries the whole form as JSON: a "questions" array of
  { label, required, fields: [{ type, name, values }] }. Nothing is rendered
  until the browser runs, so reading the HTML as markup finds no inputs at
  all — the first attempt at this found zero fields on a form with fifteen.
*/

interface GreenhouseField {
  type?: string;
  name?: string;
  values?: { label?: string; value?: unknown }[];
}

interface GreenhouseQuestion {
  label?: string;
  required?: boolean;
  fields?: GreenhouseField[];
}

const GREENHOUSE_TYPES: Record<string, FieldType> = {
  input_text: "text",
  input_file: "file",
  textarea: "textarea",
  multi_value_single_select: "select",
  multi_value_multi_select: "select",
  input_hidden: "unknown",
};

export function parseGreenhouse(html: string, url: string): ApplicationForm {
  const questions = extractJsonArray(html, '"questions"') as GreenhouseQuestion[] | null;
  if (!questions) {
    throw new Error("No question list found in the greenhouse posting page.");
  }

  const fields: FormField[] = [];
  for (const question of questions) {
    const label = (question.label ?? "").trim();
    if (!label) continue;
    const first = question.fields?.[0];
    const options = first?.values
      ?.map((value) => (value.label ?? "").trim())
      .filter((value) => value.length > 0);

    fields.push({
      label,
      type: GREENHOUSE_TYPES[first?.type ?? ""] ?? "text",
      required: question.required === true,
      kind: classify(label),
      ...(options && options.length > 0 ? { options } : {}),
      ...(first?.name ? { ref: first.name } : {}),
    });
  }

  return { ats: "greenhouse", url, fields };
}

/**
 * Pull one JSON array out of a page, balancing brackets.
 *
 * A regular expression cannot do this: the array holds objects holding
 * arrays, and any pattern that stops at the first "]" stops in the middle of
 * the first question. Quotes and escapes are tracked so a "]" inside a label
 * does not end it either.
 */
function extractJsonArray(text: string, key: string): unknown[] | null {
  const at = text.indexOf(key);
  if (at < 0) return null;
  const open = text.indexOf("[", at);
  if (open < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(open, i + 1)) as unknown[];
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/* --------------------------------------------------------------------- lever

  Lever serves the form as ordinary HTML at <posting>/apply, so this reads
  the markup. Names carry the structure: urls[LinkedIn], cards[<uuid>][field0]
  for the employer's own questions, surveysResponses[<uuid>] for EEO.
*/

const LEVER_SKIP = /^(baseTemplate|surveyId|selectedLocation|_|utm|ref$)/i;

/*
  A lever question is not its input.

  The employer's own questions and the self-identification survey arrive as
  one hidden input per group, carrying the whole group as HTML-escaped JSON
  in its value; the visible inputs beside it are named
  cards[<uuid>][field0] and surveysResponses[<uuid>][responses][0] and carry
  no text at all. Read as markup, that is what they look like — and the
  first version of this parser reported a company's entire diversity survey
  as nine unlabelled "custom" questions, which is the one classification
  that invites something to answer them.

  So the templates are read, and the inputs they stand for are skipped.
*/
const LEVER_TEMPLATE = /<input[^>]*name="((?:cards|surveysResponses)\[[^\]]+\]\[baseTemplate\])"[^>]*>/gi;
const LEVER_FROM_TEMPLATE = /^(cards|surveysResponses)\[/i;

interface LeverTemplate {
  text?: string;
  fields?: {
    type?: string;
    text?: string;
    required?: boolean;
    options?: { text?: string }[];
  }[];
}

const LEVER_FIELD_TYPES: Record<string, FieldType> = {
  "multiple-choice": "select",
  "multiple-select": "select",
  text: "text",
  textarea: "textarea",
  "text-area": "textarea",
  file: "file",
  date: "text",
  dropdown: "select",
};

function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The questions a lever form asks through its card and survey templates. */
function leverTemplateFields(html: string): FormField[] {
  const fields: FormField[] = [];
  let found: RegExpExecArray | null;

  LEVER_TEMPLATE.lastIndex = 0;
  while ((found = LEVER_TEMPLATE.exec(html)) !== null) {
    const value = attribute(found[0] ?? "", "value");
    if (!value) continue;

    let template: LeverTemplate;
    try {
      template = JSON.parse(unescapeHtml(value)) as LeverTemplate;
    } catch {
      continue; // A template we cannot read is not a question we can report.
    }

    for (const field of template.fields ?? []) {
      const label = (field.text ?? "").trim();
      if (!label) continue;
      const options = field.options
        ?.map((option) => (option.text ?? "").trim())
        .filter((option) => option.length > 0);

      fields.push({
        label,
        type: LEVER_FIELD_TYPES[field.type ?? ""] ?? "text",
        required: field.required === true,
        kind: classify(label),
        ...(options && options.length > 0 ? { options } : {}),
        ref: found[1],
      });
    }
  }

  return fields;
}

export function parseLever(html: string, url: string): ApplicationForm {
  const fields: FormField[] = leverTemplateFields(html);
  const seen = new Set<string>();

  const INPUT = /<(input|select|textarea)\b([^>]*)>/gi;
  let found: RegExpExecArray | null;

  while ((found = INPUT.exec(html)) !== null) {
    const tag = found[1]!.toLowerCase();
    const attributes = found[2] ?? "";
    const name = attribute(attributes, "name");
    if (!name || LEVER_SKIP.test(name.split("[").pop() ?? name)) continue;
    // Already reported, with its real wording, from its template.
    if (LEVER_FROM_TEMPLATE.test(name)) continue;

    const inputType = (attribute(attributes, "type") ?? "").toLowerCase();
    if (inputType === "hidden") continue;

    /*
      Radios and checkboxes repeat the same name once per option, so the
      field is created on first sight and later rows only add their option.
    */
    const label = leverLabel(html, name, attributes);
    if (seen.has(name)) {
      const existing = fields.find((field) => field.ref === name);
      const option = attribute(attributes, "value");
      if (existing && option) existing.options = [...(existing.options ?? []), option];
      continue;
    }
    seen.add(name);

    const type: FieldType =
      tag === "textarea"
        ? "textarea"
        : tag === "select"
          ? "select"
          : inputType === "file"
            ? "file"
            : inputType === "email"
              ? "email"
              : inputType === "radio" || inputType === "checkbox"
                ? "select"
                : name === "phone"
                  ? "phone"
                  : "text";

    const option = attribute(attributes, "value");
    fields.push({
      label,
      type,
      required: /\brequired\b/i.test(attributes),
      kind: classify(label),
      ...(option && (inputType === "radio" || inputType === "checkbox")
        ? { options: [option] }
        : {}),
      ref: name,
    });
  }

  return { ats: "lever", url, fields };
}

/**
 * What a lever field is called, to a person.
 *
 * The name is a path, not a sentence — cards[9f..][field0] says nothing — so
 * the page is searched backwards from the input for the nearest preceding
 * label or heading. Where there is none the path is used, because a field
 * reported under an ugly name is still reported; a field dropped for want of
 * a label is a question nobody knows was asked.
 */
function leverLabel(html: string, name: string, attributes: string): string {
  const aria = attribute(attributes, "aria-label");
  if (aria) return aria;

  /*
    Each question is one <li class="application-question"> holding its own
    label, so the label is found by walking back to the start of that block
    and taking the first one inside it. The first attempt searched backwards
    for the nearest label of any sort and matched the class name exactly,
    which missed "application-label multiple-select" and so gave the pronouns
    group the name field's label — a self-identification question wearing the
    label "Full name", which is the one mistake this classification must not
    make.
  */
  const at = html.indexOf(`name="${name}"`);
  if (at > 0) {
    const start = html.lastIndexOf("application-question", at);
    const block = html.slice(start > 0 ? start : Math.max(0, at - 1200), at);
    const found = [
      ...block.matchAll(/class="[^"]*application-label[^"]*"[^>]*>([^<]{2,160})</gi),
    ].at(-1)?.[1];
    if (found) return tidy(found);

    const plain = [...block.matchAll(/<label[^>]*>\s*([^<]{2,160})</gi)].at(-1)?.[1];
    if (plain) return tidy(plain);
  }

  const leaf = /urls\[(.+?)\]/.exec(name);
  if (leaf?.[1]) return leaf[1];

  /*
    A consent tick is nobody's to give but the person's, and it arrives with
    no label of its own. Named rather than left as "consent[marketing]", so
    it reads as what it is when the form is shown to them.
  */
  const consent = /consent\[(.+?)\]/.exec(name);
  if (consent?.[1]) return `Consent: ${consent[1]}`;

  return name;
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\s*✱\s*$/, "").trim();
}

function attribute(attributes: string, key: string): string | null {
  const found = new RegExp(`${key}="([^"]*)"`, "i").exec(attributes);
  return found?.[1]?.trim() || null;
}

/* --------------------------------------------------------------------- ashby

  Ashby answers a GraphQL query with the form already typed: each entry has a
  title, an isRequired flag, and a field type out of a fixed set. No scraping,
  and no guessing what a control means.
*/

const ASHBY_TYPES: Record<string, FieldType> = {
  String: "text",
  Email: "email",
  Phone: "phone",
  File: "file",
  Boolean: "select",
  LongText: "textarea",
  ValueSelect: "select",
  MultiValueSelect: "select",
  Number: "text",
  Date: "text",
  SocialLink: "text",
};

interface AshbyEntry {
  isRequired?: boolean;
  field?: {
    title?: string;
    type?: string;
    path?: string;
    selectableValues?: { label?: string }[];
  };
}

export function parseAshby(body: string, url: string): ApplicationForm {
  const payload = JSON.parse(body) as {
    data?: { jobPosting?: { applicationForm?: { sections?: { fieldEntries?: AshbyEntry[] }[] } } };
  };

  const sections = payload.data?.jobPosting?.applicationForm?.sections;
  if (!sections) throw new Error("No application form in the ashby response.");

  const fields: FormField[] = [];
  for (const section of sections) {
    for (const entry of section.fieldEntries ?? []) {
      const label = (entry.field?.title ?? "").trim();
      if (!label) continue;
      const options = entry.field?.selectableValues
        ?.map((value) => (value.label ?? "").trim())
        .filter(Boolean);

      fields.push({
        label,
        type: ASHBY_TYPES[entry.field?.type ?? ""] ?? "unknown",
        required: entry.isRequired === true,
        kind: classify(label),
        ...(options && options.length > 0 ? { options } : {}),
        ...(entry.field?.path ? { ref: entry.field.path } : {}),
      });
    }
  }

  return { ats: "ashby", url, fields };
}

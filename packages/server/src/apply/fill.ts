import fs from "node:fs";
import path from "node:path";
import { topicOf, type FieldKind } from "./form.js";
import {
  isTokenised,
  listStandingAnswers,
  readSelfIdentification,
  selfIdKeyOf,
  includedKeys,
  type StandingAnswer,
} from "./answers.js";
import { canChoose, standingOption, voluntaryOption } from "./choose.js";
import {
  classifyAsked,
  classifyByWords,
  type Asked,
  type Classified,
  type Slot,
} from "./classify.js";
import { callBrowser } from "../agent/browserClient.js";
import { BROWSER_FILES } from "../agent/browserServer.js";
import { openOnStage, withPane } from "../agent/split.js";
import { get } from "../db/client.js";
import { formForJob } from "./read.js";
import { pdfFilename, renderPdf } from "../layout/pdf.js";
import * as repo from "../repo.js";
import * as resumeStore from "../resume.js";
import { recordAnswers } from "./record.js";

/**
 * Turning a page into a list of things to type.
 *
 * Split in two on purpose. This half is a pure function from a Playwright
 * snapshot and a set of known answers to a list of fields and values, so it
 * can be tested against a saved page rather than against a company's live
 * application form. The other half does the typing.
 *
 * It is also where the promise about self-identification is kept. Those
 * values are matched to the form's own options here, in code: they are read
 * from the database, compared with the words the form offers, and handed to
 * the browser. They are never put in a prompt, never returned to the agent,
 * and the report says only that the section was filled.
 */

/** One line of a Playwright accessibility snapshot. */
export interface Control {
  role: string;
  name: string;
  /*
    What the browser tools call `target`: "exact target element reference
    from the page snapshot". It was named `ref` here, after the snapshot's own
    `[ref=e42]`, and the payload was built from the field names of this
    interface — so every fill went out with `ref` where the tool requires
    `target`, and was rejected whole. The tests asserted the same wrong name
    and passed. It is called `target` now, so the thing being built and the
    thing being sent cannot drift apart again.
  */
  target: string;
  /** For a radio or a checkbox, the group it belongs to. */
  group?: string;
  /**
   * The heading this control sits under.
   *
   * Part of the question, not decoration. A country list under "Demographic
   * Survey" is a demographic question and a country list at the top of the
   * form is an address, and the label is the same sentence in both.
   */
  section?: string;
}

/*
  Snapshot lines look like:

    - textbox "First Name" [ref=e42]
    - combobox "Are you legally authorized to work?" [ref=e51]
    - radio "Yes" [ref=e52]

  Indentation carries the nesting, which is how a radio finds the question
  it answers: the nearest less-indented line with a name.
*/
/*
  The ref is optional, and that is the whole subtlety.

  A radiogroup is often just a container — a name and some children, with no
  ref of its own, because there is nothing to click on it. Requiring a ref
  meant those lines were skipped, so the radios inside them looked up and
  found whatever named control came before: the radios for "are you legally
  authorized to work" were filed under "Attach Resume". A question read off
  the wrong line is an answer given to the wrong question.
*/
const LINE = /^(\s*)-\s+(\w[\w-]*)\s+"([^"]*)"([^\n]*)$/;
const REF = /\[ref=([^\]]+)\]/;

export function readSnapshot(snapshot: string): Control[] {
  const controls: Control[] = [];
  const stack: { indent: number; name: string }[] = [];
  /*
    The heading last passed, which is the section everything after it is in.
    Read the way a person reads the page: top to bottom, and a question
    belongs to the last heading above it.
  */
  let section: string | undefined;

  for (const raw of snapshot.split("\n")) {
    const found = LINE.exec(raw);
    if (!found) continue;
    const [, indent = "", role = "", name = "", rest = ""] = found;
    const depth = indent.length;
    const target = REF.exec(rest)?.[1];

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= depth) stack.pop();
    const group = stack.length > 0 ? stack[stack.length - 1]!.name : undefined;

    if (role === "heading" && name) section = name;

    // Everything named can be a question; only something with a ref can be
    // answered.
    controls.push({
      role,
      name,
      target: target ?? "",
      ...(group ? { group } : {}),
      ...(section ? { section } : {}),
    });
    if (name) stack.push({ indent: depth, name });
  }

  return controls;
}

/** What this app knows, ready to be matched to a page. */
export interface Known {
  profile: {
    name: string | null;
    email: string | null;
    phone: string | null;
    location: string | null;
    links: string[];
  };
  standing: { topic: string; answer: string }[];
  /** Read from the database and never shown to the agent. */
  selfId: Record<string, string>;
  /**
   * Which voluntary questions the person asked to have filled in here.
   *
   * Empty unless they said yes, question by question, for this employer.
   * Stored answers are not a standing instruction to disclose: declining is
   * a complete answer to every question in that section, and an app that
   * filled them because they were on file would be making that decision for
   * them, once per company, without saying so.
   *
   * A set rather than a flag, because the section is not one decision.
   * Pronouns and a disability status are different disclosures to the same
   * employer, and a single yes would answer for both. See
   * answers.includedKeys.
   */
  include: Set<string>;
}

export interface Filling {
  element: string;
  target: string;
  name: string;
  type: "textbox" | "checkbox" | "radio" | "combobox" | "slider";
  value: string;
  /** For the report. Self-identification values are never reported. */
  kind: FieldKind;
}

export interface Plan {
  fill: Filling[];
  /** Controls nothing here can answer, for the person or the agent. */
  leftAlone: { name: string; kind: FieldKind; why: string }[];
}

/*
  Which of the person's links is which, by the site it points at.

  This half stays in code, and deliberately: the slot — what the field is
  asking for — is a judgement about the employer's words and is made by the
  model, while recognising github.com in a URL is not a judgement at all.
  The person's links are not sent anywhere to be sorted.
*/
const LINK_HOSTS: Partial<Record<Slot, RegExp>> = {
  linkedin: /linkedin\.com/i,
  github: /github\.com|gitlab\.com/i,
  twitter: /twitter\.com|\bx\.com/i,
  scholar: /scholar\.google\./i,
};

/* A personal site is the one that is none of the above. */
const NAMED_HOST = /linkedin\.com|github\.com|gitlab\.com|twitter\.com|\bx\.com|scholar\.google\./i;

function linkFor(slot: Slot | undefined, links: string[]): string | undefined {
  if (!slot) return undefined;
  const host = LINK_HOSTS[slot];
  if (host) return links.find((link) => host.test(link));
  if (slot === "portfolio" || slot === "website" || slot === "other_link") {
    return links.find((link) => /^https?:/i.test(link) && !NAMED_HOST.test(link));
  }
  return undefined;
}

/**
 * The option a stored answer means, in the words this form uses.
 *
 * Forms word the same choice differently — "Yes" / "Yes, I am authorized" /
 * "I am legally authorized to work" — so the stored answer is matched to the
 * options offered rather than typed in. Nothing is chosen on a weak match:
 * an answer that is nearly right to a question about someone's right to work
 * is an answer that is wrong.
 */
export function chooseOption(stored: string, options: Control[]): Control | null {
  const want = stored.trim().toLowerCase();
  if (!want) return null;

  const exact = options.find((option) => option.name.trim().toLowerCase() === want);
  if (exact) return exact;

  const starts = options.filter((option) => {
    const text = option.name.trim().toLowerCase();
    return text.startsWith(want) || want.startsWith(text);
  });
  if (starts.length === 1) return starts[0]!;

  const holds = options.filter((option) => option.name.toLowerCase().includes(want));
  if (holds.length === 1) return holds[0]!;

  /*
    The other direction: an option named inside the stored answer.

    A country list asked "What is your location?" and the stored location was
    "New York, New York, United States". Every rule above looks for the
    stored answer inside an option, and no option contains that sentence, so
    nothing matched and the select was left to time out. The answer the
    person means is the option their answer names.

    Whole words only, and this is not fussiness: "Romania" contains "Oman",
    "Mali" contains "Mali" in "Somalia", and a plain substring test would
    put someone in the wrong country. The longest match wins, so "United
    States" is preferred over "India" in "…, United States of America", and
    a tie is no answer at all.
  */
  const named = options
    .map((option) => ({ option, text: option.name.trim().toLowerCase() }))
    .filter(({ text }) => text.length > 1 && new RegExp(`\\b${escape(text)}\\b`).test(want))
    .sort((a, b) => b.text.length - a.text.length);

  if (named.length === 1) return named[0]!.option;
  if (named.length > 1 && named[0]!.text.length > named[1]!.text.length) return named[0]!.option;

  return null;
}

/** A literal, safe to put in a pattern. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
  The label without the mark that means "required".

  Lever writes it into the accessible name, so the record read "Full name ✱" —
  the form's typography preserved as though it were part of the question.
*/
export function plainly(label: string): string {
  return label.replace(/\s*[✱*＊]\s*$/u, "").trim();
}

const CHOICES = new Set(["radio", "option", "checkbox"]);

/** The answers offered under one question. */
function optionsOf(controls: Control[], group: string): Control[] {
  return controls.filter((control) => control.group === group && CHOICES.has(control.role));
}

/*
  The roles a question can wear. A radio or an option is not in here: those
  are answers, reached through the group that asks the question. A checkbox
  is, because a consent is a checkbox and leaving it out meant it was neither
  ticked nor reported — the field simply vanished, which is worse than
  ticking it, since nobody can check what they were not told about.
*/
const ASKS = new Set(["textbox", "combobox", "radiogroup", "checkbox", "slider"]);

/**
 * The questions a page asks, in the order it asks them.
 *
 * Exported because two things need the same list and must not disagree about
 * it: the planner, and the classifier that is asked what each question means.
 *
 * A group of tick boxes becomes the one question it is, standing where its
 * first box stood, and its boxes become that question's options. A checkbox
 * counts as a question on its own, because a consent is a lone checkbox and
 * leaving checkboxes out made consents vanish from the report entirely. But
 * Lever asks pronouns as ten checkboxes under one label, and counting each as
 * a question told the person they had ten questions to answer — "He/him",
 * "She/her", "They/them" — each described as its own question needing an
 * answer written for this application. It is one question with ten answers.
 */
export function questionsOf(controls: Control[]): Control[] {
  const ticks = new Map<string, number>();
  for (const control of controls) {
    if (control.role !== "checkbox" || !control.group) continue;
    ticks.set(control.group, (ticks.get(control.group) ?? 0) + 1);
  }
  // Two or more tick boxes under one label is that shape. One is a consent,
  // and stays a question.
  const isChoiceOf = (control: Control) =>
    control.role === "checkbox" &&
    control.group !== undefined &&
    (ticks.get(control.group) ?? 0) > 1;

  const questions: Control[] = [];
  for (const control of controls) {
    if (isChoiceOf(control)) {
      const group = control.group ?? "";
      if (!questions.some((asked) => asked.name === group)) {
        questions.push({
          role: "radiogroup",
          name: group,
          target: "",
          ...(control.section ? { section: control.section } : {}),
        });
      }
      continue;
    }
    if (ASKS.has(control.role) && control.name) questions.push(control);
  }
  return questions;
}

/** The same questions, in the words the classifier is given. */
export function askedOf(controls: Control[]): Asked[] {
  return questionsOf(controls).map((control) => {
    const offered = optionsOf(controls, control.name).map((option) => option.name);
    return {
      label: plainly(control.name),
      ...(control.section ? { section: control.section } : {}),
      ...(offered.length > 0 ? { options: offered } : {}),
    };
  });
}

/**
 * What to type where.
 *
 * `kinds` is what the classifier made of each question, by label. Without it
 * every field falls back to its words, which is what the tests do and what
 * happens when there is no credential.
 *
 * `chosen` is the option a stored answer was read to mean, where the string
 * rules could not settle it — see resolveChoices below, and apply/choose.ts.
 * It is the form's own wording, so from here on it is treated exactly like a
 * stored answer that happened to match.
 */
export function planFill(
  controls: Control[],
  known: Known,
  kinds?: Map<string, Classified>,
  chosen?: Map<string, string>,
): Plan {
  const fill: Filling[] = [];
  const leftAlone: Plan["leftAlone"][number][] = [];
  const answered = new Set<string>();

  const byTopic = new Map(known.standing.map((row) => [row.topic, row.answer]));
  const [first = "", ...rest] = (known.profile.name ?? "").split(/\s+/);
  const last = rest.join(" ");

  const options = (group: string) => optionsOf(controls, group);

  const put = (control: Control, value: string, kind: FieldKind, asks?: string) => {
    if (!value || answered.has(control.target)) return;

    /*
      A list can only be given something on it.

      A select was handed the stored answer as written, and the browser then
      spent five seconds looking for an option by that name before timing
      out — the failure that cost a whole form fill. Radios have always been
      matched against what the page offers; a select is the same question
      wearing a different control, so it is matched the same way, and the
      value sent is the page's own wording.

      No clear match is left alone and said out loud. A list of countries is
      not a free text box, and guessing at one is how someone ends up
      declaring the wrong country to an employer.
    */
    if (control.role === "combobox") {
      const offered = options(control.name);
      if (offered.length > 0) {
        const choice = chooseOption(value, offered);
        if (!choice) {
          leftAlone.push({
            name: plainly(asks ?? control.name),
            kind,
            why:
              kind === "eeo"
                ? "What you have stored is not one of the choices this list offers. Left blank."
                : `Nothing in this list matches "${value}", so it is left for you.`,
          });
          return;
        }
        value = choice.name;
      }
    }

    answered.add(control.target);
    fill.push({
      element: control.name || control.role,
      target: control.target,
      name: plainly(asks ?? control.name ?? "") || control.role,
      type:
        control.role === "radio"
          ? "radio"
          : control.role === "checkbox"
            ? "checkbox"
            : control.role === "combobox"
              ? "combobox"
              : "textbox",
      value,
      kind,
    });
  };

  /*
    Give a stored answer to the control that takes it.

    A group of radios is answered by clicking one of them, so the option is
    found first and the option is what gets filled. A list is not: a combobox
    takes the chosen wording as its value, and `put` matches it to what the
    list offers. Handing `put` the <option> element instead — which is what
    this did — meant typing into something that cannot be typed into, so a
    stored answer to a question asked as a select was silently lost. It only
    ever showed up on radios, which is most forms, which is why it survived.
  */
  const resolve = (control: Control, stored: string, kind: FieldKind, whyNot: string) => {
    const label = control.name;
    /*
      What the model read the stored answer to mean, if it was asked. It is
      one of the options, word for word, so everything below treats it as a
      stored answer that happens to match exactly — there is no second path
      through here, and so no second way to be wrong.
    */
    const stands = chosen?.get(plainly(label)) ?? stored;
    if (control.role !== "radiogroup" && control.role !== "checkbox") {
      put(control, stands, kind, label);
      return;
    }
    const choice = chooseOption(stands, options(label));
    if (choice) put(choice, choice.name, kind, label);
    else leftAlone.push({ name: plainly(label), kind, why: whyNot });
  };

  const questions = questionsOf(controls);

  for (const control of questions) {
    const label = control.name;
    if (!label) continue;

    /*
      What the classifier made of this question, or its words if it was not
      asked. The lookup is by the plain label, which is the same string the
      classifier was given — the two must agree, or a question is planned as
      one kind and was judged as another.
    */
    const asks = plainly(label);
    const verdict =
      kinds?.get(asks) ??
      classifyByWords({ label: asks, ...(control.section ? { section: control.section } : {}) });
    const kind = verdict.kind;

    if (kind === "identity") {
      /*
        The slot, not the label.

        A pattern over the label read "Country" and "City" as the same
        question and answered both with the profile's location, so a form
        asking for a country was given "New York, NY" — which its list then
        refused, five seconds later. The profile holds a city; a field
        wanting a country or a postcode has nothing on file to answer it,
        and saying so is the correct outcome.
      */
      const value = ((): string => {
        switch (verdict.slot) {
          case "first_name":
            return first;
          case "last_name":
            return last;
          case "full_name":
          case "preferred_name":
            return known.profile.name ?? "";
          case "email":
            return known.profile.email ?? "";
          case "phone":
            return known.profile.phone ?? "";
          case "location":
          case "city":
          case "address":
            return known.profile.location ?? "";
          default:
            return "";
        }
      })();

      if (value) resolve(control, value, kind, `Nothing stored matches "${asks}".`);
      else {
        leftAlone.push({
          name: asks,
          kind,
          why: verdict.slot
            ? `The profile has nothing for ${verdict.slot.replace(/_/g, " ")}.`
            : "Nothing on file answers this one.",
        });
      }
      continue;
    }

    if (kind === "link") {
      const link = linkFor(verdict.slot, known.profile.links);
      if (link) put(control, link, kind);
      else {
        leftAlone.push({
          name: asks,
          kind,
          why: "No link on the profile answers this one.",
        });
      }
      continue;
    }

    if (kind === "standing") {
      const topic = verdict.topic ?? topicOf(label);
      const stored = topic === "other" ? undefined : byTopic.get(topic);
      if (!stored) {
        leftAlone.push({ name: label, kind, why: "No standing answer stored for this." });
        continue;
      }
      resolve(
        control,
        stored,
        kind,
        `Stored answer "${stored}" does not clearly match any option offered.`,
      );
      continue;
    }

    if (kind === "eeo") {
      /*
        Nothing in a voluntary section is touched unless the person asked for
        this question to be filled in, on this application. See
        Known.include.
      */
      const key = verdict.key ?? selfIdKeyOf(label);
      if (!key || !known.include.has(key)) {
        leftAlone.push({
          name: asks,
          kind,
          why: "Voluntary, and you have not asked for this one to be included here. Left blank.",
        });
        continue;
      }

      /*
        The one place these values are read. They go from the database to
        the browser; the plan records that the field was filled and never
        what with, and the agent is told a count and nothing else.
      */
      const stored = known.selfId[key];
      if (!stored) {
        leftAlone.push({ name: asks, kind, why: "Voluntary, and nothing stored. Left blank." });
        continue;
      }
      resolve(
        control,
        stored,
        kind,
        "What you have stored does not match the options this form offers. Left blank.",
      );
      continue;
    }

    leftAlone.push({
      name: plainly(label),
      kind,
      why:
        kind === "consent"
          ? "A consent. Never ticked by the app."
          : kind === "document"
            ? "A file, attached separately."
            : "Their own question — it needs an answer written for this application.",
    });
  }

  return { fill, leftAlone };
}

/**
 * What to tell the agent afterwards.
 *
 * Self-identification is counted, never named and never quoted. "Three
 * self-identification fields were filled from what you stored" is all the
 * agent needs and all it gets.
 */
export function reportOf(plan: Plan): {
  filled: { name: string; kind: FieldKind }[];
  self_identification_filled: number;
  left: Plan["leftAlone"];
  note: string;
} {
  const selfId = plan.fill.filter((field) => field.kind === "eeo");
  const rest = plan.fill.filter((field) => field.kind !== "eeo");

  return {
    filled: rest.map((field) => ({ name: field.name, kind: field.kind })),
    self_identification_filled: selfId.length,
    left: plan.leftAlone,
    note:
      (selfId.length > 0
        ? `${selfId.length} voluntary self-identification field${selfId.length === 1 ? "" : "s"} were filled from what the person stored; their values are not shown to you. `
        : "") +
      "Nothing has been sent. Say what is filled, what is left, and that they send it themselves.",
  };
}

/* ------------------------------------------------------------ doing it */

function text(result: { content?: { text?: string }[] }): string {
  return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

/** What the browser tool takes. Nothing else of a Filling goes over the wire. */
function wire(field: Filling): Record<string, string> {
  return {
    element: field.element,
    target: field.target,
    name: field.name,
    type: field.type,
    value: field.value,
  };
}

/**
 * A browser error, short enough to read.
 *
 * Playwright's failures carry a retry log thirty lines long. The first line
 * says what went wrong; the rest says it again with timings.
 */
function why(result: { content?: { text?: string }[] }): string {
  const lines = text(result)
    .split("\n")
    .map((line) => line.replace(/\u001b\[\d+m/g, "").trim())
    .filter((line) => line && !/^#/.test(line));
  return lines[0] ?? "The browser gave no reason.";
}

export interface Filled {
  filled: Filling[];
  failed: { field: Filling; why: string }[];
}

/**
 * Put the planned answers on the page, and keep what worked when one fails.
 *
 * The browser fills a batch in one call, which is one round trip and the
 * right thing when every field is ordinary. But a batch is all-or-nothing:
 * on a real Lever form a single control — the location box, a geocoded
 * typeahead with no options until it fetches them — threw, and the call
 * returned an error for the whole form.
 *
 * Two things were wrong with that. The fields before it had already been
 * typed onto the page, so the form was part-filled; and the error returned
 * before anything was recorded, so the app had no record of what it had just
 * put in front of an employer. A half-filled form nobody can account for is
 * precisely what the record exists to prevent.
 *
 * So a failed batch is retried one field at a time. Filling is idempotent —
 * the ones that worked are simply set to the same value again — and what
 * comes back is the truth about each one.
 */
async function fillFields(fields: Filling[]): Promise<Filled> {
  if (fields.length === 0) return { filled: [], failed: [] };

  const batch = await callBrowser("browser_fill_form", { fields: fields.map(wire) });
  if (batch.isError !== true) return { filled: fields, failed: [] };

  const filled: Filling[] = [];
  const failed: Filled["failed"] = [];
  for (const field of fields) {
    const one = await callBrowser("browser_fill_form", { fields: [wire(field)] });
    if (one.isError === true) failed.push({ field, why: why(one) });
    else filled.push(field);
  }
  return { filled, failed };
}

/**
 * Read the questions the string rules could not settle.
 *
 * One pass before the planning, so that planFill stays a pure function of a
 * page and a set of answers. What it returns is, per question, the option the
 * stored answer was read to mean — in the form's own words.
 *
 * The two routes differ in what is sent, and the difference is the point:
 * a standing answer goes out as the person wrote it, while a voluntary answer
 * never leaves this process. See apply/choose.ts.
 */
export async function resolveChoices(
  controls: Control[],
  known: Known,
  kinds: Map<string, Classified>,
): Promise<Map<string, string>> {
  const chosen = new Map<string, string>();
  const env = await canChoose();
  if (!env) return chosen;

  const byTopic = new Map(known.standing.map((row) => [row.topic, row.answer]));

  for (const control of questionsOf(controls)) {
    const asks = plainly(control.name);
    const verdict = kinds.get(asks);
    if (!verdict) continue;

    const offered = optionsOf(controls, control.name)
      .map((option) => option.name)
      .filter(Boolean);
    if (offered.length === 0) continue;

    try {
      if (verdict.kind === "eeo") {
        /*
          No string pre-check here, unlike the standing route below: what is
          stored is a token out of a fixed vocabulary and the form's wording
          is prose, so the rules would fail on nearly all of them. The
          translation is cached per option list, so asking is cheap.
        */
        if (!verdict.key || !known.include.has(verdict.key) || !isTokenised(verdict.key)) continue;
        const stored = known.selfId[verdict.key];
        if (!stored) continue;
        const option = await voluntaryOption(verdict.key, stored, asks, offered, env);
        if (option) chosen.set(asks, option);
        continue;
      }

      if (verdict.kind === "standing") {
        const topic = verdict.topic;
        const stored = topic && topic !== "other" ? byTopic.get(topic) : undefined;
        if (!stored) continue;
        // The string rules first: free, and they settle most of these.
        if (chooseOption(stored, optionsOf(controls, control.name))) continue;
        const option = await standingOption(stored, asks, offered, env);
        if (option) chosen.set(asks, option);
      }
    } catch (error) {
      /*
        One unreadable question is not a failed form. It falls through to the
        string rules, and is reported as left alone if those cannot settle it
        either.
      */
      console.log(
        `[apply] could not read the options for a ${verdict.kind} question: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return chosen;
}

/**
 * What could not be filled, said without naming a self-identification answer.
 *
 * The promise is that those values never reach the agent. A failure is still
 * a failure, so it is counted and described by its kind — never by its label,
 * which on these forms is the question itself.
 */
function failures(failed: Filled["failed"]): { name: string; why: string }[] {
  return failed.map((entry) => ({
    name: entry.field.kind === "eeo" ? "a voluntary self-identification question" : entry.field.name,
    why: entry.why,
  }));
}

async function knownAnswers(jobId: number): Promise<Known> {
  const [row, standing, selfId, include] = await Promise.all([
    get<{
      name: string | null;
      email: string | null;
      phone: string | null;
      location: string | null;
      links: string | null;
    }>(`SELECT name, email, phone, location, links FROM profile WHERE id = 1`),
    listStandingAnswers(),
    readSelfIdentification(),
    includedKeys(jobId),
  ]);

  let links: string[] = [];
  try {
    const parsed = JSON.parse(row?.links ?? "[]") as unknown;
    links = Array.isArray(parsed)
      ? parsed.map((link) => (typeof link === "string" ? link : String((link as { url?: string })?.url ?? "")))
      : [];
  } catch {
    links = [];
  }

  return {
    profile: {
      name: row?.name ?? null,
      email: row?.email ?? null,
      phone: row?.phone ?? null,
      location: row?.location ?? null,
      links: links.filter(Boolean),
    },
    standing: standing.map((answer: StandingAnswer) => ({
      topic: answer.topic,
      answer: answer.answer,
    })),
    selfId,
    include,
  };
}

/**
 * Fill in the application for a job, in the pane, and stop.
 *
 * The page is put in the pane rather than driven out of sight, because
 * watching a form fill itself in is the only way to know what it said before
 * it is sent. Nothing is submitted: see guard.ts, which refuses the button
 * rather than promising not to press it.
 */
export async function fillApplication(jobId: number): Promise<unknown> {
  const job = await repo.getJob(jobId);
  if (!job) throw new Error(`No job with id ${jobId}`);

  const form = await formForJob(jobId);

  /*
    What the arrangement answered, kept rather than dropped.

    This used to be `await openOnStage(...)` with the answer thrown away, so
    when the pane could not be made the only thing the person was told was
    "Nothing is open in the pane" — true, and no help at all: it names the
    symptom and hides the reason, which was sitting in the discarded reply.
  */
  const stage = await openOnStage(form.url);

  /*
    Everything from here on happens on the page in the pane, and the browser
    tools act on whichever tab is in view — which is the app. So the whole
    sequence goes inside withPane: read, fill, attach. Doing the read there
    and the fill outside it would type the person's details into the app.
  */
  const done = await withPane(async () => {
    const snapshot = text(await callBrowser("browser_snapshot", {}));
    const controls = readSnapshot(snapshot);
    if (controls.length === 0) {
      return {
        error:
          "Nothing could be read on that page. It may still be loading, or it may want a sign-in. Take a snapshot and look before trying again.",
      };
    }

    /*
      Read the page's questions, then ask what they mean.

      One call for the whole form, on the form's own words. Nothing the
      person stored is in it: see apply/classify.ts.
    */
    const kinds = await classifyAsked(askedOf(controls));
    const known = await knownAnswers(jobId);
    const plan = planFill(controls, known, kinds, await resolveChoices(controls, known, kinds));

    const outcome = await fillFields(plan.fill);

    /*
      Written down as it goes on, not afterwards: once the form is sent it is
      gone, and a record made from memory is the thing this exists to replace.

      What was actually filled, not what was planned. They differ whenever a
      control refuses, and recording the plan would make the record a
      statement of intent dressed as a statement of fact.
    */
    await recordAnswers(
      jobId,
      outcome.filled.map((entry) => ({ label: entry.name, kind: entry.kind, value: entry.value })),
    );

    return {
      url: form.url,
      ...reportOf({ ...plan, fill: outcome.filled }),
      ...(outcome.failed.length > 0
        ? {
            could_not_fill: failures(outcome.failed),
            and_so: "Tell the person about these by name; they have to put them in themselves.",
          }
        : {}),
      resume: await attachResume(jobId, controls),
    };
  });

  if (done !== null && typeof done === "object" && "error" in done) {
    return {
      error: `${(done as { error: string }).error}`,
      stage: `Asking for the page to be shown in the pane answered: ${stage}`,
      hint: "The pane is made by the extension in the person's own window. If it cannot be, nothing here can read or fill the form — ask them to open the posting from the app and say what they see.",
    };
  }
  return done;
}

/**
 * Attach the resume drafted for this application.
 *
 * Rendered to a file because that is what a file chooser takes, and into the
 * system temp directory because it is a copy of something the database
 * already holds — losing it costs a re-render.
 */
async function attachResume(
  jobId: number,
  controls: Control[],
): Promise<{ attached: boolean; note: string }> {
  const drafts = (await resumeStore.listResumes(jobId)) as { id: number; label: string | null }[];
  const draft = drafts[0];
  if (!draft) {
    return { attached: false, note: "No resume is drafted for this application yet." };
  }

  const control = controls.find(
    (candidate) =>
      /resume|cv|upload|attach|choose file/i.test(candidate.name) &&
      (candidate.role === "button" || candidate.role === "textbox" || candidate.role === "link"),
  );

  try {
    const pdf = await renderPdf({ resumeId: draft.id });
    const me = await get<{ name: string | null }>(`SELECT name FROM profile WHERE id = 1`);
    /*
      Into Playwright's own directory, not the system temp one.

      Playwright reads a file for an upload only from its allowed roots. A
      resume in /tmp meant the chooser opened and the upload was then
      refused — the last step of the last thing, failing on a path.
    */
    fs.mkdirSync(BROWSER_FILES, { recursive: true });
    const file = path.join(BROWSER_FILES, pdfFilename(me?.name ?? null, draft.label ?? undefined));
    fs.writeFileSync(file, pdf);

    const opened = await openFileChooser(control);
    const uploaded = await callBrowser("browser_file_upload", { paths: [file] });
    if (uploaded.isError === true) {
      return {
        attached: false,
        note: `The upload was refused after ${opened}: ${why(uploaded)}`,
      };
    }
    return { attached: true, note: `Attached resume #${draft.id}, by ${opened}.` };
  } catch (error) {
    return {
      attached: false,
      note: `The resume could not be attached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get a file chooser open, which is the only thing an upload can fill.
 *
 * The upload tool needs a file chooser the browser has already captured; with
 * none, it refuses. So the real question is what opens one, and on a real
 * form the obvious answer is wrong.
 *
 * Lever's resume field is `<input type="file" class="invisible-resume-upload"
 * tabindex="-1">` inside an anchor reading ATTACH RESUME/CV. The anchor is
 * what a person sees and what the accessibility tree offers, so that is what
 * this clicked — and clicking it opens nothing, because the chooser belongs
 * to the input. Hidden, unfocusable, and the only thing on the page that can
 * do the job.
 *
 * A hidden element cannot be clicked through the page, so it is clicked in
 * script instead. The visible control is kept as a second attempt: a form
 * that wires its button up properly is then still served, and one that puts a
 * real file input on the page is served first.
 */
async function openFileChooser(control: Control | undefined): Promise<string> {
  const pick = `() => {
    const inputs = [...document.querySelectorAll('input[type=file]')];
    if (inputs.length === 0) return "none";
    const wanted = inputs.find((input) =>
      /resume|cv/i.test((input.name || "") + " " + (input.id || "") + " " + (input.className || "")));
    (wanted ?? inputs[0]).click();
    return wanted ? "resume" : "first";
  }`;

  const clicked = await callBrowser("browser_evaluate", { function: pick });
  const answer = text(clicked);
  if (clicked.isError !== true && /"?(resume|first)"?/.test(answer)) {
    return answer.includes("resume")
      ? "clicking the page's own resume file input"
      : "clicking the only file input on the page";
  }

  if (control) {
    await callBrowser("browser_click", { element: control.name, target: control.target });
    return `clicking "${control.name}"`;
  }
  return "finding nothing on the page that opens a file chooser";
}

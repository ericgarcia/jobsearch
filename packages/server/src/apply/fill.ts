import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classify, topicOf, type FieldKind } from "./form.js";
import { listStandingAnswers, readSelfIdentification, selfIdKeyOf } from "./answers.js";
import { callBrowser } from "../agent/browserClient.js";
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

  for (const raw of snapshot.split("\n")) {
    const found = LINE.exec(raw);
    if (!found) continue;
    const [, indent = "", role = "", name = "", rest = ""] = found;
    const depth = indent.length;
    const target = REF.exec(rest)?.[1];

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= depth) stack.pop();
    const group = stack.length > 0 ? stack[stack.length - 1]!.name : undefined;

    // Everything named can be a question; only something with a ref can be
    // answered.
    controls.push({ role, name, target: target ?? "", ...(group ? { group } : {}) });
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

const FIRST = /\bfirst name|given name\b/i;
const LAST = /\blast name|family name|surname\b/i;
const LINK_HINTS: [RegExp, RegExp][] = [
  [/linkedin/i, /linkedin\.com/i],
  [/github/i, /github\.com/i],
  [/(?:website|portfolio|personal site|blog)/i, /^https?:/i],
];

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

  return null;
}

export function planFill(controls: Control[], known: Known): Plan {
  const fill: Filling[] = [];
  const leftAlone: Plan["leftAlone"][number][] = [];
  const answered = new Set<string>();

  const byTopic = new Map(known.standing.map((row) => [row.topic, row.answer]));
  const [first = "", ...rest] = (known.profile.name ?? "").split(/\s+/);
  const last = rest.join(" ");

  const options = (group: string) =>
    controls.filter(
      (control) => control.group === group && (control.role === "radio" || control.role === "option"),
    );

  const put = (control: Control, value: string, kind: FieldKind) => {
    if (!value || answered.has(control.target)) return;
    answered.add(control.target);
    fill.push({
      element: control.name || control.role,
      target: control.target,
      name: control.name || control.role,
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
    The roles a question can wear. A radio or an option is not in here: those
    are answers, reached through the group that asks the question. A checkbox
    is, because a consent is a checkbox and leaving it out meant it was
    neither ticked nor reported — the field simply vanished, which is worse
    than ticking it, since nobody can check what they were not told about.
  */
  const ASKS = new Set(["textbox", "combobox", "radiogroup", "checkbox", "slider"]);

  for (const control of controls) {
    if (!ASKS.has(control.role)) continue;
    const label = control.name;
    if (!label) continue;
    const kind = classify(label);

    if (kind === "identity") {
      if (FIRST.test(label)) put(control, first, kind);
      else if (LAST.test(label)) put(control, last, kind);
      else if (/\bname\b/i.test(label)) put(control, known.profile.name ?? "", kind);
      else if (/e-?mail/i.test(label)) put(control, known.profile.email ?? "", kind);
      else if (/phone|mobile|telephone/i.test(label)) put(control, known.profile.phone ?? "", kind);
      else if (/location|city|address|country/i.test(label))
        put(control, known.profile.location ?? "", kind);
      continue;
    }

    if (kind === "link") {
      for (const [asks, looks] of LINK_HINTS) {
        if (!asks.test(label)) continue;
        const match = known.profile.links.find((link) => looks.test(link));
        if (match) put(control, match, kind);
        break;
      }
      continue;
    }

    if (kind === "standing") {
      const topic = topicOf(label);
      const stored = topic === "other" ? undefined : byTopic.get(topic);
      if (!stored) {
        leftAlone.push({ name: label, kind, why: "No standing answer stored for this." });
        continue;
      }
      const choice = chooseOption(stored, options(label));
      if (choice) put(choice, choice.name, kind);
      else if (control.role === "textbox") put(control, stored, kind);
      else {
        leftAlone.push({
          name: label,
          kind,
          why: `Stored answer "${stored}" does not clearly match any option offered.`,
        });
      }
      continue;
    }

    if (kind === "eeo") {
      /*
        The one place these values are read. They go from the database to
        the browser; the plan records that the field was filled and never
        what with, and the agent is told a count and nothing else.
      */
      const key = selfIdKeyOf(label);
      const stored = key ? known.selfId[key] : undefined;
      if (!stored) {
        leftAlone.push({ name: label, kind, why: "Voluntary, and nothing stored. Left blank." });
        continue;
      }
      const choice = chooseOption(stored, options(label));
      if (choice) put(choice, choice.name, kind);
      else if (control.role === "textbox") put(control, stored, kind);
      else {
        leftAlone.push({
          name: label,
          kind,
          why: "What you have stored does not match the options this form offers. Left blank.",
        });
      }
      continue;
    }

    leftAlone.push({
      name: label,
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

async function knownAnswers(): Promise<Known> {
  const [row, standing, selfId] = await Promise.all([
    get<{
      name: string | null;
      email: string | null;
      phone: string | null;
      location: string | null;
      links: string | null;
    }>(`SELECT name, email, phone, location, links FROM profile WHERE id = 1`),
    listStandingAnswers(),
    readSelfIdentification(),
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
    standing: standing.map((answer) => ({ topic: answer.topic, answer: answer.answer })),
    selfId,
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

    const plan = planFill(controls, await knownAnswers());

    if (plan.fill.length > 0) {
      const filled = await callBrowser("browser_fill_form", {
        fields: plan.fill.map(({ element, target, name, type, value }) => ({
          element,
          target,
          name,
          type,
          value,
        })),
      });
      if (filled.isError === true) {
        return { error: `The form could not be filled: ${text(filled)}` };
      }
    }

    /*
      Written down as it goes on, not afterwards: once the form is sent it is
      gone, and a record made from memory is the thing this exists to replace.
    */
    await recordAnswers(
      jobId,
      plan.fill.map((entry) => ({ label: entry.name, kind: entry.kind, value: entry.value })),
    );

    return { url: form.url, ...reportOf(plan), resume: await attachResume(jobId, controls) };
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
  if (!control) {
    return {
      attached: false,
      note: "No upload control could be found on the page, so the resume is not attached. Say so.",
    };
  }

  try {
    const pdf = await renderPdf({ resumeId: draft.id });
    const me = await get<{ name: string | null }>(`SELECT name FROM profile WHERE id = 1`);
    const file = path.join(os.tmpdir(), pdfFilename(me?.name ?? null, draft.label ?? undefined));
    fs.writeFileSync(file, pdf);

    await callBrowser("browser_click", { element: control.name, target: control.target });
    const uploaded = await callBrowser("browser_file_upload", { paths: [file] });
    if (uploaded.isError === true) {
      return { attached: false, note: `The upload was refused: ${text(uploaded)}` };
    }
    return { attached: true, note: `Attached resume #${draft.id}.` };
  } catch (error) {
    return {
      attached: false,
      note: `The resume could not be attached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

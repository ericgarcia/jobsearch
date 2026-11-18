import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "./config.js";
import { all, get, run } from "./db/client.js";
import { changed } from "./notify.js";
import { credentialEnv, readCredential } from "./settings.js";
import { candidateFacts, getFact, listFacts, seedQuestions, setFact } from "./apply/facts.js";
import { isZip, list, readText } from "./zip.js";
import { vet, worthAsking } from "./apply/keep.js";
import * as profile from "./profile.js";

/**
 * Starting from what the person already has.
 *
 * Nobody fills in a profile. They have a resume, or a LinkedIn page, and
 * being asked to retype either into a form is the point at which they stop.
 * So the app reads one and proposes what it found.
 *
 * Proposes, and writes nothing. The profile is the one store in this app
 * with a rule about where its contents come from — a resume may only restate
 * a fact already in it, and nothing generated is written back — because every
 * resume this app produces is checked against it. An import is the one case
 * where that direction is reversed, and it is reversed only for the person's
 * own document, only through their review.
 *
 * Which is why the proposal is stored in a row rather than handed back to the
 * agent and returned on the way in. The agent writes prose for a living; a
 * bullet it tidied in passing would land in the profile as the person's own
 * words and be quoted back to an employer as fact. Applying an import copies
 * from the stored row, and the agent can accept or drop items by number and
 * nothing else.
 *
 * Three things are never proposed, whatever the document seems to say:
 *
 *   right to work, sponsorship, visa status   A US address does not mean
 *   someone may work in the US, and nothing in this app may decide that it
 *   does. Being wrong here misstates someone's legal position to an employer.
 *
 *   anything a voluntary survey asks   A resume can carry it — a membership,
 *   a service record, a graduation year. It is read past, not noted.
 *
 *   anything the document does not say   An inferred date is worse than no
 *   date, because nobody checks the one that looks right.
 */

export type ImportSource = "resume" | "linkedin" | "pasted";

export interface Proposed {
  profile: {
    name?: string;
    headline?: string;
    email?: string;
    phone?: string;
    location?: string;
    links?: string[];
  };
  roles: {
    company: string;
    title: string;
    location?: string;
    start_date?: string;
    end_date?: string;
    bullets: string[];
  }[];
  education: { school: string; degree?: string; field?: string; end_date?: string }[];
  skills: { name: string; years?: number }[];
  /** Answers the document states outright, for the fact store. */
  facts: { slug: string; question: string; answer: string }[];
  /** Read, and deliberately not asserted. Shown to the person, stored nowhere. */
  unsure: string[];
}

export interface Import {
  id: number;
  source: string;
  origin: string | null;
  at: string;
  applied_at: string | null;
  proposal: Proposed;
}

const INSTRUCTIONS = `
You are given a document somebody wrote about their own working life — a
resume, a LinkedIn profile, an export of one. Read it and report what it
says, as JSON.

Report only what the document states. This is the whole job. An invented date
or a guessed job title is worse than a missing one, because nobody checks the
field that looks already filled in.

- Copy bullets and descriptions word for word. Do not rewrite them, do not
  shorten them, do not improve them, do not merge two into one. They are the
  person's own sentences and they will be quoted to employers as such.
- A date the document does not give is omitted, not estimated. Keep the
  document's own form — "2019", "Mar 2019", "2019-03" — rather than
  normalising it.
- Anything you read but would not state as fact goes in "unsure", as a short
  line each. That list is shown to the person and stored nowhere.

Never report any of the following, however plainly the document seems to
show it:

- whether they may work in a country, whether they need sponsorship, or any
  visa or immigration status. An address is not a right to work, and a
  mistake here misstates someone's legal position to an employer. They type
  these themselves.
- gender, race, ethnicity, veteran or military status, disability, pronouns,
  transgender identity, sexual orientation, age or date of birth — including
  anything a membership, an award, a service record or a graduation year
  would imply. Read past it.
- a current or expected salary, unless the document states it as a plain
  figure.

"facts" is for answers the document states to questions an application form
would ask: a degree already held, a certification, a licence, a clearance,
where they work now, years with a named technology if the document says so.
Each one gets a short snake_case slug, the question as you would put it to
them in the second person, and the answer in the document's own words. Leave
the list empty rather than filling it with inferences.

You are given the questions this app already has names for, under QUESTIONS
ALREADY NAMED. If one of them is the same question, use its name exactly. A
second name for one question is worse than no name: the app would hold the
answer under one and go on asking for the other.

Reply with JSON only, in this shape, omitting what the document does not
give:

{"profile": {"name": "", "headline": "", "email": "", "phone": "",
 "location": "", "links": []},
 "roles": [{"company": "", "title": "", "location": "", "start_date": "",
 "end_date": "", "bullets": [""]}],
 "education": [{"school": "", "degree": "", "field": "", "end_date": ""}],
 "skills": [{"name": "", "years": 0}],
 "facts": [{"slug": "", "question": "", "answer": ""}],
 "unsure": [""]}
`.trim();

export const IMPORT_MODEL = process.env.JOBSEARCH_IMPORT_MODEL ?? "claude-opus-5-5";

/*
  The slugs that are never imported, whatever they are called.

  The prompt says so and this says so again, because the two failures are
  different. The prompt can be misread; this cannot, and the thing it guards
  is somebody's stated right to work in a country.
*/
const NEVER = /visa|sponsor|authoriz|authoris|immigration|right_to_work|work_permit|citizen/i;

/** Read as text, because they are text. */
const READABLE = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm", ".tsv"]);

/**
 * Handed over whole, because the model reads these better than any parser.
 *
 * A PDF goes up as a document and an image of a page goes up as an image.
 * There is no extractor in between and no file tool involved: the bytes are
 * a block in the message, exactly as the text would be.
 *
 * This is the second design. The first gave a scoped call the Read tool and
 * an allow-list of one path, which a probe showed does not hold — the SDK
 * auto-approves a tool named in allowedTools before the permission callback
 * is consulted, and with the name removed the callback still did not fire and
 * the model read a second file it was pointed at. Sending the bytes removes
 * the question rather than answering it: there is no tool to confine.
 */
const HANDED_OVER: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** The most a document may weigh, before base64 inflates it by a third. */
const HEAVIEST = 12_000_000;

/*
  The files in LinkedIn's own export that say anything about a career.

  Named, and in a useful order, because the archive holds far more than this —
  messages, invitations, ad preferences, every reaction — and none of that
  belongs in a prompt. Reading the whole zip would mean sending somebody's
  private correspondence to a model to find out where they went to school.
*/
const LINKEDIN = [
  "Profile.csv",
  "Positions.csv",
  "Education.csv",
  "Skills.csv",
  "Certifications.csv",
  "Languages.csv",
  "Projects.csv",
  "Publications.csv",
  "Honors.csv",
  "Courses.csv",
  "Patents.csv",
];

/* The archive nests its files one folder deep in some versions. */
const wantedInZip = (name: string): boolean => {
  const base = name.split("/").pop() ?? name;
  return LINKEDIN.some((file) => file.toLowerCase() === base.toLowerCase());
};

const joined = (files: { name: string; text: string }[]): string =>
  files.map((file) => `--- ${file.name}\n${file.text}`).join("\n\n").slice(0, MOST);

const MOST = 400_000;

/**
 * Get the text of something the person points at.
 *
 * A file, or the folder LinkedIn's export unzips into. A PDF is refused
 * rather than guessed at: there is no text extractor in this app, and a
 * resume read as mojibake would be proposed as the person's own words.
 */
export type Document =
  | { kind: "text"; text: string; source: ImportSource; origin: string }
  | { kind: "file"; bytes: Buffer; media: string; source: ImportSource; origin: string };

export function readSource(at: string): Document {
  const where = path.resolve(at.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (!fs.existsSync(where)) throw new Error(`Nothing at ${where}`);

  if (fs.statSync(where).isDirectory()) {
    const found = LINKEDIN.filter((name) => fs.existsSync(path.join(where, name)));
    if (found.length === 0) {
      throw new Error(
        `No LinkedIn export files in ${where}. Expected some of: ${LINKEDIN.join(", ")}. If it is still a zip, hand over the zip itself.`,
      );
    }
    const text = joined(
      found.map((name) => ({ name, text: fs.readFileSync(path.join(where, name), "utf8") })),
    );
    return { kind: "text", text, source: "linkedin", origin: where };
  }

  return documentFrom(path.basename(where), fs.readFileSync(where), where);
}

/**
 * What a file is, from its name and its bytes.
 *
 * Shared by the two ways a document arrives — a path this process reads, and
 * an upload the person dropped into the chat — so that both go through one
 * set of rules about what may be read and how large it may be.
 */
export function documentFrom(named: string, bytes: Buffer, origin = named): Document {
  const extension = path.extname(named).toLowerCase();
  const source: ImportSource = /linkedin|profile/i.test(named) ? "linkedin" : "resume";

  if (bytes.length === 0) throw new Error(`${named} is empty.`);
  if (bytes.length > HEAVIEST) {
    throw new Error(
      `${named} is ${Math.round(bytes.length / 1_000_000)}MB, which is too large to send. A profile or resume should be well under ${HEAVIEST / 1_000_000}MB.`,
    );
  }

  /*
    The archive as it arrives, rather than after they unzip it. Telling someone
    to unzip first is a small instruction and also exactly where people stop,
    which matters here because this route exists instead of reading their
    LinkedIn page for them — so it has to be no more work than that would have
    been.
  */
  if (extension === ".zip" || isZip(bytes)) {
    if (!isZip(bytes)) throw new Error(`${named} is named .zip but is not one.`);
    const inside = readText(bytes, wantedInZip);
    if (inside.length === 0) {
      const has = list(bytes)
        .map((entry) => entry.name.split("/").pop())
        .filter(Boolean)
        .slice(0, 12);
      throw new Error(
        `No LinkedIn career files in that archive. Expected some of: ${LINKEDIN.slice(0, 5).join(", ")}. It holds: ${has.join(", ")}${has.length === 12 ? ", …" : ""}`,
      );
    }
    return { kind: "text", text: joined(inside), source: "linkedin", origin };
  }

  const media = HANDED_OVER[extension];
  if (media) return { kind: "file", bytes, media, source, origin };

  if (extension === ".docx" || extension === ".doc" || extension === ".pages") {
    throw new Error(
      `${extension} files cannot be read here. Export it as a PDF, or open it and paste the text.`,
    );
  }
  if (!READABLE.has(extension)) {
    throw new Error(`Cannot read ${extension || "a file with no extension"}. Paste the text instead.`);
  }

  return { kind: "text", text: bytes.toString("utf8").slice(0, MOST), source, origin };
}

/* ------------------------------------------------------------- what they hand over */

/*
  Where a dropped file lands.

  Inside the data directory, which is outside the repository and readable only
  by this user. Kept rather than deleted, so a proposal can be read again and
  so they can see what was actually handed over; nothing else in the app looks
  in here.
*/
const UPLOADS = path.join(DATA_DIR, "uploads");

export interface Upload {
  id: string;
  name: string;
  size: number;
}

/** Strip a name down to something that cannot climb out of the folder. */
function safely(named: string): string {
  const base = path.basename(named).replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120);
  return base.replace(/^\.+/, "") || "document";
}

export function saveUpload(named: string, bytes: Buffer): Upload {
  if (bytes.length === 0) throw new Error("That file is empty.");
  if (bytes.length > HEAVIEST) {
    throw new Error(
      `That file is ${Math.round(bytes.length / 1_000_000)}MB, which is too large. A profile or resume should be well under ${HEAVIEST / 1_000_000}MB.`,
    );
  }
  fs.mkdirSync(UPLOADS, { recursive: true });
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const name = safely(named);
  fs.writeFileSync(path.join(UPLOADS, `${id}__${name}`), bytes, { mode: 0o600 });
  return { id, name, size: bytes.length };
}

/**
 * The document behind an upload id.
 *
 * The id is matched against the folder's own listing rather than being joined
 * into a path, so nothing a caller sends can name a file outside it. This is
 * the only way the agent reaches a file at all: it has no filesystem, and
 * import_profile takes an id from something the person handed over rather
 * than a path it chose.
 */
export function documentForUpload(id: string): Document {
  if (!/^[a-z0-9]+-[a-f0-9]+$/i.test(id)) throw new Error(`No file was handed over with id ${id}.`);
  const found = fs.existsSync(UPLOADS)
    ? fs.readdirSync(UPLOADS).find((entry) => entry.startsWith(`${id}__`))
    : undefined;
  if (!found) throw new Error(`No file was handed over with id ${id}.`);
  const at = path.join(UPLOADS, found);
  return documentFrom(found.slice(id.length + 2), fs.readFileSync(at), found);
}

function line(value: unknown, most = 400): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, most);
  return text.length > 0 ? text : undefined;
}

/**
 * Keep only what the shape allows, and only as much of it as is sensible.
 *
 * A reply is data, not instructions, and a long one is a long one by
 * accident. The caps are there so a document that was never a resume cannot
 * put four hundred roles in front of somebody.
 */
function vetted(reply: unknown): Proposed {
  const given = (reply ?? {}) as Record<string, unknown>;
  const list = (value: unknown, most: number): unknown[] =>
    Array.isArray(value) ? value.slice(0, most) : [];

  const asProfile = (given.profile ?? {}) as Record<string, unknown>;
  const links = list(asProfile.links, 12)
    .map((link) => line(link, 300))
    .filter((link): link is string => link !== undefined);

  const roles = list(given.roles, 40)
    .map((entry) => {
      const role = (entry ?? {}) as Record<string, unknown>;
      const company = line(role.company, 200);
      const title = line(role.title, 200);
      if (!company || !title) return null;
      return {
        company,
        title,
        ...(line(role.location, 200) ? { location: line(role.location, 200)! } : {}),
        ...(line(role.start_date, 40) ? { start_date: line(role.start_date, 40)! } : {}),
        ...(line(role.end_date, 40) ? { end_date: line(role.end_date, 40)! } : {}),
        bullets: list(role.bullets, 40)
          .map((bullet) => line(bullet, 1200))
          .filter((bullet): bullet is string => bullet !== undefined),
      };
    })
    .filter((role): role is NonNullable<typeof role> => role !== null);

  const education = list(given.education, 20)
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const school = line(item.school, 200);
      if (!school) return null;
      return {
        school,
        ...(line(item.degree, 200) ? { degree: line(item.degree, 200)! } : {}),
        ...(line(item.field, 200) ? { field: line(item.field, 200)! } : {}),
        ...(line(item.end_date, 40) ? { end_date: line(item.end_date, 40)! } : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const skills = list(given.skills, 80)
    .map((entry) => {
      const skill = (entry ?? {}) as Record<string, unknown>;
      const name = line(skill.name, 80);
      if (!name) return null;
      const years = typeof skill.years === "number" && skill.years > 0 && skill.years < 70
        ? Math.round(skill.years)
        : undefined;
      return { name, ...(years ? { years } : {}) };
    })
    .filter((skill): skill is NonNullable<typeof skill> => skill !== null);

  return {
    profile: {
      ...(line(asProfile.name, 200) ? { name: line(asProfile.name, 200)! } : {}),
      ...(line(asProfile.headline, 300) ? { headline: line(asProfile.headline, 300)! } : {}),
      ...(line(asProfile.email, 200) ? { email: line(asProfile.email, 200)! } : {}),
      ...(line(asProfile.phone, 60) ? { phone: line(asProfile.phone, 60)! } : {}),
      ...(line(asProfile.location, 200) ? { location: line(asProfile.location, 200)! } : {}),
      ...(links.length > 0 ? { links } : {}),
    },
    roles,
    education,
    skills,
    /* The facts are vetted against the store itself, below. */
    facts: list(given.facts, 40)
      .map((entry) => {
        const fact = (entry ?? {}) as Record<string, unknown>;
        const slug = line(fact.slug, 48)?.toLowerCase();
        const question = line(fact.question, 300);
        const answer = line(fact.answer, 600);
        if (!slug || !question || !answer || NEVER.test(slug) || NEVER.test(question)) return null;
        return { slug, question, answer };
      })
      .filter((fact): fact is NonNullable<typeof fact> => fact !== null),
    unsure: list(given.unsure, 30)
      .map((note) => line(note, 400))
      .filter((note): note is string => note !== undefined),
  };
}

/**
 * The facts a document may contribute, which is fewer than it offers.
 *
 * Run twice: once on what was read, so nothing improper is ever proposed,
 * and again on what a caller accepted, so nothing improper can be written
 * even by a caller that names it. The two are different failures — one would
 * put a wrong suggestion in front of the person, the other would put a wrong
 * answer on a form — and the second is the one that reaches an employer.
 */
export async function vetFacts(
  facts: { slug: string; question: string; answer: string }[],
): Promise<Proposed["facts"]> {
  const kept: Proposed["facts"] = [];
  for (const fact of facts) {
    const slug = fact.slug.trim().toLowerCase();
    if (NEVER.test(slug) || NEVER.test(fact.question)) continue;
    const allowed = vet(slug, fact.question, await getFact(slug));
    if (allowed) kept.push({ slug: allowed.slug, question: allowed.question, answer: fact.answer });
  }
  return kept;
}

/**
 * Read a document and write down what it says, without applying any of it.
 *
 * The model used here is the capable one rather than the cheap one. The other
 * calls in this app decide one thing about one sentence; this one reads a
 * document and has to not invent anything while doing it, which is the sort
 * of care that is worth paying for once per onboarding.
 */
export async function proposeFrom(document: Document): Promise<Import> {
  if (document.kind === "text" && !document.text.trim()) {
    throw new Error("There is nothing to read.");
  }
  if (document.kind === "file" && document.bytes.length === 0) {
    throw new Error("That file is empty.");
  }

  const credential = await readCredential();
  if (!credential) {
    throw new Error("Reading a document needs the Anthropic credential; none is stored.");
  }

  /*
    The names already in use, so a document does not arrive with a second one
    for a question that has a name. The live run proposed "current_employer"
    while the seeded "current_company" — "Where do you work now?" — sat
    unanswered, which leaves the app holding the answer under one name and
    asking for the other for ever.
  */
  const named = new Map<string, string>();
  for (const seed of seedQuestions()) named.set(seed.slug, seed.question);
  for (const fact of await candidateFacts()) named.set(fact.slug, fact.question);
  const known = [...named].map(([slug, question]) => `- ${slug}: ${question}`).join("\n");

  /*
    The document as a block beside the question, rather than as text somebody
    extracted first. A PDF goes up as a PDF and a photograph of a page goes up
    as an image, and in both cases the thing reading it is the thing that will
    report what it says — so nothing is lost between a parser and a reader.

    `tools: []` as everywhere else in this app. The bytes are in the message;
    there is nothing to go and fetch, and so nothing to confine.
  */
  const asked = `QUESTIONS ALREADY NAMED\n${known}\n\n${
    document.kind === "text"
      ? `DOCUMENT\n\n${document.text.slice(0, MOST)}`
      : "The document is attached. Read it and report what it says."
  }`;

  const content =
    document.kind === "text"
      ? asked
      : [
          document.media === "application/pdf"
            ? {
                type: "document" as const,
                source: {
                  type: "base64" as const,
                  media_type: "application/pdf" as const,
                  data: document.bytes.toString("base64"),
                },
              }
            : {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: document.media as "image/png",
                  data: document.bytes.toString("base64"),
                },
              },
          { type: "text" as const, text: asked },
        ];

  async function* sent() {
    yield {
      type: "user" as const,
      parent_tool_use_id: null,
      session_id: "",
      message: { role: "user" as const, content },
    };
  }

  let answered = "";
  for await (const message of query({
    prompt: sent() as never,
    options: {
      model: IMPORT_MODEL,
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
        if (block.type === "text") answered += block.text;
      }
    }
    if (message.type === "result" && message.subtype !== "success") {
      throw new Error(`reading the document stopped: ${message.subtype}`);
    }
  }

  const found = answered.match(/\{[\s\S]*\}/);
  if (!found) throw new Error("The document could not be read into a profile.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(found[0]);
  } catch {
    throw new Error("The document was read but the result could not be parsed.");
  }

  const proposal = vetted(parsed);
  proposal.facts = await vetFacts(proposal.facts);

  const written = await run(
    `INSERT INTO imports (source, origin, proposal, at) VALUES (?, ?, ?, datetime('now'))`,
    document.source,
    document.origin || null,
    JSON.stringify(proposal),
  );

  changed("profile");
  return (await getImport(Number(written.lastInsertRowid)))!;
}

function importOf(row: {
  id: number;
  source: string;
  origin: string | null;
  at: string;
  applied_at: string | null;
  proposal: string;
}): Import {
  return {
    id: row.id,
    source: row.source,
    origin: row.origin,
    at: row.at,
    applied_at: row.applied_at,
    proposal: JSON.parse(row.proposal) as Proposed,
  };
}

export async function getImport(id: number): Promise<Import | null> {
  const row = await get<Parameters<typeof importOf>[0]>(
    `SELECT id, source, origin, at, applied_at, proposal FROM imports WHERE id = ?`,
    id,
  );
  return row ? importOf(row) : null;
}

export async function listImports(): Promise<Import[]> {
  const rows = await all<Parameters<typeof importOf>[0]>(
    `SELECT id, source, origin, at, applied_at, proposal FROM imports ORDER BY id DESC LIMIT 20`,
  );
  return rows.map(importOf);
}

/** Which parts of a proposal to take. Everything, unless something is named. */
export interface Choices {
  profile?: boolean;
  roles?: number[];
  education?: number[];
  skills?: number[];
  facts?: number[];
}

export interface Applied {
  roles: number;
  bullets: number;
  education: number;
  skills: number;
  facts: number;
  profile: string[];
}

/**
 * Write a proposal into the profile, copying from the stored row.
 *
 * Only ever from the row. Nothing here takes text from a caller, so there is
 * no path by which something that was not in the document becomes a sentence
 * in the profile — which is the promise the whole file is arranged around.
 *
 * Nothing already there is overwritten. A profile field the person has filled
 * in stands, and the import's version of it is reported as skipped rather
 * than quietly preferred.
 */
export async function applyImport(id: number, choices: Choices = {}): Promise<Applied> {
  const stored = await getImport(id);
  if (!stored) throw new Error(`No import with id ${id}`);

  const wanted = (chosen: number[] | undefined, index: number) =>
    chosen === undefined || chosen.includes(index);

  const applied: Applied = { roles: 0, bullets: 0, education: 0, skills: 0, facts: 0, profile: [] };

  if (choices.profile !== false) {
    const now = await profile.getProfile();
    const patch: Record<string, string> = {};
    for (const field of ["name", "headline", "email", "phone", "location"] as const) {
      const value = stored.proposal.profile[field];
      if (value && !now[field]) {
        patch[field] = value;
        applied.profile.push(field);
      }
    }

    /*
      Links are merged rather than replaced: the profile's are the ones the
      person chose to show employers, and a document's list is often longer
      and older.
    */
    const incoming = stored.proposal.profile.links ?? [];
    if (incoming.length > 0) {
      let existing: string[] = [];
      try {
        const parsed = JSON.parse(now.links) as unknown;
        existing = Array.isArray(parsed)
          ? parsed.map((link) => (typeof link === "string" ? link : String((link as { url?: string })?.url ?? "")))
          : [];
      } catch {
        existing = [];
      }
      const merged = [...existing];
      for (const link of incoming) {
        if (!merged.some((had) => had.toLowerCase() === link.toLowerCase())) merged.push(link);
      }
      if (merged.length !== existing.length) {
        patch.links = JSON.stringify(merged);
        applied.profile.push("links");
      }
    }

    if (Object.keys(patch).length > 0) await profile.updateProfile(patch);
  }

  const already = await profile.listRoles();
  for (const [index, role] of stored.proposal.roles.entries()) {
    if (!wanted(choices.roles, index)) continue;
    /*
      The same job twice is a duplicate, not a second job. An import run a
      second time — a resume, then the LinkedIn export of the same career —
      should not double the history.
    */
    if (
      already.some(
        (had) =>
          had.company.toLowerCase() === role.company.toLowerCase() &&
          had.title.toLowerCase() === role.title.toLowerCase(),
      )
    ) {
      continue;
    }
    const written = await profile.addRole({
      company: role.company,
      title: role.title,
      location: role.location ?? null,
      start_date: role.start_date ?? null,
      end_date: role.end_date ?? null,
      summary: null,
      sort_order: index,
    });
    applied.roles += 1;
    for (const bullet of role.bullets) {
      await profile.addBullet(written.id, bullet);
      applied.bullets += 1;
    }
  }

  const schools = await profile.listEducation();
  for (const [index, item] of stored.proposal.education.entries()) {
    if (!wanted(choices.education, index)) continue;
    if (schools.some((had) => had.school.toLowerCase() === item.school.toLowerCase())) continue;
    await profile.addEducation({
      school: item.school,
      degree: item.degree ?? null,
      field: item.field ?? null,
      start_date: null,
      end_date: item.end_date ?? null,
      note: null,
    });
    applied.education += 1;
  }

  for (const [index, skill] of stored.proposal.skills.entries()) {
    if (!wanted(choices.skills, index)) continue;
    await profile.addSkill(skill.name, undefined, skill.years);
    applied.skills += 1;
  }

  /*
    Checked again on the way in, not only on the way out. A caller naming an
    index is a caller that could name the index of a right-to-work answer,
    and the write is the last place to stop it.
  */
  const offered = stored.proposal.facts.filter((_, index) => wanted(choices.facts, index));
  for (const fact of await vetFacts(offered)) {
    await setFact({
      slug: fact.slug,
      question: fact.question,
      answer: fact.answer,
      source: `${stored.source}:${stored.id}`,
    });
    applied.facts += 1;
  }

  await run(`UPDATE imports SET applied_at = datetime('now') WHERE id = ?`, id);
  changed("profile");
  return applied;
}

/* --------------------------------------------------------- rounding it out */

export interface Missing {
  /** Whether there is enough to apply for anything at all. */
  ready: boolean;
  /** The parts of the profile with nothing in them. */
  gaps: string[];
  /** The app's own questions with neither an answer nor a refusal. */
  unanswered: { slug: string; question: string }[];
  /**
   * Questions real forms asked that nothing could answer, and that are worth
   * putting to the person — the employer's own are filtered out.
   */
  asked: { label: string; slug: string; question: string }[];
}

/**
 * What is still worth asking, and in what order.
 *
 * The order is the useful part. A profile page can list every empty field and
 * be ignored; what someone actually wants to know is which gap stopped an
 * application, and that is answerable from what the forms have already asked.
 *
 * `asked` comes out of fact_matches, where every question nothing on file
 * matched is already recorded — so "the questions you keep being asked and
 * have no answer for" is a query over work the app has already done, not a
 * guess. The employer's own questions are filtered out by reading them; see
 * apply/keep.ts.
 */
export async function whatIsMissing(): Promise<Missing> {
  const [now, roles, education, skills, facts] = await Promise.all([
    profile.getProfile(),
    profile.listRoles(),
    profile.listEducation(),
    profile.listSkills(),
    listFacts("open"),
  ]);

  const gaps: string[] = [];
  if (!now.name) gaps.push("name");
  if (!now.email) gaps.push("email");
  if (!now.location) gaps.push("location");
  if (now.links === "[]" || !now.links) gaps.push("links");
  if (roles.length === 0) gaps.push("work history");
  if (education.length === 0) gaps.push("education");
  if (skills.length === 0) gaps.push("skills");

  const bullets = roles.length > 0 ? await profile.listBullets() : [];
  if (roles.length > 0 && bullets.length === 0) gaps.push("what you did in those roles");

  /*
    The eight the app asks about itself, where the person has neither
    answered nor refused. A refusal is not a gap — that is the distinction
    the fact store exists for — so `declined` and `never` are left out.
  */
  const decided = new Map(facts.map((fact) => [fact.slug, fact]));
  const unanswered = seedQuestions().filter((seed) => {
    const fact = decided.get(seed.slug);
    return !fact || (fact.state === "asked" && fact.share !== "never");
  });

  /*
    Every form question nothing matched. Distinct labels, newest first,
    because what was asked last week is what the person is applying for now.
  */
  const rows = await all<{ label: string }>(
    `SELECT label, MAX(at) AS at FROM fact_matches
       WHERE slug IS NULL GROUP BY label ORDER BY at DESC LIMIT 40`,
  );

  return {
    ready: Boolean(now.name && now.email && roles.length > 0),
    gaps,
    unanswered,
    asked: await worthAsking(rows.map((row) => row.label)),
  };
}

/* ------------------------------------------------------ how to get started */

export interface Route {
  name: string;
  best_for: string;
  steps: string[];
  caveats: string[];
  /** Whether this app can read what the route produces today. */
  ready: boolean;
}

/**
 * How to get a career history out of LinkedIn, and which way is best.
 *
 * Here rather than in the agent's prompt because the person's own page says
 * the same thing, and two copies of a set of instructions is one copy that
 * goes stale. The steps were checked against LinkedIn's help pages in
 * November 2026; they move things, so treat a step that does not match what
 * somebody sees as out of date rather than as them being lost.
 *
 * The export is recommended and the ordering is deliberate. Reading a
 * LinkedIn page directly was considered and rejected: their terms forbid
 * automated access, and the cost of being wrong is somebody's account being
 * restricted, which is not a thing this app may risk on their behalf. Having
 * chosen the slower route on principle, the least it can do is read the zip
 * as it arrives rather than asking them to unpack it.
 */
export function importRoutes(): Route[] {
  return [
    {
      name: "Save your LinkedIn profile as a PDF",
      best_for: "The fastest way in: three clicks, and I can read the PDF itself.",
      steps: [
        "Open your own LinkedIn profile in a desktop browser.",
        "Click the … button in the top section, to the right of Enhance profile.",
        "Choose Save to PDF.",
        "Give me the file it downloads — drag it into the chat, or use the paperclip.",
      ],
      caveats: [
        "Not available in the mobile app.",
        "Only English characters come out correctly.",
        "It is a tidied-up version of your profile, so it can leave out detail you have written. If something is missing afterwards, tell me and I will add it.",
      ],
      ready: true,
    },
    {
      name: "Download your full LinkedIn data",
      best_for: "The complete history, exactly as you wrote it, when the PDF has left things out.",
      steps: [
        "In a desktop browser, open LinkedIn and click Me, then Settings & Privacy.",
        "Open Data privacy in the list on the left.",
        "Under “How LinkedIn uses your data”, click Get a copy of your data.",
        "Choose the specific categories rather than the whole archive, and tick Profile, Positions, Education, Skills and Certifications.",
        "LinkedIn emails a link within a few minutes for that selection. The whole archive instead takes up to 24 hours.",
        "Give me the zip as it arrives. There is no need to unzip it.",
      ],
      caveats: [
        "Not available in the mobile app — it has to be a desktop browser.",
        "LinkedIn may ask for your password when you make the request.",
        "The download link expires after 72 hours.",
      ],
      ready: true,
    },
    {
      name: "A resume you already have",
      best_for: "Anything you have written yourself, in most formats.",
      steps: [
        "Drag the file into the chat, use the paperclip, or paste the text straight in.",
        "A PDF or a photograph of a page is fine. So is .txt, .md, .csv, .json or .html.",
      ],
      caveats: ["Word and Pages files are not readable — export one as a PDF first."],
      ready: true,
    },
  ];
}

export function importHelp(): { routes: Route[]; note: string } {
  return {
    routes: importRoutes(),
    note:
      "Offer the first route: Save to PDF is three clicks and the PDF can be read as it is. The full download is " +
      "there for when the PDF turns out to have left something out — do not lead with it, it means a request, an " +
      "email and a wait. Nothing is stored by reading any of these: what is found is shown to them first, and only " +
      "what they accept goes into the profile. This app does not read their LinkedIn page itself — LinkedIn forbids " +
      "automated access and the price of being wrong is their account, which is not something to risk on their " +
      "behalf. Say that plainly if they ask why they are doing the exporting.",
  };
}

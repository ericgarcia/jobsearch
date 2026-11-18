import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "./config.js";
import { all, get, run } from "./db/client.js";
import { changed } from "./notify.js";
import { credentialEnv, readCredential } from "./settings.js";
import { candidateFacts, getFact, listFacts, seedQuestions, setFact } from "./apply/facts.js";
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

/** What can be read without a dependency this app does not have. */
const READABLE = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm", ".tsv"]);

/* LinkedIn's own export, once it is unzipped. Named files, in a useful order. */
const LINKEDIN = ["Profile.csv", "Positions.csv", "Education.csv", "Skills.csv", "Certifications.csv"];

const MOST = 400_000;

/**
 * Get the text of something the person points at.
 *
 * A file, or the folder LinkedIn's export unzips into. A PDF is refused
 * rather than guessed at: there is no text extractor in this app, and a
 * resume read as mojibake would be proposed as the person's own words.
 */
export function readSource(at: string): { text: string; source: ImportSource; origin: string } {
  const where = path.resolve(at.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (!fs.existsSync(where)) throw new Error(`Nothing at ${where}`);

  if (fs.statSync(where).isDirectory()) {
    const found = LINKEDIN.filter((name) => fs.existsSync(path.join(where, name)));
    if (found.length === 0) {
      throw new Error(
        `No LinkedIn export files in ${where}. Expected some of: ${LINKEDIN.join(", ")}. If it is still a zip, unzip it first.`,
      );
    }
    const text = found
      .map((name) => `--- ${name}\n${fs.readFileSync(path.join(where, name), "utf8")}`)
      .join("\n\n")
      .slice(0, MOST);
    return { text, source: "linkedin", origin: where };
  }

  const extension = path.extname(where).toLowerCase();
  if (extension === ".pdf" || extension === ".docx" || extension === ".doc") {
    throw new Error(
      `${extension} files cannot be read here — this app has no text extractor for them. Open it, copy the text, and paste that instead.`,
    );
  }
  if (!READABLE.has(extension)) {
    throw new Error(`Cannot read ${extension || "a file with no extension"}. Paste the text instead.`);
  }

  const text = fs.readFileSync(where, "utf8").slice(0, MOST);
  const source: ImportSource = /linkedin/i.test(path.basename(where)) ? "linkedin" : "resume";
  return { text, source, origin: where };
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
export async function proposeFrom(
  text: string,
  source: ImportSource,
  origin?: string,
): Promise<Import> {
  if (!text.trim()) throw new Error("There is nothing to read.");

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

  let answered = "";
  for await (const message of query({
    prompt: `QUESTIONS ALREADY NAMED\n${known}\n\nDOCUMENT\n\n${text.slice(0, MOST)}`,
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
    source,
    origin ?? null,
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

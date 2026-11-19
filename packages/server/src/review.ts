import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "./config.js";
import { get, run } from "./db/client.js";
import * as profile from "./profile.js";
import { credentialEnv, readCredential } from "./settings.js";

/**
 * Reading the profile as a whole, once the document is done with.
 *
 * An import answers one question — what does this document say? — and the
 * queue it leaves behind is made of that document's own loose ends. When
 * those run out the queue refills from what the profile is structurally
 * missing: no email, no location, an application question nothing answers.
 * All true, all mechanical, and none of it the thing a person actually needs
 * asked. Nobody's profile is weak because a field is empty. It is weak
 * because seven years at one company are four lines about pipelines with no
 * mention of the team, or because the one number that would make a line land
 * is the one number the resume never had.
 *
 * So when the mechanical refill has nothing left, the profile is read. What
 * comes back is questions — what is thin, what is claimed without evidence,
 * what a person would be asked about this history in a first interview — and
 * they join the same queue as everything else. That is the whole point of
 * putting them there: the progress bar counts them, the cards land on the
 * rows they are about, and answering one settles it exactly as answering an
 * import question does.
 *
 * It reads work, and only work: roles, lines, education, skills, the
 * summary. Not the contact details, which have nothing to review; not the
 * standing answers, which hold pay and notice and right-to-work; and not the
 * voluntary self-identification answers, which never go into a prompt at
 * all. A review of somebody's career does not need to know any of that, and
 * the way to keep it out of a prompt is not to fetch it.
 *
 * It runs once per state of the profile. The fingerprint below is what was
 * reviewed; if nothing has changed since, there is nothing new to say, and
 * asking again would spend a model call to produce the questions already
 * sitting in the queue.
 */

export const REVIEW_MODEL = process.env.JOBSEARCH_REVIEW_MODEL ?? "claude-sonnet-5-5";

const REVIEWED = "reviewed_profile";

export interface ReviewItem {
  /** What to put to them, in the assistant's own words. */
  note: string;
  /** The row it is about, when it is about one. */
  target?: "role" | "bullet" | "profile" | null;
  target_id?: number | null;
  field?: string | null;
}

const INSTRUCTIONS = `You are reviewing somebody's career profile to find what is
worth asking them about. You are given their profile as JSON: roles with the
lines stored under each, education, skills, and a summary.

Return JSON only: {"ask": [ ... ]}, up to eight items, each

  {"note": "...", "target": "role" | "bullet" | null, "target_id": 12 | null}

"note" is the question or suggestion, addressed to whoever will ask it, in one
or two sentences. "target" and "target_id" name the row it is about, using the
ids in the profile you were given, or null when it is about none of them.

What is worth asking:

- a role whose lines do not say what the person did, or how much of it, or
  with whom, when the title suggests there is more to say;
- a long stint with fewer lines than a short one;
- a line that states a result with no figure, where a figure plainly exists —
  but only ask for one where the person would know it, not where you would
  like one;
- something claimed in the summary that no role backs up, or the reverse: a
  thread running through several roles that the summary never mentions;
- work a person in this field would expect to see and this profile has none
  of: leading or mentoring, the thing that went wrong, what they chose not to
  build, the scale they ran at;
- a skill listed with nothing behind it, or a skill the lines clearly show
  that the list does not have.

What is not worth asking:

- anything already answered by a line that is there;
- dates, spelling, formatting, or anything you could fix without them;
- how they would like the wording changed, which is a question for when
  there is a line to change;
- their pay, their right to work, where they will live, or anything about
  who they are rather than what they have done.

Ask about what the work was, not about how to write about it. One subject
per item.

Call the person "they". You are not told who they are and a name does not
say; a guess here is a guess that reaches them in the question somebody
asks. Nothing else in the reply.`;

/** What the profile is right now, so the same state is not reviewed twice. */
async function fingerprint(): Promise<string> {
  const [roles, bullets, education, skills, kept] = await Promise.all([
    profile.listRoles(),
    profile.listBullets(),
    profile.listEducation(),
    profile.listSkills(),
    profile.getProfile(),
  ]);
  const shape = [
    roles.map((one) => `${one.id}:${one.company}:${one.title}:${one.start_date}:${one.end_date}`),
    bullets.map((one) => `${one.id}:${one.text.length}`),
    education.map((one) => `${one.id}:${one.school}:${one.degree}`),
    skills.map((one) => (typeof one === "string" ? one : JSON.stringify(one))),
    (kept.summary ?? "").length,
  ];
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

/** What was reviewed last, or null if nothing has been. */
export async function reviewedState(): Promise<string | null> {
  const row = await get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, REVIEWED);
  return row?.value ?? null;
}

async function rememberReview(mark: string): Promise<void> {
  await run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    REVIEWED,
    mark,
  );
}

/** The work, and nothing else. See the note above on what is left out. */
async function workOnly(): Promise<string> {
  const [roles, bullets, education, skills, kept] = await Promise.all([
    profile.listRoles(),
    profile.listBullets(),
    profile.listEducation(),
    profile.listSkills(),
    profile.getProfile(),
  ]);

  return JSON.stringify(
    {
      headline: kept.headline ?? null,
      summary: kept.summary ?? null,
      roles: roles.map((role) => ({
        id: role.id,
        company: role.company,
        title: role.title,
        from: role.start_date,
        to: role.end_date,
        lines: bullets
          .filter((one) => one.role_id === role.id)
          .map((one) => ({ id: one.id, text: one.text })),
      })),
      education: education.map((one) => ({
        id: one.id,
        school: one.school,
        degree: one.degree,
        field: one.field,
      })),
      skills: skills.map((one) => (typeof one === "string" ? one : (one as { name?: string }).name)),
    },
    null,
    1,
  );
}

function vetted(parsed: unknown, roleIds: Set<number>, lineIds: Set<number>): ReviewItem[] {
  const said = (parsed as { ask?: unknown })?.ask;
  if (!Array.isArray(said)) return [];

  const items: ReviewItem[] = [];
  for (const one of said.slice(0, 8)) {
    const row = one as Record<string, unknown>;
    const note = typeof row.note === "string" ? row.note.trim() : "";
    if (!note) continue;

    const target = row.target === "role" || row.target === "bullet" ? row.target : null;
    const id = typeof row.target_id === "number" ? row.target_id : null;

    /*
      A target that names a row that is not there would put a question on the
      page beside nothing, which is the fault this app has had twice. An item
      whose id does not check out keeps its question and loses its target.
    */
    const real =
      target === "role" ? (id != null && roleIds.has(id)) : target === "bullet" ? (id != null && lineIds.has(id)) : false;

    items.push({
      note,
      target: real ? target : null,
      target_id: real ? id : null,
      ...(real && target === "bullet" ? { field: "text" } : {}),
    });
  }
  return items;
}

/**
 * Read the profile and say what is worth asking about.
 *
 * Returns nothing — rather than throwing — when there is no credential, when
 * there is nothing to review, or when this state has been reviewed already.
 * It is called from the queue refilling itself, and a refill that fails
 * because a model call failed would take the rest of the queue down with it.
 */
export async function reviewProfile(force = false): Promise<ReviewItem[]> {
  const roles = await profile.listRoles();
  /* Nothing to review: a profile with no history is an import away, not a review. */
  if (roles.length === 0) return [];

  const mark = await fingerprint();
  if (!force && (await reviewedState()) === mark) return [];

  const credential = await readCredential();
  if (!credential) return [];

  const bullets = await profile.listBullets();
  let answered = "";
  try {
    for await (const message of query({
      prompt: `PROFILE\n\n${await workOnly()}`,
      options: {
        model: REVIEW_MODEL,
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
        throw new Error(`the review stopped: ${message.subtype}`);
      }
    }
  } catch {
    return [];
  }

  const found = answered.match(/\{[\s\S]*\}/);
  if (!found) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(found[0]);
  } catch {
    return [];
  }

  const items = vetted(
    parsed,
    new Set(roles.map((one) => one.id)),
    new Set(bullets.map((one) => one.id)),
  );

  /*
    Marked as reviewed even when it found nothing to say. "I have read this
    and there is nothing worth asking" is an answer, and re-reading the same
    profile every time the queue empties to be told so again is a model call
    spent on a question already answered.
  */
  await rememberReview(mark);
  return items;
}

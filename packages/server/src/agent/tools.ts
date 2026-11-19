import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { currentState } from "../appState.js";
import { z } from "zod";
import * as repo from "../repo.js";
import { STATUSES } from "../status.js";
import { syncBoards } from "../sync.js";
import { rankAllJobs } from "../matching.js";
import { expandPlace } from "../location.js";
import { detectMany } from "../sources/detect.js";
import { evaluateCompanies } from "../discover.js";
import { getInterests, setInterests } from "../interests.js";
import { homeLocation, matchBar, setMatchBar, setVoluntaryDefault } from "../settings.js";
import { importPosting } from "../importing.js";
import { formForJob } from "../apply/read.js";
import { describe as describeForm } from "../apply/form.js";
import { startApplication } from "../apply/start.js";
import { fillApplication } from "../apply/fill.js";
import { listAnswers, markApplied, recordAnswers } from "../apply/record.js";
import { keepable } from "../apply/keep.js";
import { clearEdit, pendingEdit, proposeEdit, withdrawnEdit } from "../pending.js";
import { wishForAnswer } from "../wishes.js";
import { reportBug } from "../bugs.js";
import { noteAsking } from "../asking.js";
import { clearQueue, nextQuestion, settleQuestion } from "../queue.js";
import {
  applyImport,
  documentForUpload,
  importHelp,
  outline,
  proposeFrom,
  whatIsMissing,
  type Document,
} from "../onboard.js";
import {
  coverage,
  listStandingAnswers,
  selfIdentificationKeysSet,
  setStandingAnswer,
  setVoluntaryChoices,
  declineSelfIdentification,
  declineStandingAnswer,
  voluntarySection,
} from "../apply/answers.js";
import { assessTopJobs, ASSESS_MODEL } from "../assess.js";
import { SOURCES } from "../sources/index.js";
import { profileTools, PROFILE_MUTATING } from "./profileTools.js";
import { browserTools } from "./browserClient.js";
import { browserEnabled } from "./browserFlag.js";

/** Tool results go back as compact JSON. Claude reads these as exact fields. */
const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

async function guard<T>(run: () => T | Promise<T>) {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Trim a posting so one job does not swallow the context window. */
function truncate(text: string | null, max: number): string | null {
  if (text == null) return null;
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

/** The summary shape returned by list-style tools. Descriptions are left out. */
function summarise(job: repo.JobWithStatus) {
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    location: job.location,
    remote: job.remote === 1,
    url: job.url,
    posted_at: job.posted_at,
    status: job.status,
    fit_score: job.fit_score,
    match_score: job.match_score,
  };
}

/**
 * Turn what the agent asked for into the forms boards actually write.
 * No places named means the person's own city; "anywhere" means no filter.
 */
async function resolvePlaces(places?: string[]): Promise<string[] | undefined> {
  if (places?.some((place) => place.trim().toLowerCase() === "anywhere")) return undefined;

  const wanted =
    places && places.length > 0 ? places : [(await homeLocation()) ?? ""].filter(Boolean);
  if (wanted.length === 0) return undefined;
  return wanted.flatMap(expandPlace);
}

const getInterestsTool = tool(
  "get_interests",
  "Read what the person says they are looking for: the role titles they want, subjects to seek out, and subjects to avoid. This is what they want next, as opposed to the profile, which is what they have done. Matching weights these above anything read from their history.",
  {},
  async () => guard(async () => await getInterests()),
  { annotations: { readOnlyHint: true } },
);

const setInterestsTool = tool(
  "set_interests",
  "Record what the person is looking for. Use their own words. Only send the fields that change; sending a list replaces it.",
  {
    titles: z.array(z.string()).optional().describe('Role titles wanted, e.g. ["Staff Machine Learning Engineer"]'),
    include: z.array(z.string()).optional().describe("Subjects or technologies to seek out"),
    exclude: z.array(z.string()).optional().describe("Subjects to avoid. A posting whose title matches one is pushed right down."),
    note: z.string().optional().describe("Anything else about what they want, in their words"),
  },
  async (args) =>
    guard(async () => ({
      interests: await setInterests(args),
      note: "Run rank_jobs so the change takes effect on the stored postings.",
    })),
);

const evaluateCompaniesTool = tool(
  "evaluate_companies",
  "Look at companies' job boards WITHOUT following them, and report how many of their postings match what the person wants. Use this to decide which companies are worth following, then add_companies for the ones that are. Propose candidate names yourself from what you know of the person's field — there is no way to search every board, so the names have to come from somewhere, and saying where you got them is part of the answer.",
  {
    names: z.array(z.string()).min(1).max(20).describe("Companies to look at"),
    location_any: z.array(z.string()).optional().describe('Cities to count. Omit for where they live; ["anywhere"] for no limit.'),
    include_remote: z.boolean().optional().describe("Also count remote postings based elsewhere"),
    threshold: z.number().int().min(0).max(100).optional().describe("Score a posting must reach to count as a match. Default 40."),
  },
  async (args) =>
    guard(async () => {
      const places = await resolvePlaces(args.location_any);
      return await evaluateCompanies(args.names, {
        location: places === undefined ? "" : places.join(","),
        includeRemote: args.include_remote ?? false,
        threshold: args.threshold,
      });
    }),
  { annotations: { readOnlyHint: true } },
);

const removeCompanyTool = tool(
  "remove_company",
  "Stop following a board. Say whether to delete the postings it already fetched: left behind, they stay in the list and rank, and nothing ever refreshes them again. Postings being pursued or drafted for are always kept, however this is called. Check with list_companies first so you name the right one, and tell the person how many postings go.",
  {
    id: z.number().int().describe("The company id from list_companies"),
    delete_postings: z
      .boolean()
      .describe("True to delete its stored postings. Ask the person before sending true."),
  },
  async (args) => guard(async () => await repo.removeCompany(args.id, args.delete_postings)),
);

const listCompanies = tool(
  "list_companies",
  "List the company job boards this app polls.",
  {},
  async () => guard(async () => await repo.listCompanies()),
  { annotations: { readOnlyHint: true } },
);

const addCompany = tool(
  "add_company",
  "Add a company job board to poll. The board token is the company's identifier in its ATS URL, for example 'anthropic' in boards.greenhouse.io/anthropic.",
  {
    name: z.string().describe("Display name of the company"),
    ats: z.enum(["greenhouse", "lever", "ashby"]).describe("Which applicant tracking system hosts the board"),
    board_token: z.string().describe("The board identifier in the ATS URL"),
  },
  async (args) => guard(async () => await repo.addCompany(args.name, args.ats, args.board_token)),
);

const addCompaniesByName = tool(
  "add_companies",
  "Add companies to follow by name alone. Works out which applicant tracking system each one uses and what its board is called, then stores the ones it finds. Tell the person which companies could not be found: they may use a system this app does not read, or post only on their own site.",
  {
    names: z.array(z.string()).min(1).describe("Company names, for example [\"Figma\", \"Ramp\"]"),
  },
  async (args) =>
    guard(async () => {
      const found = await detectMany(args.names);
      for (const row of found) {
        if (row.found) await repo.addCompany(row.name, row.found.ats, row.found.board_token);
      }
      return {
        added: found.filter((row) => row.found).map((row) => ({
          name: row.name,
          ats: row.found!.ats,
          board_token: row.found!.board_token,
          jobs: row.found!.jobs,
        })),
        not_found: found.filter((row) => !row.found).map((row) => row.name),
        note: "Run sync_boards next to fetch the postings, then rank_jobs.",
      };
    }),
);

const importPostingTool = tool(
  "import_posting",
  "Bring one posting into the job list from wherever the person found it — a LinkedIn listing, a link someone sent them, the page open in the pane beside the app. Give the posting's own URL when it is already on greenhouse, lever or ashby; otherwise give the company and the role title, and this finds the company's own board and the posting on it. The canonical posting is the one worth storing: it can be applied to, it stays up to date, and it ranks against everything else. A posting imported this way is kept whatever it scores, because they asked for it by name. When it answers with candidates it was not sure which posting is meant — show them and ask, never pick one. Set follow to also subscribe to that company's board, which brings in its other matching roles on the next sync.",
  {
    url: z.string().optional().describe("The posting's URL, from any site"),
    company: z.string().optional().describe("The company, when the URL is not a board we read"),
    title: z.string().optional().describe("The role title, as the other site gives it"),
    follow: z
      .boolean()
      .optional()
      .describe("Also follow the company's board. Ask first for a large company."),
  },
  async (args) => guard(async () => await importPosting(args)),
);

const applicationFormTool = tool(
  "application_form",
  "What a job's application will ask for, read from the board without opening a browser. Answers with every field, whether it is required, and who the answer belongs to: identity and link fields come from the profile, documents are the resume and cover letter this app produces, standing fields are the ones that are the same at every company and are legally significant — work authorization, sponsorship, relocation, notice, pay — custom fields are that employer's own questions, and eeo fields are voluntary self-identification. Use it to tell someone what an application needs before they start, or to compare several. Never answer an eeo field, and never infer one: they are the person's alone.",
  { job_id: z.number().int().describe("The job id, from search_jobs or a card") },
  async (args) =>
    guard(async () => {
      const form = await formForJob(args.job_id);
      return { ...form, summary: describeForm(form) };
    }),
  { annotations: { readOnlyHint: true } },
);

const standingAnswersTool = tool(
  "get_standing_answers",
  "What the person has already said about their situation — work authorisation, sponsorship, relocation, days in an office, notice, pay. These are the same at every company and are the answers to copy, never to work out: an agent inferring someone's right to work in a country from their history is guessing about something legally significant. Anything not stored here is a decision only they can make.",
  {},
  async () => guard(async () => ({ answers: await listStandingAnswers() })),
  { annotations: { readOnlyHint: true } },
);

const setStandingAnswerTool = tool(
  "set_standing_answer",
  "Store what they just told you about their situation, in their words, so no application has to ask again. Use the topic that fits: work_authorization, sponsorship, relocation, onsite, notice_period, start_date, salary — or your own short topic name for anything else, which is how a question nobody anticipated gets an answer on file. Pass `question` with a new topic, worded as you would ask them, because that wording is what later forms are matched against. Only store what they actually said; an empty answer removes it. If they say they would rather not answer, pass decline instead of an answer: that is written down as a refusal, nothing asks them again, and it is not the same as leaving it empty.",
  {
    topic: z.string().describe("work_authorization, sponsorship, relocation, onsite, notice_period, start_date, salary, or your own"),
    answer: z.string().default("").describe("Their answer, in their words. Empty removes what is stored."),
    question: z.string().optional().describe("The question it answers, in your words. Required for a topic that is not one of the known ones."),
    decline: z
      .boolean()
      .optional()
      .describe("True only if they said they would rather not answer this at all"),
  },
  async (args) =>
    guard(async () => {
      /*
        A refusal and an empty answer are different things, and the
        difference is whether the next application asks again. See
        apply/facts.ts.
      */
      if (args.decline) {
        await declineStandingAnswer(args.topic, args.question);
        return {
          answers: await listStandingAnswers(),
          declined: args.topic,
          note: "Written down as a refusal. Nothing will ask them this again, and it is left blank on every form. Do not raise it.",
        };
      }
      await setStandingAnswer(args.topic, args.answer, args.question);
      return { answers: await listStandingAnswers() };
    }),
);

const selfIdStatusTool = tool(
  "self_identification_status",
  "Whether the person has stored answers for the voluntary self-identification questions — gender, race, veteran status, disability, pronouns, transgender identity, sexual orientation, age, and the country a demographic survey asks for. Answers with which of them are set and NEVER with a value: those are theirs, they are not sent to you, and you must not ask for them, infer them from a name or a history, or answer such a question on a form. When a form asks one, say it is voluntary and that stored answers are filled in without you seeing them.",
  {},
  async () =>
    guard(async () => ({
      stored: await selfIdentificationKeysSet(),
      note: "Values are never shown to the assistant. They are filled into forms by the app itself.",
    })),
  { annotations: { readOnlyHint: true } },
);

const voluntaryAnswersTool = tool(
  "set_voluntary_answers",
  "Record which of this application's voluntary self-identification questions the person wants included, from what they have already stored. Ask them on every application that has such a section, as one message listing the questions start_application named, and record what they say here by key. It is per question and not per section: someone may give an employer their pronouns and not a disability status, so a single yes does not answer for the rest. Anything in neither list stays blank, which is a complete answer. Never ask what the answers are, never offer to work one out, and never put a value in this call: you do not see those, and the app matches what they stored to the form's own options itself. If they say they never disclose anywhere, pass never_ask instead of listing keys, and the question is not put again on any application.",
  {
    job_id: z.number().int(),
    include: z
      .array(z.string())
      .default([])
      .describe("The keys they asked to be included here, e.g. ['pronouns', 'veteran']"),
    exclude: z
      .array(z.string())
      .default([])
      .describe("The keys they asked to leave blank here"),
    never_ask: z
      .array(z.string())
      .default([])
      .describe(
        "Keys they want nothing to ask about again, on any application. Use only if they say so plainly.",
      ),
    never_disclose: z
      .boolean()
      .optional()
      .describe("True only if they say they never want the voluntary section raised again, anywhere"),
  },
  async (args) =>
    guard(async () => {
      if (args.never_disclose) await setVoluntaryDefault("never");
      for (const key of args.never_ask) await declineSelfIdentification(key);
      await setVoluntaryChoices(args.job_id, args.include, [...args.exclude, ...args.never_ask]);

      const form = await formForJob(args.job_id);
      const voluntary = await voluntarySection(form, args.job_id);
      const included = voluntary.questions.filter((question) => question.include === true).length;
      return {
        included,
        questions: voluntary.questions.length,
        still_to_confirm: voluntary.undecided,
        standing: voluntary.standing,
        note:
          voluntary.standing === "never"
            ? "The voluntary section is not to be raised again, on this or any application."
            : `${included} will be filled by the app from what they stored, without showing you the values. Everything else in the section stays blank.`,
      };
    }),
);

const startApplicationTool = tool(
  "start_application",
  "Begin applying for a job. Moves it to 'applying', reads the application form, finds anything already drafted for it, and hands back what is left to do in order. Call this first when someone decides to apply, rather than drafting straight away: a letter written before the form was read answers questions nobody asked, and a second resume written without reading the first quietly replaces their edits. It writes nothing and submits nothing — the resume and the letter are yours to draft afterwards, and the person sends the application themselves.",
  { job_id: z.number().int() },
  async (args) => guard(async () => await startApplication(args.job_id)),
);

const fillApplicationTool = tool(
  "fill_application",
  "Fill in the application form for a job, in the pane beside the app, from what is already known: name, email and links from the profile, situation questions from the standing answers, and, only if they have asked for it on this application, the voluntary self-identification section from whatever they stored — those are filled by the app itself and their values are not shown to you. Attaches the resume drafted for this job. Answers with what was filled and what was left, including the employer's own questions, which still need writing. It does not send anything: the control that sends an application is refused by the app, not by instruction, because an application cannot be taken back.",
  { job_id: z.number().int() },
  async (args) => guard(async () => await fillApplication(args.job_id)),
);

const recordAnswerTool = tool(
  "record_answer",
  "Write down an answer you put on an application form, so it can be read back later. Use it for the employer's own questions, which you write rather than copy — what you told them about why you want the job is the thing nobody remembers three weeks on. Never record a self-identification answer: those are filled by the app and recorded as answered, without the value. If the answer turns out to be a fact about them rather than something written for this employer, the reply says so and names the question it answers: put that to them in one line, and store it with set_standing_answer if they agree.",
  {
    job_id: z.number().int(),
    label: z.string().describe("The question, as the form words it"),
    value: z.string().describe("What was put in the field"),
  },
  async (args) =>
    guard(async () => {
      await recordAnswers(args.job_id, [
        { label: args.label, kind: "custom", value: args.value },
      ]);

      /*
        The offer that closes the loop: an answer to a question the store had
        no answer for was, until now, written down for this employer and
        thrown away. It is only an offer — the app proposes, the person
        decides, and set_standing_answer is what stores it. Keeping it
        unasked would be building a profile of someone out of things they
        said to somebody else.
      */
      const keep = await keepable(args.label, args.value);
      return {
        recorded: args.label,
        ...(keep
          ? {
              worth_keeping: { topic: keep.slug, question: keep.question },
              note: keep.known
                ? `They already have an answer stored for "${keep.question}". Say what is stored differs from what you just put on this form, and ask whether to update it. Do not change it without their word.`
                : `This looks like a fact about them rather than something written for this employer. Ask in one line whether to keep it for next time, as the answer to "${keep.question}", and store it with set_standing_answer on topic "${keep.slug}" if they say yes. Do not store it otherwise, and do not ask twice.`,
            }
          : {}),
      };
    }),
);

const importProfileTool = tool(
  "import_profile",
  "Read a document the person handed over and report what it says, without storing any of it. Pass `upload_id` for a file they dropped into the chat or chose with the paperclip — a PDF, a photograph of a page, a LinkedIn export zip as it arrives, or a text file — or `text` for something they pasted. You cannot name a path: the only files you can read are the ones they gave you, which is what the picker is for. Word and Pages files are not readable; ask them to export a PDF. Quote the bullets back exactly as this reply gives them — they are their own sentences, and rewording one while relaying it means they approve something they did not write. It never reports anything about their right to work, sponsorship or visa status, and never anything a voluntary survey asks, whatever the document says: those they type themselves. Call import_help if they have nothing to hand.",
  {
    upload_id: z.string().optional().describe("The id of a file they handed over in the chat"),
    text: z.string().optional().describe("The document's text, as they pasted it"),
  },
  async (args) =>
    guard(async () => {
      if (!args.text && !args.upload_id) throw new Error("Pass either text or upload_id.");
      const read: Document = args.upload_id
        ? documentForUpload(args.upload_id)
        : { kind: "text", text: args.text!, source: "pasted", origin: "" };
      const proposed = await proposeFrom(read);
      return {
        import_id: proposed.id,
        source: proposed.source,
        found: outline(proposed.proposal),
        note:
          "Nothing is stored yet, and this is a count rather than the contents — do not read it out. Say in one " +
          "sentence what you found (how many jobs, how far back, whether there is education and skills) and apply " +
          "it with apply_import. They will see the detail on their profile, in place, which is better than a list " +
          "in a chat window. The things the reader could not settle are queued when you apply, and you ask about " +
          "those one at a time with next_question afterwards.",
      };
    }),
);

const applyImportTool = tool(
  "apply_import",
  "Store what they accepted from a document you read with import_profile. Pass the import id, and name what they wanted: leave a list out to take all of that kind, pass an empty list to take none. Roles go down to the bullet — {\"index\": 1, \"bullets\": [0, 4]} keeps that role with only those two of its lines, and a bare number keeps the role whole. Use that rather than importing filler and deleting it afterwards: an export often puts a company's About text or its sales copy under a job, and those are not things the person did. Say which lines you are leaving out and why, and let them disagree before you call this. The text that lands is copied from what was read, never from this call, so you can choose which of their sentences to keep but you cannot change one — if a line is wrong rather than unwanted, import it and they can edit it on their profile page.",
  {
    import_id: z.number().int(),
    profile: z.boolean().optional().describe("False to leave their contact details alone"),
    summary: z.boolean().optional().describe("False to leave their About text out"),
    roles: z
      .array(
        z.union([
          z.number().int(),
          z.object({
            index: z.number().int(),
            bullets: z
              .array(z.number().int())
              .optional()
              .describe("Which of that role's bullets to keep, by number. Omit for all."),
          }),
        ]),
      )
      .optional()
      .describe("The roles to keep, whole or by bullet"),
    education: z.array(z.number().int()).optional(),
    skills: z.array(z.number().int()).optional(),
    facts: z.array(z.number().int()).optional().describe("Indexes of the answers to put on file"),
  },
  async (args) =>
    guard(async () => {
      const applied = await applyImport(args.import_id, {
        ...(args.profile !== undefined ? { profile: args.profile } : {}),
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...(args.roles ? { roles: args.roles } : {}),
        ...(args.education ? { education: args.education } : {}),
        ...(args.skills ? { skills: args.skills } : {}),
        ...(args.facts ? { facts: args.facts } : {}),
      });
      return {
        applied,
        note:
          `Stored. Say in one short sentence what went in${applied.to_ask ? "" : "."}` +
          (applied.to_ask
            ? `, then call next_question and ask them about the first of the ${applied.to_ask} things the reader could not settle. One at a time: do not list them, do not preview them, and do not ask what they would like to go through.`
            : " Then call next_question in case there is anything else worth asking about."),
      };
    }),
);

const importHelpTool = tool(
  "import_help",
  "How the person can get their career history out of LinkedIn, and which way is best. Use it when they have no profile yet, when they ask how to start, or when they ask about LinkedIn: give them the first route's steps in your own words, one message, and say the zip can be handed over as it arrives. This app does not read their LinkedIn page itself — LinkedIn forbids automated access and the cost of being wrong is their account — so if they ask why they are doing the exporting, say that plainly rather than apologising for it.",
  {},
  async () => guard(async () => importHelp()),
  { annotations: { readOnlyHint: true } },
);

const proposeEditTool = tool(
  "propose_edit",
  "Put one change to their profile in front of them, on the thing it would change. The page brings the profile forward, scrolls to that row and paints the question over it; nothing is stored until they keep it, and what gets stored is whatever is in the box at that moment. Use this instead of listing what you would change — ask about one thing, propose it, and wait. There is one slot, so a proposal about something else while one is waiting returns the waiting one instead, which means finish that one first. A better version of the line already in the box is not something else: propose it the same way and it replaces what is there, keeping the same question. That is the right move when they ask you to improve what they are looking at. Write the value. If they ask you to improve a line, propose an improved line rather than a list of changes you would make; drafting is safe here because the proposal is not stored — they read it in the box, edit it there, and press Keep. What you may not add is substance: a figure, a date, an employer, a result or anything else that is in neither the profile nor what they just said, however much better it would read. Reword freely, invent nothing, and keep every figure exactly as stored. If the line needs a fact you do not have, propose your best version from what is on file and ask for the fact beside it. Say in `why`, in one line, what this is and where it came from; it is shown with the question.",
  {
    target: z
      .enum(["profile", "role", "bullet", "fact", "education"])
      .describe("profile for their contact details, role for a job, bullet for one line under a job, education for a degree, fact for a stored answer"),
    field: z
      .string()
      .describe(
        "profile: name, headline, email, phone, location, summary. role: company, title, location, start_date, end_date. bullet: text. education: school, degree, field, start_date, end_date. fact: answer.",
      ),
    value: z
      .string()
      .describe(
        "What would be stored, in their words. Leave empty when removing, and when the action is ask.",
      ),
    why: z.string().describe("One line, shown with the question"),
    target_id: z
      .number()
      .int()
      .optional()
      .describe("The role's or bullet's id, from the profile. Required for those."),
    target_key: z
      .string()
      .optional()
      .describe("The fact's topic, such as notice_period. Required for a fact."),
    question_id: z
      .number()
      .int()
      .optional()
      .describe("The queued question this answers, from next_question. It is settled when they reply."),
    action: z
      .enum(["set", "delete", "ask", "add"])
      .optional()
      .describe(
        "set is the default and suggests a value for something already stored. delete removes the role, bullet or fact — use it for a line that is not an achievement, a company's sales copy among their work. ask suggests nothing: it highlights the thing and puts your question over it with the stored text in the box, for a question you cannot answer for them, such as two roles whose dates overlap. add offers a line that is NOT on their profile — the ones an import left out — as a new bullet under a role: pass target \"bullet\", field \"text\", the line in value, and target_id set to the ROLE it would go under. Every one of these puts the question on the thing it is about; asking in the conversation alone leaves them reading about a line they cannot see.",
      ),
    recommend: z
      .enum(["use", "leave", "drop"])
      .describe(
        "Which answer you recommend. The card highlights it, so say what you actually think rather than what the card happens to do: use means take the text in the box, leave means change nothing, drop removes the row — offered only for a role, bullet, fact or degree that exists. A card about a line you judge not worth keeping should recommend drop, and an added line you are only offering so they can overrule an import should recommend leave. These three are all a card can do; if the answer you wanted is not among them, give the card your nearest recommendation and call wish_for_answer to say what you would rather have had.",
      ),
  },
  async (args) =>
    guard(async () => {
      const { pending, waiting, withdrawn } = await proposeEdit({
        target: args.target,
        field: args.field,
        value: args.value,
        why: args.why,
        recommend: args.recommend,
        ...(args.target_id !== undefined ? { target_id: args.target_id } : {}),
        ...(args.target_key !== undefined ? { target_key: args.target_key } : {}),
        ...(args.action !== undefined ? { action: args.action } : {}),
        ...(args.question_id !== undefined ? { question_id: args.question_id } : {}),
      });
      return waiting
        ? {
            already_waiting: waiting,
            note: `They have not answered the proposal for "${waiting.field}" yet. Ask about that one, and propose this after they have.`,
          }
        : {
            proposed: pending,
            note: "It is on their screen now, on the row it would change. Say what you are asking in one short line and stop — do not propose anything else, and do not ask a second question in the same message. They will keep it, edit it, or skip it, and you will be told which.",
            /*
              The proposal before this one went without an answer. The
              assistant could not see that before, so it read its own card
              going as the app losing an answer and filed a bug report.
            */
            ...(withdrawn
              ? {
                  previous_proposal_withdrawn: withdrawn,
                  withdrawn_note: `Your earlier proposal for "${withdrawn.field}" was taken off their screen without being answered, and not by you. Nothing was stored and no answer was lost, so the app did not fail. Do not tell them it did, and do not report it as a fault; if the question still matters, this new card is how to ask it again.`,
                }
              : {}),
          };
    }),
);

const nextQuestionTool = tool(
  "next_question",
  "The next thing worth asking them about their profile, one at a time. It comes from what a document you read could not settle, then the gaps in their profile, then the questions real employers asked that nothing on file could answer — already ordered, so take what you are given rather than choosing. Read the note, ask them about it in one short line, and propose the change with propose_edit passing this question_id. When the question carries a `value`, that is the exact text to propose — pass it through word for word rather than retyping or summarising it, with action \"add\" when the question also names a target, which offers the line where it would go. If it needs no change, settle_question says so. Call this again only once the current one is answered. The reply says how many are left: offer to stop after a handful, because a profile filled in over two sittings is better than one abandoned in the middle of a long one.",
  {},
  async () =>
    guard(async () => {
      /*
        Taking a question is what makes this the thread that is asking, more
        than proposing is: the assistant often puts the question in words and
        waits for an answer before it proposes anything, and somebody who
        clicks Continue in between should be taken back to here.
      */
      await noteAsking();
      const waiting = await nextQuestion();
      return waiting.question
        ? {
            ...waiting,
            note: "Ask about this one thing, in one short line, and propose it with propose_edit and this question_id. Do not read the rest of the list out.",
          }
        : { ...waiting, note: "Nothing is waiting. Say so and let them get on with applying for things." };
    }),
  { annotations: { readOnlyHint: true } },
);

const settleQuestionTool = tool(
  "settle_question",
  "Mark a queued question as dealt with when it ends in no change — they said it is fine as it is, or it turned out not to apply. A question answered by an edit settles itself when they keep or skip it, so do not call this as well. Say what the outcome was in a few words; it is kept so the same thing is not asked again.",
  {
    question_id: z.number().int(),
    outcome: z.string().describe("A few words: what they decided"),
  },
  async (args) =>
    guard(async () => {
      const settled = await settleQuestion(args.question_id, args.outcome);
      const waiting = await nextQuestion();
      return settled
        ? { settled: true, left: waiting.left }
        : { settled: false, note: "That one was already dealt with. Call next_question." };
    }),
);

const stopAskingTool = tool(
  "stop_asking",
  "Put the rest of the questions away when they have had enough for now, or say they want to get on with something else. Everything still waiting is marked as left for another time. Offer this yourself after a handful rather than working through a long list — and use it the moment they sound finished, rather than asking one more.",
  {},
  async () =>
    guard(async () => {
      const put = await clearQueue();
      return {
        put_away: put,
        note: "Say that is fine and that the rest can wait. Do not list what was left.",
      };
    }),
);

const pendingEditTool = tool(
  "pending_edit",
  "What you are currently asking them to decide, if anything. Useful when a conversation resumes and you are not sure whether something is still waiting on their screen.",
  {},
  async () =>
    guard(async () => {
      const [waiting, withdrawn] = await Promise.all([pendingEdit(), withdrawnEdit()]);
      if (waiting) {
        return {
          waiting,
          note: "This is on their screen. Ask about it rather than proposing something else.",
        };
      }
      /*
        Nothing waiting has two causes that used to look alike: they answered
        it, or it was taken away unanswered. Only the first reaches the
        assistant as a message, so the second is said here.
      */
      return withdrawn
        ? {
            waiting: null,
            withdrawn,
            note: `Nothing is waiting. Your proposal for "${withdrawn.field}" was taken off their screen without being answered, and not by you — nothing was stored, and no answer went missing, so this is not a fault to report. You may propose one change.`,
          }
        : {
            waiting: null,
            note: "Nothing is waiting, and your last proposal was either answered or withdrawn by you. You may propose one change.",
          };
    }),
  { annotations: { readOnlyHint: true } },
);

const withdrawEditTool = tool(
  "withdraw_edit",
  "Take back what you proposed without them answering it. Use it when the conversation has moved on, or when they have said no in passing. You do not need it to revise your own proposal: propose the better version of the same field and it replaces what is in the box.",
  {},
  async () =>
    guard(async () => {
      await clearEdit("assistant");
      return { withdrawn: true, note: "Taken off their screen. You may propose one change." };
    }),
);

const wishForAnswerTool = tool(
  "wish_for_answer",
  "Say that a card needed an answer it does not have. A card can only do three things — take the text in the box, change nothing, or remove the row — because the server has to carry the answer out and because what a button does must never come out of a document you read. When the case in front of you wanted something else (splitting one line into two, merging two roles, marking a date unknown rather than guessing it), propose the card with your nearest recommendation anyway, then call this to say what you would rather have had. It changes nothing on their screen: it is recorded for whoever decides what the next answer type is, and it is their decision, not yours. Say what the answer would be called, what it is for, what you would have done with it on the card in front of you, and what should be true once it is done — that last part is the test somebody will write when they build it, so make it checkable. The card itself is kept with the want; you do not need to describe it. If somebody has already asked for the same thing it gets another vote rather than a second entry, so describe what you want plainly and let the matching sort it out. Do not tell them you did this, and do not use it in place of asking them something you could simply ask.",
  {
    name: z.string().describe("What the answer would be called, as a button label"),
    why: z.string().describe("One line: what it would do, and the case that wanted it"),
    wanted: z
      .string()
      .describe(
        "What you would have done to the thing on the card, had the answer existed. Be specific about this one: 'split it after the first sentence, leaving two lines under the same role', not 'split it'.",
      ),
    expect: z
      .string()
      .describe(
        "What should be true once it is carried out — the test this case is waiting for. 'That role has two lines where it had one, both of them theirs, and neither mentions the architecture twice.' Write it as something somebody could check, not as a hope.",
      ),
  },
  async (args) =>
    guard(async () => {
      const { wish, voted, withCase } = await wishForAnswer(args.name, args.why, {
        wanted: args.wanted,
        expect: args.expect,
      });
      return {
        recorded: wish,
        note: `${
          voted
            ? `Somebody has wanted that before; it is now at ${wish.votes} votes.`
            : "Noted as a new one."
        }${
          withCase
            ? " The card you were looking at was kept with it as a case."
            : " No card was waiting, so there is no case with it — only the want."
        } Carry on with the card as it is.`,
      };
    }),
);

const reportBugTool = tool(
  "report_bug",
  "File a fault in this app, when it does not do what it says it does. Use it when something you did through a tool did not take, when what is on their screen does not match what you were told, when a card you put up came back unanswered without them answering it, when the same step fails twice. File it AND carry on serving the person — work round it, do the thing by hand, say plainly what you could not do — because a report is for later and they are here now. Write the three things only you know: what you were doing, what you expected, what happened instead. Do not describe the state of the app; it is read off the server as you file and attached for you, which is the part a report needs to be reproducible and the part you would have to guess at. A fault reported twice is one report that has happened twice, so file it as you see it rather than hunting for an earlier wording. This is not for a person's mistake, for something you decided not to do, or for an answer you did not like — only for the app behaving other than as built.",
  {
    title: z.string().describe("One line naming the fault, as a heading"),
    doing: z.string().describe("What you were doing when it happened"),
    expected: z.string().describe("What you expected to happen"),
    happened: z.string().describe("What happened instead, in as much detail as you have"),
  },
  async (args) =>
    guard(async () => {
      const { bug, again } = await reportBug(args);
      return {
        filed: { id: bug.id, title: bug.title, hits: bug.hits },
        note: `${
          again
            ? `That has been reported before; it is now at ${bug.hits}.`
            : "Filed."
        } The state of the app was attached. Carry on with what they asked, working round it if you can, and tell them plainly what you could not do — do not read this report out to them.`,
      };
    }),
);

const whatIsMissingTool = tool(
  "what_is_missing",
  "What the profile still has nothing for, and what real application forms have asked that nothing on file could answer. Use it when someone asks what to fill in next, after an import, or when an application is held up by a question they have not answered before. The `asked` list is the useful one: those are questions employers actually put to them, with the employer's own questions filtered out, and each comes with a topic name and a wording — ask them one at a time, in their own words, and store each answer with set_standing_answer as it comes. Do not read the whole list out at once.",
  {},
  async () => guard(async () => await whatIsMissing()),
  { annotations: { readOnlyHint: true } },
);

const applicationRecordTool = tool(
  "application_record",
  "What went on a job's application form, as it was filled in. Self-identification fields show as answered without their values.",
  { job_id: z.number().int() },
  async (args) => guard(async () => ({ answers: await listAnswers(args.job_id) })),
  { annotations: { readOnlyHint: true } },
);

const markAppliedTool = tool(
  "mark_applied",
  "Record that the person has sent the application. Only on their word: nothing here can see a submitted form, and the app never presses the button, so asking them and believing them is the honest version. Moves the job to 'applied', stamps the date, and freezes what was put on the form.",
  { job_id: z.number().int() },
  async (args) => guard(async () => await markApplied(args.job_id)),
);

const coverageTool = tool(
  "application_coverage",
  "What a job's application asks for, and how much of it is already answerable: identity and links from the profile, documents from the resume and letter this app writes, situation questions from the standing answers, self-identification from what the person stored. Answers with the fields that nothing can answer yet — which is the list worth putting to them before they start, and worth comparing across a shortlist. Self-identification is never listed as outstanding: leaving it blank is a complete answer.",
  { job_id: z.number().int() },
  async (args) =>
    guard(async () => {
      const form = await formForJob(args.job_id);
      return { ats: form.ats, url: form.url, ...(await coverage(form)) };
    }),
  { annotations: { readOnlyHint: true } },
);

const matchBarTool = tool(
  "set_match_bar",
  "Set how good a match a posting must be to be stored when a board is synced. Scores run 0-65, and the bar starts at 50. Raise it when the list is full of roles they would not read; lower it when a board they follow is contributing almost nothing. This changes what comes in from the next sync onward — it never removes a posting already stored. Say what the new bar is and that it takes effect on the next sync.",
  {
    score: z.number().int().min(0).max(65).describe("The score a posting must reach, 0 to 65"),
  },
  async (args) =>
    guard(async () => ({
      bar: await setMatchBar(args.score),
      note: "Applies from the next sync. Postings already stored are untouched.",
    })),
);

const getMatchBarTool = tool(
  "get_match_bar",
  "The score a posting must reach to be stored when a board is synced.",
  {},
  async () => guard(async () => ({ bar: await matchBar() })),
  { annotations: { readOnlyHint: true } },
);

const syncBoardsTool = tool(
  "sync_boards",
  "Fetch the current postings from the company boards and store the ones worth this person's attention. A board is the company's list, not theirs: postings outside the places they work, or scoring below the relevance bar, are not stored at all. Returns, per board, how many were seen, how many were kept and how many are new — and a note when the filter could not be applied. Run this before searching when the user wants fresh results.",
  {
    companies: z
      .array(z.string())
      .optional()
      .describe("Limit the sync to these company names. Omit to sync every active board."),
  },
  async (args) => guard(async () => await syncBoards(args.companies)),
);

const rankJobs = tool(
  "rank_jobs",
  "Score every stored posting against the profile by keyword overlap, so the list has an order that means something. This is arithmetic, not judgement: use it to decide which postings are worth reading, then read them and use assess_job for a real opinion. Run it after a sync, or after the profile changes.",
  {},
  async () => guard(async () => await rankAllJobs()),
);

const assessTop = tool(
  "assess_top_jobs",
  `Read and score the best-matching postings that have not been judged yet, on a cheaper model (${ASSESS_MODEL}). Use this to turn a keyword-ranked list into real opinions — it costs a few cents for twenty and takes a minute or so. Judge a single posting yourself with get_job and assess_job instead.`,
  {
    limit: z.number().int().min(1).max(50).optional().describe("How many to assess. Default 20."),
    location_any: z
      .array(z.string())
      .optional()
      .describe("Cities to stay within. Omit for where the person lives; [\"anywhere\"] for no limit."),
    include_remote: z.boolean().optional().describe("Also judge remote postings based elsewhere"),
  },
  async (args) =>
    guard(async () => {
      const places = await resolvePlaces(args.location_any);
      return await assessTopJobs({
        limit: args.limit ?? 20,
        location: places === undefined ? "" : places.join(","),
        includeRemote: args.include_remote ?? false,
      });
    }),
);

const searchJobs = tool(
  "search_jobs",
  "Search stored postings. All filters are optional and combine with AND; the lists inside one filter combine with OR. Results come back highest fit score first, so assessed_only with no other filter lists everything you have scored. Returns summaries without the posting body — call get_job for the full text.",
  {
    title_any: z.array(z.string()).optional().describe("Match if the title contains any of these"),
    title_none: z.array(z.string()).optional().describe("Exclude if the title contains any of these"),
    text_any: z.array(z.string()).optional().describe("Match if the title or body contains any of these"),
    text_none: z.array(z.string()).optional().describe("Exclude if the title or body contains any of these"),
    company_any: z.array(z.string()).optional().describe("Limit to these companies"),
    location_any: z
      .array(z.string())
      .optional()
      .describe(
        "Cities to accept, for example [\"New York\"]. Short forms boards use are matched for you. Omit to use where the person lives; pass [\"anywhere\"] to drop the location filter entirely.",
      ),
    include_remote: z
      .boolean()
      .optional()
      .describe(
        "Also accept remote postings based in other cities. The person is not assumed to be open to this; ask if you do not know.",
      ),
    remote_only: z.boolean().optional().describe("Only postings marked remote"),
    status_any: z.array(z.enum(STATUSES)).optional().describe("Only jobs tracked at these statuses"),
    untracked_only: z.boolean().optional().describe("Only jobs with no application row yet"),
    unassessed_only: z
      .boolean()
      .optional()
      .describe("Only postings you have not scored yet"),
    assessed_only: z
      .boolean()
      .optional()
      .describe("Only jobs you have already scored with assess_job"),
    min_match_score: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("Only postings whose keyword match with the profile is at least this"),
    min_fit_score: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("Only jobs scored at or above this. Results always come back highest score first."),
    new_since: z.string().optional().describe("Only jobs first seen on or after this date, as YYYY-MM-DD"),
    limit: z.number().int().min(1).max(200).optional().describe("How many to return. Default 50."),
  },
  async (args) =>
    guard(async () => {
      const jobs = await repo.searchJobs({
        titleAny: args.title_any,
        titleNone: args.title_none,
        textAny: args.text_any,
        textNone: args.text_none,
        companyAny: args.company_any,
        locationAny: await resolvePlaces(args.location_any),
        includeRemote: args.include_remote ?? false,
        remoteOnly: args.remote_only,
        statusAny: args.status_any,
        untrackedOnly: args.untracked_only,
        assessedOnly: args.assessed_only,
        unassessedOnly: args.unassessed_only,
        minFitScore: args.min_fit_score,
        minMatchScore: args.min_match_score,
        newSince: args.new_since,
        limit: args.limit,
      });
      return { count: jobs.length, jobs: jobs.map(summarise) };
    }),
  { annotations: { readOnlyHint: true } },
);

const getJob = tool(
  "get_job",
  "Read one posting in full, including the body text and any status history.",
  { job_id: z.number().int().describe("The job id from search_jobs") },
  async (args) =>
    guard(async () => {
      const job = await repo.getJob(args.job_id);
      if (!job) throw new Error(`No job with id ${args.job_id}`);
      return {
        ...summarise(job),
        reasoning: job.reasoning,
        description: truncate(job.description, 12000),
        history: repo.applicationHistory(job.id),
      };
    }),
  { annotations: { readOnlyHint: true } },
);

const assessJob = tool(
  "assess_job",
  "Record your judgement of how well a posting fits the user. Use this after reading a posting so the score survives the conversation.",
  {
    job_id: z.number().int(),
    fit_score: z.number().int().min(0).max(100).describe("0 = no fit, 100 = ideal fit"),
    reasoning: z.string().describe("Two or three sentences on why, naming the concrete evidence"),
  },
  async (args) =>
    guard(async () => {
      await repo.saveAssessment(args.job_id, args.fit_score, args.reasoning);
      return { job_id: args.job_id, fit_score: args.fit_score };
    }),
);

const trackJob = tool(
  "track_job",
  "Start tracking a job as an application, at status 'interested'. Idempotent.",
  { job_id: z.number().int(), note: z.string().optional() },
  async (args) => guard(async () => await repo.trackJob(args.job_id, args.note)),
);

const setStatus = tool(
  "set_status",
  "Move a tracked application to a new status. The status machine rejects a move it does not allow and tells you which moves are allowed.",
  {
    job_id: z.number().int(),
    status: z.enum(STATUSES),
    note: z.string().optional().describe("Why the status changed. Stored in the history."),
  },
  async (args) => guard(async () => await repo.setStatus(args.job_id, args.status, args.note)),
  { annotations: { destructiveHint: true } },
);

const listApplications = tool(
  "list_applications",
  "List tracked applications, newest change first.",
  { status_any: z.array(z.enum(STATUSES)).optional().describe("Limit to these statuses") },
  async (args) => guard(async () => await repo.listApplications(args.status_any)),
  { annotations: { readOnlyHint: true } },
);

const getStats = tool(
  "get_stats",
  "Count the stored postings and the applications at each status.",
  {},
  async () =>
    guard(async () => ({ ...(await repo.stats()), sources: Object.keys(SOURCES) })),
  { annotations: { readOnlyHint: true } },
);


/**
 * What is on the person's screen.
 *
 * Cheap, and it removes most of the reason to open a browser. "Make this one
 * warmer" and "why is this ranked so low" both resolve from here, where
 * otherwise they need a screenshot read back.
 *
 * It says when it does not know. A confident answer about the wrong resume
 * is worse than asking which one.
 */
const appState = tool(
  "app_state",
  "What the person currently has open in the app: which tab, and what is selected in it. Call this before acting on 'this one', 'that posting' or 'the current resume' instead of guessing or taking a screenshot. It reports honestly when the app is closed or has not said recently.",
  {},
  async () => guard(async () => currentState()),
  { annotations: { readOnlyHint: true } },
);

export const jobsearchServer = createSdkMcpServer({
  name: "jobsearch",
  version: "0.1.0",
  tools: [
    appState,
    listCompanies,
    removeCompanyTool,
    getInterestsTool,
    setInterestsTool,
    evaluateCompaniesTool,
    addCompany,
    addCompaniesByName,
    syncBoardsTool,
    importPostingTool,
    applicationFormTool,
    startApplicationTool,
    fillApplicationTool,
    recordAnswerTool,
    importProfileTool,
    importHelpTool,
    applyImportTool,
    whatIsMissingTool,
    proposeEditTool,
    nextQuestionTool,
    settleQuestionTool,
    stopAskingTool,
    pendingEditTool,
    withdrawEditTool,
    wishForAnswerTool,
    reportBugTool,
    applicationRecordTool,
    markAppliedTool,
    coverageTool,
    standingAnswersTool,
    setStandingAnswerTool,
    selfIdStatusTool,
    voluntaryAnswersTool,
    matchBarTool,
    getMatchBarTool,
    rankJobs,
    assessTop,
    searchJobs,
    getJob,
    assessJob,
    trackJob,
    setStatus,
    listApplications,
    getStats,
    ...profileTools,
    ...(browserEnabled ? browserTools : []),
  ],
});

/** Tools whose results change the stored data, so the UI should refetch. */
export const MUTATING_TOOLS = new Set([
  "mcp__jobsearch__add_company",
  "mcp__jobsearch__add_companies",
  "mcp__jobsearch__remove_company",
  "mcp__jobsearch__set_interests",
  "mcp__jobsearch__sync_boards",
  "mcp__jobsearch__rank_jobs",
  "mcp__jobsearch__assess_top_jobs",
  "mcp__jobsearch__assess_job",
  "mcp__jobsearch__track_job",
  "mcp__jobsearch__set_status",
  ...PROFILE_MUTATING,
]);

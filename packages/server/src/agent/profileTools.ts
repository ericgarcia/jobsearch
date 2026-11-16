import { tool } from "@anthropic-ai/claude-agent-sdk";
import { stylingGuide } from "@jobsearch/layout";
import { defaultLayout, getLayout, listLayouts, updateLayout } from "../layout/store.js";
import { measurePages } from "../layout/measure.js";
import { renderPdf, pdfFilename } from "../layout/pdf.js";
import { DATA_DIR } from "../config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { browserEnabled } from "./browserFlag.js";
import { z } from "zod";
import * as profile from "../profile.js";
import * as resume from "../resume.js";

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

/* ----------------------------------------------------------------- reading */

const getProfile = tool(
  "get_profile",
  "Read the whole stored profile: contact details, roles, the bullets under each role, education and skills. Every bullet carries the id you need to put it on a resume.",
  {},
  async () => guard(async () => await profile.fullProfile()),
  { annotations: { readOnlyHint: true } },
);

/* ----------------------------------------------------------------- writing */

const updateProfile = tool(
  "update_profile",
  "Update the person's contact details and headline. Only send the fields that change.",
  {
    name: z.string().optional(),
    headline: z.string().optional().describe("One line, for example 'Staff Backend Engineer'"),
    email: z.string().optional(),
    phone: z.string().optional(),
    location: z.string().optional(),
    summary: z.string().optional().describe("A short professional summary, in their own words"),
    links: z.array(z.string()).optional().describe("Profile URLs, for example GitHub or a site"),
  },
  async (args) =>
    guard(async () =>
      await profile.updateProfile({
        ...args,
        links: args.links ? JSON.stringify(args.links) : undefined,
      }),
    ),
);

const addRole = tool(
  "add_role",
  "Add a job the person has held. Add the role first, then its bullets.",
  {
    company: z.string(),
    title: z.string(),
    location: z.string().optional(),
    start_date: z.string().optional().describe("YYYY-MM, or YYYY if that is all you know"),
    end_date: z.string().optional().describe("YYYY-MM, or leave out if this is the current role"),
    summary: z.string().optional().describe("One line on what the role was"),
    sort_order: z.number().int().optional().describe("0 is the most recent role"),
  },
  async (args) => guard(async () => profile.addRole(args as never)),
);

const updateRole = tool(
  "update_role",
  "Change a stored role.",
  {
    role_id: z.number().int(),
    company: z.string().optional(),
    title: z.string().optional(),
    location: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    summary: z.string().optional(),
    sort_order: z.number().int().optional(),
  },
  async ({ role_id, ...patch }) => guard(async () => await profile.updateRole(role_id, patch)),
);

const deleteRole = tool(
  "delete_role",
  "Remove a role and every bullet under it. Ask the person before calling this.",
  { role_id: z.number().int() },
  async (args) => guard(async () => ({ removed: await profile.deleteRole(args.role_id) })),
  { annotations: { destructiveHint: true } },
);

const addBullet = tool(
  "add_bullet",
  "Record one achievement as a reusable fact. Write what actually happened, with the real figures. This is the only way a claim can ever reach a resume, so record it exactly as the person states it — never round up, never embellish.",
  {
    role_id: z.number().int().nullable().describe("The role this belongs to, or null if it stands alone"),
    text: z.string().describe("One concrete achievement, in the person's own terms"),
    skills: z.array(z.string()).optional().describe("Skills this evidences, for matching later"),
  },
  async (args) => guard(async () => await profile.addBullet(args.role_id, args.text, args.skills ?? [])),
);

const updateBullet = tool(
  "update_bullet",
  "Correct a stored fact. Use this when the person tells you a figure or detail is wrong.",
  {
    bullet_id: z.number().int(),
    text: z.string().optional(),
    skills: z.array(z.string()).optional(),
  },
  async (args) => guard(async () => await profile.updateBullet(args.bullet_id, args.text, args.skills)),
);

const deleteBullet = tool(
  "delete_bullet",
  "Remove a stored fact. Ask the person before calling this.",
  { bullet_id: z.number().int() },
  async (args) => guard(async () => ({ removed: await profile.deleteBullet(args.bullet_id) })),
  { annotations: { destructiveHint: true } },
);

const addEducation = tool(
  "add_education",
  "Add a school, degree or qualification.",
  {
    school: z.string(),
    degree: z.string().optional(),
    field: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    note: z.string().optional(),
  },
  async (args) => guard(async () => await profile.addEducation(args as never)),
);

const addSkill = tool(
  "add_skill",
  "Add a skill. Calling it again with the same name updates it.",
  {
    name: z.string(),
    category: z.string().optional().describe("For example 'languages' or 'infrastructure'"),
    years: z.number().int().optional(),
  },
  async (args) => guard(async () => await profile.addSkill(args.name, args.category, args.years)),
);

/* ---------------------------------------------------------------- tailoring */

const draftResume = tool(
  "draft_resume",
  "Assemble a resume tailored to a posting. You choose which stored bullets to include, in which order, and may reword each one for the posting. You cannot write a line from nothing: every line names a bullet id from get_profile. If the person mentions an achievement that is not stored yet, call add_bullet first, then include it here. Reworded lines are checked against the stored fact and any mismatch is returned as a warning.",
  {
    job_id: z.number().int().nullable().describe("The posting this targets, or null for a base resume"),
    label: z.string().optional().describe("A short name for this draft"),
    summary: z.string().optional().describe("A summary paragraph written for this posting"),
    lines: z
      .array(
        z.object({
          bullet_id: z.number().int().describe("A bullet id from get_profile"),
          rendered_text: z
            .string()
            .optional()
            .describe(
              "The bullet reworded for this posting. Keep every figure exactly as the stored fact has it. Omit to use the stored wording.",
            ),
        }),
      )
      .min(1)
      .describe("The lines, in the order they should appear"),
  },
  async (args) =>
    guard(async () => {
      const result = await resume.draftResume({
        jobId: args.job_id,
        label: args.label,
        summary: args.summary,
        lines: args.lines,
      });
      return {
        ...result,
        note:
          result.warnings.length > 0
            ? "Some figures do not match the stored facts. Tell the person which, and correct them."
            : "Every figure matches the stored facts.",
      };
    }),
);

const getResume = tool(
  "get_resume",
  "Read a drafted resume: every line, the fact it came from, and any warning.",
  { resume_id: z.number().int() },
  async (args) => guard(async () => await resume.getResume(args.resume_id)),
  { annotations: { readOnlyHint: true } },
);

const listResumes = tool(
  "list_resumes",
  "List drafted resumes, newest first.",
  { job_id: z.number().int().optional().describe("Limit to drafts for this posting") },
  async (args) => guard(async () => await resume.listResumes(args.job_id)),
  { annotations: { readOnlyHint: true } },
);

const renderResume = tool(
  "render_resume",
  "Render a drafted resume as Markdown, ready to show the person or export.",
  { resume_id: z.number().int() },
  async (args) => guard(async () => ({ markdown: await resume.renderMarkdown(args.resume_id) })),
  { annotations: { readOnlyHint: true } },
);

const draftCoverLetter = tool(
  "draft_cover_letter",
  "Save a cover letter for a posting. Write only what the profile supports: no employer, achievement or figure that is not stored. The text is checked against the profile and any unsupported figure is returned as a warning.",
  {
    job_id: z.number().int(),
    body: z.string().describe("The letter itself, ready to send"),
  },
  async (args) => guard(async () => await resume.saveCoverLetter(args.job_id, args.body)),
);


/* ------------------------------------------------------------- styling */

const stylingGuideTool = tool(
  "styling_guide",
  "How to style the profile and the resume: every token, what it accepts, what it does, and the section list. Read this before changing a layout.",
  {},
  async () => guard(async () => stylingGuide()),
  { annotations: { readOnlyHint: true } },
);

const getLayoutTool = tool(
  "get_layout",
  "The current layout for a surface: its sections in order, which are hidden, and the tokens set on it. Read before changing anything — some of it may be deliberate.",
  { surface: z.enum(["profile", "resume"]) },
  async (args) => guard(async () => defaultLayout(args.surface)),
  { annotations: { readOnlyHint: true } },
);

const styleLayoutTool = tool(
  "style_layout",
  "Set design tokens on a layout. Merges with what is there, so send only what changes; an empty string puts a token back to its default. A refused value says which token and why — correct it rather than trying another spelling.",
  {
    surface: z.enum(["profile", "resume"]),
    tokens: z.record(z.string(), z.string()).describe('For example {"accent": "#2b3a55", "density": "0.9"}'),
  },
  async (args) =>
    guard(async () => {
      const layout = await defaultLayout(args.surface);
      return updateLayout(layout.id, { tokens: args.tokens });
    }),
);

const arrangeLayoutTool = tool(
  "arrange_layout",
  "Set which sections appear, in which order, with what heading. Send the whole list: its order is the order on the page. A hidden section keeps its place for when it comes back.",
  {
    surface: z.enum(["profile", "resume"]),
    sections: z.array(
      z.object({
        kind: z.string(),
        visible: z.boolean().optional(),
        heading: z.string().nullable().optional(),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
  },
  async (args) =>
    guard(async () => {
      const layout = await defaultLayout(args.surface);
      return updateLayout(layout.id, { spec: { sections: args.sections } });
    }),
);

const previewLayoutTool = tool(
  "preview_layout",
  "What a surface currently looks like: the sections shown, the tokens set, and — for a resume, when the browser is on — how many letter pages it comes to and how full the last one is. Check this after styling rather than assuming. A resume that grew to three pages is a worse answer than the two-page one it replaced.",
  { surface: z.enum(["profile", "resume"]), resume_id: z.number().optional() },
  async (args) =>
    guard(async () => {
      const layout = await defaultLayout(args.surface);
      const query = args.resume_id ? `?resume=${args.resume_id}` : "";
      const url = `/api/render/${args.surface}${query}`;

      const base = {
        layout: { id: layout.id, name: layout.name, tokens: layout.tokens },
        sections: layout.spec.sections.filter((s) => s.visible).map((s) => s.kind),
        url: `${url}${args.surface === "resume" ? (query ? "&" : "?") + "paged=1" : ""}`,
      };

      if (args.surface !== "resume") return base;
      if (!browserEnabled) {
        return { ...base, pages: null, note: "The browser is off, so the page count cannot be measured." };
      }

      /*
        Measured rather than estimated, and a failure to measure is reported
        rather than swallowed: "I could not check" is useful, and a made-up
        page count is worse than none.
      */
      try {
        const measured = await measurePages(`${url}${query ? "&" : "?"}paged=1`);
        return {
          ...base,
          pages: measured.pages,
          last_page_fill: measured.lastPageFill,
          note:
            measured.lastPageFill > 0.9
              ? "The last page is nearly full; a small addition will spill onto another."
              : measured.lastPageFill < 0.25 && measured.pages > 1
                ? "The last page holds very little. Tightening density or cutting a bullet may save a page."
                : undefined,
        };
      } catch (error) {
        return { ...base, pages: null, note: `Could not measure: ${(error as Error).message}` };
      }
    }),
  { annotations: { readOnlyHint: true } },
);


const exportPdfTool = tool(
  "export_resume_pdf",
  "Write the resume to a PDF file and say where it is. Give resume_id to export a tailored draft; without one it exports the stored profile through the resume template. The file holds real text, not a picture, because an applicant tracking system reads it before a person does.",
  { resume_id: z.number().optional() },
  async (args) =>
    guard(async () => {
      const [pdf, me] = await Promise.all([
        renderPdf({ resumeId: args.resume_id ?? null }),
        profile.getProfile(),
      ]);

      // Beside the database rather than in the repository: a resume is
      // personal, and the repository is public.
      const directory = path.join(DATA_DIR, "resumes");
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, pdfFilename(me.name, args.resume_id ? `draft ${args.resume_id}` : null));
      await fs.writeFile(file, pdf);

      return { file, bytes: pdf.length };
    }),
);

export const profileTools = [
  exportPdfTool,
  stylingGuideTool,
  getLayoutTool,
  styleLayoutTool,
  arrangeLayoutTool,
  previewLayoutTool,
  getProfile,
  updateProfile,
  addRole,
  updateRole,
  deleteRole,
  addBullet,
  updateBullet,
  deleteBullet,
  addEducation,
  addSkill,
  draftResume,
  getResume,
  listResumes,
  renderResume,
  draftCoverLetter,
];

export const PROFILE_MUTATING = [
  "export_resume_pdf",
  "style_layout",
  "arrange_layout",
  "update_profile",
  "add_role",
  "update_role",
  "delete_role",
  "add_bullet",
  "update_bullet",
  "delete_bullet",
  "add_education",
  "add_skill",
  "draft_resume",
  "draft_cover_letter",
].map((name) => `mcp__jobsearch__${name}`);

import { tool } from "@anthropic-ai/claude-agent-sdk";
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
  async () => guard(() => profile.fullProfile()),
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
    guard(() =>
      profile.updateProfile({
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
  async (args) => guard(() => profile.addRole(args as never)),
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
  async ({ role_id, ...patch }) => guard(() => profile.updateRole(role_id, patch)),
);

const deleteRole = tool(
  "delete_role",
  "Remove a role and every bullet under it. Ask the person before calling this.",
  { role_id: z.number().int() },
  async (args) => guard(() => ({ removed: profile.deleteRole(args.role_id) })),
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
  async (args) => guard(() => profile.addBullet(args.role_id, args.text, args.skills ?? [])),
);

const updateBullet = tool(
  "update_bullet",
  "Correct a stored fact. Use this when the person tells you a figure or detail is wrong.",
  {
    bullet_id: z.number().int(),
    text: z.string().optional(),
    skills: z.array(z.string()).optional(),
  },
  async (args) => guard(() => profile.updateBullet(args.bullet_id, args.text, args.skills)),
);

const deleteBullet = tool(
  "delete_bullet",
  "Remove a stored fact. Ask the person before calling this.",
  { bullet_id: z.number().int() },
  async (args) => guard(() => ({ removed: profile.deleteBullet(args.bullet_id) })),
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
  async (args) => guard(() => profile.addEducation(args as never)),
);

const addSkill = tool(
  "add_skill",
  "Add a skill. Calling it again with the same name updates it.",
  {
    name: z.string(),
    category: z.string().optional().describe("For example 'languages' or 'infrastructure'"),
    years: z.number().int().optional(),
  },
  async (args) => guard(() => profile.addSkill(args.name, args.category, args.years)),
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
    guard(() => {
      const result = resume.draftResume({
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
  async (args) => guard(() => resume.getResume(args.resume_id)),
  { annotations: { readOnlyHint: true } },
);

const listResumes = tool(
  "list_resumes",
  "List drafted resumes, newest first.",
  { job_id: z.number().int().optional().describe("Limit to drafts for this posting") },
  async (args) => guard(() => resume.listResumes(args.job_id)),
  { annotations: { readOnlyHint: true } },
);

const renderResume = tool(
  "render_resume",
  "Render a drafted resume as Markdown, ready to show the person or export.",
  { resume_id: z.number().int() },
  async (args) => guard(() => ({ markdown: resume.renderMarkdown(args.resume_id) })),
  { annotations: { readOnlyHint: true } },
);

const draftCoverLetter = tool(
  "draft_cover_letter",
  "Save a cover letter for a posting. Write only what the profile supports: no employer, achievement or figure that is not stored. The text is checked against the profile and any unsupported figure is returned as a warning.",
  {
    job_id: z.number().int(),
    body: z.string().describe("The letter itself, ready to send"),
  },
  async (args) => guard(() => resume.saveCoverLetter(args.job_id, args.body)),
);

export const profileTools = [
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

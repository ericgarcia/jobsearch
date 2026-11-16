import { z } from "zod";

/**
 * What a layout is: an ordered list of sections, each shown or not.
 *
 * Order is the array's order, because a separate sort field is a second
 * source of truth that drifts. Hiding is a flag rather than removal, so a
 * section keeps its place and its settings while it is off — turning
 * Education back on should not mean deciding where it goes again.
 *
 * The content is not here. A section says "experience", and the renderer
 * fetches the roles. That separation is what lets one template be styled once
 * and then export any resume through it.
 */

export const SECTION_KINDS = [
  "header",
  "summary",
  "experience",
  "projects",
  "education",
  "skills",
  "interests",
  "values",
  "links",
] as const;

export type SectionKind = (typeof SECTION_KINDS)[number];

/** What each section is for, and what it reads. The skill shows this. */
export const SECTION_NOTES: Record<SectionKind, string> = {
  header: "Name, headline, location and contact details.",
  summary: "The opening paragraph. On a tailored resume this is the one written for that posting.",
  experience: "Roles, with their bullets and optionally their projects.",
  projects: "Projects on their own, rather than nested under a role.",
  education: "Schools and degrees.",
  skills: "The skills list, optionally grouped by category.",
  interests: "What the person is looking for. Usually a profile section, not a resume one.",
  values: "Long-form prose about how the person works. Profile only.",
  links: "Links out, as a list.",
};

const section = z.object({
  kind: z.enum(SECTION_KINDS),
  visible: z.boolean().default(true),
  /** Overrides the default wording. Null keeps it; an empty string drops it. */
  heading: z.string().max(60).nullable().default(null),
  options: z
    .object({
      /** experience: show each role's projects beneath it. */
      showProjects: z.boolean().optional(),
      /** experience: cap the bullets per role. The rest stay in the profile. */
      maxBullets: z.number().int().min(1).max(20).optional(),
      /** experience / projects: hide dates. */
      hideDates: z.boolean().optional(),
      /** skills: group under category headings rather than one run. */
      grouped: z.boolean().optional(),
      /** header: contact fields to print, in order. */
      contact: z.array(z.enum(["email", "phone", "location", "links"])).optional(),
    })
    .default({}),
});

export const layoutSpec = z.object({
  sections: z.array(section).min(1).max(20),
});

export type LayoutSpec = z.infer<typeof layoutSpec>;
export type Section = z.infer<typeof section>;

/**
 * A spec is rejected if it names the same section twice.
 *
 * Two "experience" sections would each render every role, which looks like a
 * rendering bug rather than a choice someone made.
 */
export function checkSpec(spec: LayoutSpec): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const section of spec.sections) {
    if (seen.has(section.kind)) problems.push(`"${section.kind}" appears more than once.`);
    seen.add(section.kind);
  }
  if (spec.sections.every((s) => !s.visible)) problems.push("Every section is hidden.");
  return problems;
}

const web = (kind: SectionKind, heading: string | null, options = {}): Section => ({
  kind,
  visible: true,
  heading,
  options,
});

/** Where each surface starts. */
export const DEFAULT_SPECS: Record<"profile" | "resume", LayoutSpec> = {
  profile: {
    sections: [
      web("header", null, { contact: ["location", "links"] }),
      web("summary", "About"),
      web("values", "How I work"),
      web("experience", "Experience", { showProjects: true }),
      web("projects", "Selected projects"),
      web("skills", "Skills", { grouped: true }),
      web("education", "Education"),
      web("interests", "What I'm looking for"),
    ],
  },
  resume: {
    sections: [
      web("header", null, { contact: ["email", "phone", "location", "links"] }),
      web("summary", "Summary"),
      web("experience", "Experience", { showProjects: false, maxBullets: 5 }),
      web("skills", "Skills", { grouped: false }),
      web("education", "Education"),
      // Off by default: a resume is read in about twenty seconds, and these
      // two take space from the roles. They stay in the list so turning them
      // on is one flag rather than a decision about where they go.
      { ...web("projects", "Projects"), visible: false },
      { ...web("values", "How I work"), visible: false },
    ],
  },
};

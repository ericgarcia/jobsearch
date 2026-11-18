import type { LayoutSpec, Section } from "./spec.js";
import { stylesheet } from "./styles.js";
import { cssVariables } from "./tokens.js";

/**
 * One renderer for the public profile and the printed resume.
 *
 * The two surfaces differ in their stylesheet and in which sections are on,
 * never in their markup. That is what lets a template be styled once and used
 * for any content: the HTML a resume produces for a role is the same HTML the
 * profile produces for it, so a rule written against one holds for the other.
 *
 * The markup is ours. Nothing here interpolates anything a person wrote
 * except as escaped text, so a profile cannot change its own structure, hide
 * what the page is required to show, or claim to be someone else.
 */

/**
 * A line of a role, and what it is stored as.
 *
 * The two ids are not the same thing and must not be confused. `bulletId`
 * names the fact in the profile. `lineId` names its wording on one tailored
 * resume, and is null unless a draft is being rendered. Editing the first
 * changes every resume; editing the second changes this one. An editor that
 * guessed between them would quietly rewrite a person's history.
 */
export interface Bullet {
  text: string;
  bulletId: number | null;
  lineId: number | null;
}

export interface RenderContent {
  name: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  links: { label: string; url: string }[];
  summary: string | null;
  values: { id: number; heading: string; body: string }[];
  interests: { titles: string[]; include: string[]; note: string | null };
  roles: {
    id: number;
    title: string;
    company: string;
    location: string | null;
    start: string | null;
    end: string | null;
    summary: string | null;
    bullets: Bullet[];
    projects: { id: number; name: string; blurb: string | null }[];
  }[];
  projects: { id: number; name: string; blurb: string | null; role: string | null }[];
  education: {
    id: number;
    school: string;
    degree: string | null;
    field: string | null;
    end: string | null;
  }[];
  skills: { id: number; name: string; category: string | null }[];
}

export type Surface = "profile" | "resume";

/**
 * What the renderer is rendering for.
 *
 * `annotate` adds data attributes naming what each element is and which row
 * it came from, so the editor can resolve a click to a thing it may change.
 * It is off everywhere else: the public page and the PDF carry no ids, and a
 * test holds that. The markup is otherwise identical either way — an editor
 * that showed different HTML from the one that prints would be showing
 * something other than the document.
 */
export interface RenderContext {
  surface: Surface;
  annotate: boolean;
}

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const dates = (start: string | null, end: string | null, hide?: boolean): string =>
  hide ? "" : [start, end ?? "Present"].filter(Boolean).join(" – ");

/**
 * Data attributes, when they are wanted. Nothing at all when they are not,
 * so the one renderer produces the printed document and the editable one.
 */
function mark(
  context: RenderContext,
  attributes: Record<string, string | number | null | undefined>,
): string {
  if (!context.annotate) return "";
  return Object.entries(attributes)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => ` data-${name}="${escape(value)}"`)
    .join("");
}

/** A heading, unless the layout emptied it. */
function heading(section: Section, fallback: string, context: RenderContext): string {
  const text = section.heading === null ? fallback : section.heading;
  if (text.trim() === "") return "";
  return `<h2 class="section-heading"${mark(context, { field: "heading" })}>${escape(text)}</h2>`;
}

/* ------------------------------------------------------------- sections */

function renderHeader(section: Section, c: RenderContent, x: RenderContext): string {
  const want = section.options.contact ?? ["email", "phone", "location"];
  const parts: string[] = [];

  for (const field of want) {
    if (field === "email" && c.email) parts.push(`<a href="mailto:${escape(c.email)}">${escape(c.email)}</a>`);
    if (field === "phone" && c.phone) parts.push(escape(c.phone));
    if (field === "location" && c.location) parts.push(escape(c.location));
    if (field === "links") {
      for (const link of c.links) {
        parts.push(`<a href="${escape(link.url)}" rel="noopener nofollow">${escape(link.label)}</a>`);
      }
    }
  }

  return `<header class="doc-header"${mark(x, { section: "header" })}>
  <h1 class="name"${mark(x, { field: "name" })}>${escape(c.name ?? "")}</h1>
  ${c.headline ? `<p class="headline"${mark(x, { field: "headline" })}>${escape(c.headline)}</p>` : ""}
  ${parts.length ? `<p class="contact"${mark(x, { field: "contact" })}>${parts.join('<span class="sep"> · </span>')}</p>` : ""}
</header>`;
}

function renderExperience(section: Section, c: RenderContent, x: RenderContext): string {
  if (c.roles.length === 0) return "";
  const cap = section.options.maxBullets;

  const entries = c.roles.map((role) => {
    const when = dates(role.start, role.end, section.options.hideDates);
    const bullets = (cap ? role.bullets.slice(0, cap) : role.bullets)
      .map(
        (bullet) =>
          `<li${mark(x, {
            field: "bullet",
            bullet: bullet.bulletId,
            line: bullet.lineId,
          })}>${escape(bullet.text)}</li>`,
      )
      .join("\n      ");

    const projects =
      section.options.showProjects && role.projects.length > 0
        ? `<ul class="projects">${role.projects
            .map(
              (p) =>
                `<li${mark(x, { project: p.id })}><span class="project-name">${escape(p.name)}</span>${
                  p.blurb ? ` <span class="project-blurb">${escape(p.blurb)}</span>` : ""
                }</li>`,
            )
            .join("")}</ul>`
        : "";

    /*
      The whole entry is one break-avoid box. A role split across a page with
      its heading on the first page and its bullets on the second is the most
      common way a generated resume looks careless.
    */
    return `<article class="entry"${mark(x, { role: role.id })}>
    <div class="entry-head">
      <h3 class="entry-title"><span class="entry-role"${mark(x, { field: "title" })}>${escape(
        role.title,
      )}</span><span class="at">, </span><span class="entry-org"${mark(x, {
        field: "company",
      })}>${escape(role.company)}</span></h3>
      <p class="entry-meta"${mark(x, { field: "when" })}>${[
        when,
        section.options.hideDates ? "" : role.location,
      ]
        .filter(Boolean)
        .map(escape)
        .join(" · ")}</p>
    </div>
    ${
      role.summary && x.surface === "profile"
        ? `<p class="entry-summary"${mark(x, { field: "role-summary" })}>${escape(role.summary)}</p>`
        : ""
    }
    ${bullets ? `<ul class="bullets">\n      ${bullets}\n    </ul>` : ""}
    ${projects}
  </article>`;
  });

  return `<section class="section section-experience"${mark(x, { section: "experience" })}>
  ${heading(section, "Experience", x)}
  ${entries.join("\n  ")}
</section>`;
}

function renderProjects(section: Section, c: RenderContent, x: RenderContext): string {
  if (c.projects.length === 0) return "";
  const items = c.projects
    .map(
      (p) =>
        `<article class="entry entry-project"${mark(x, { project: p.id })}>
    <h3 class="entry-title"${mark(x, { field: "project-name" })}>${escape(p.name)}</h3>
    ${p.role ? `<p class="entry-meta">${escape(p.role)}</p>` : ""}
    ${
      p.blurb
        ? `<p class="entry-summary"${mark(x, { field: "project-blurb" })}>${escape(p.blurb)}</p>`
        : ""
    }
  </article>`,
    )
    .join("\n  ");
  return `<section class="section section-projects"${mark(x, { section: "projects" })}>\n  ${heading(section, "Projects", x)}\n  ${items}\n</section>`;
}

function renderEducation(section: Section, c: RenderContent, x: RenderContext): string {
  if (c.education.length === 0) return "";
  const items = c.education
    .map((item) => {
      const what = [item.degree, item.field].filter(Boolean).map(escape).join(" ");
      return `<li${mark(x, { education: item.id })}><span class="edu-what">${what}</span>${what ? '<span class="sep">, </span>' : ""}<span class="edu-school">${escape(
        item.school,
      )}</span>${item.end ? `<span class="edu-when"> (${escape(item.end)})</span>` : ""}</li>`;
    })
    .join("\n    ");
  return `<section class="section section-education"${mark(x, { section: "education" })}>\n  ${heading(section, "Education", x)}\n  <ul class="plain">\n    ${items}\n  </ul>\n</section>`;
}

function renderSkills(section: Section, c: RenderContent, x: RenderContext): string {
  if (c.skills.length === 0) return "";

  const one = (skill: RenderContent["skills"][number]): string =>
    `<span class="skill"${mark(x, { skill: skill.id })}>${escape(skill.name)}</span>`;

  if (!section.options.grouped) {
    return `<section class="section section-skills"${mark(x, { section: "skills" })}>
  ${heading(section, "Skills", x)}
  <p class="skill-run">${c.skills.map(one).join('<span class="sep"> · </span>')}</p>
</section>`;
  }

  const groups = new Map<string, RenderContent["skills"]>();
  for (const skill of c.skills) {
    const key = skill.category ?? "Other";
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  const rows = [...groups.entries()]
    .map(
      ([category, skills]) =>
        `<div class="skill-group"><span class="skill-category">${escape(category)}</span><span class="skill-names">${skills
          .map(one)
          .join('<span class="sep"> · </span>')}</span></div>`,
    )
    .join("\n  ");
  return `<section class="section section-skills"${mark(x, { section: "skills" })}>\n  ${heading(section, "Skills", x)}\n  ${rows}\n</section>`;
}

function renderProse(
  section: Section,
  fallback: string,
  blocks: RenderContent["values"],
  x: RenderContext,
): string {
  if (blocks.length === 0) return "";
  const body = blocks
    .map(
      (block) =>
        `<div class="prose-block"${mark(x, { prose: block.id })}>${
          block.heading
            ? `<h3 class="entry-title"${mark(x, { field: "prose-heading" })}>${escape(block.heading)}</h3>`
            : ""
        }${block.body
          .split(/\n{2,}/)
          .map((p) => `<p>${escape(p.trim())}</p>`)
          .join("")}</div>`,
    )
    .join("\n  ");
  return `<section class="section section-prose"${mark(x, { section: "values" })}>\n  ${heading(section, fallback, x)}\n  ${body}\n</section>`;
}

function renderInterests(section: Section, c: RenderContent, x: RenderContext): string {
  const { titles, include, note } = c.interests;
  if (titles.length === 0 && include.length === 0 && !note) return "";
  const wanted = [...titles, ...include];
  return `<section class="section section-interests"${mark(x, { section: "interests" })}>
  ${heading(section, "What I'm looking for", x)}
  ${wanted.length ? `<p class="skill-run">${wanted.map(escape).join('<span class="sep"> · </span>')}</p>` : ""}
  ${note ? `<p${mark(x, { field: "interests-note" })}>${escape(note)}</p>` : ""}
</section>`;
}

function renderLinks(section: Section, c: RenderContent, x: RenderContext): string {
  if (c.links.length === 0) return "";
  return `<section class="section section-links"${mark(x, { section: "links" })}>
  ${heading(section, "Links", x)}
  <ul class="plain">${c.links
    .map((l) => `<li><a href="${escape(l.url)}" rel="noopener nofollow">${escape(l.label)}</a></li>`)
    .join("")}</ul>
</section>`;
}

/* ------------------------------------------------------------- assembly */

/** The body of a document: sections in the layout's order, hidden ones left out. */
export function renderBody(
  spec: LayoutSpec,
  content: RenderContent,
  surface: Surface,
  annotate = false,
): string {
  const out: string[] = [];
  const x: RenderContext = { surface, annotate };

  for (const section of spec.sections) {
    if (!section.visible) continue;

    switch (section.kind) {
      case "header":
        out.push(renderHeader(section, content, x));
        break;
      case "summary":
        if (content.summary) {
          out.push(
            `<section class="section section-summary"${mark(x, {
              section: "summary",
            })}>\n  ${heading(section, "Summary", x)}\n  <p${mark(x, {
              field: "summary",
            })}>${escape(content.summary)}</p>\n</section>`,
          );
        }
        break;
      case "experience":
        out.push(renderExperience(section, content, x));
        break;
      case "projects":
        out.push(renderProjects(section, content, x));
        break;
      case "education":
        out.push(renderEducation(section, content, x));
        break;
      case "skills":
        out.push(renderSkills(section, content, x));
        break;
      case "values":
        out.push(renderProse(section, "How I work", content.values, x));
        break;
      case "interests":
        out.push(renderInterests(section, content, x));
        break;
      case "links":
        out.push(renderLinks(section, content, x));
        break;
    }
  }

  return out.filter(Boolean).join("\n\n");
}

export interface DocumentOptions {
  spec: LayoutSpec;
  tokens: Record<string, string>;
  content: RenderContent;
  surface: Surface;
  /** Draw page edges on screen. The printed output never shows them. */
  paged?: boolean;
  /** Name each element and the row it came from. The editor only. */
  annotate?: boolean;
  title?: string;
  /** Extra <head> markup, such as OpenGraph tags. Built by the caller. */
  head?: string;
}

/** A whole standalone document. */
export function renderDocument(options: DocumentOptions): string {
  const { spec, tokens, content, surface, paged = false, annotate = false, title, head = "" } = options;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title ?? content.name ?? "Resume")}</title>
${head}
<style>
:root {
${cssVariables(surface, tokens)}
}
${stylesheet(surface, paged)}
</style>
</head>
<body class="${surface}${paged ? " paged" : ""}">
<main class="doc">
${renderBody(spec, content, surface, annotate)}
</main>
</body>
</html>`;
}

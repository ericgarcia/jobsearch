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

export interface RenderContent {
  name: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  links: { label: string; url: string }[];
  summary: string | null;
  values: { heading: string; body: string }[];
  interests: { titles: string[]; include: string[]; note: string | null };
  roles: {
    id: number;
    title: string;
    company: string;
    location: string | null;
    start: string | null;
    end: string | null;
    summary: string | null;
    bullets: string[];
    projects: { name: string; blurb: string | null }[];
  }[];
  projects: { name: string; blurb: string | null; role: string | null }[];
  education: { school: string; degree: string | null; field: string | null; end: string | null }[];
  skills: { name: string; category: string | null }[];
}

export type Surface = "profile" | "resume";

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const dates = (start: string | null, end: string | null, hide?: boolean): string =>
  hide ? "" : [start, end ?? "Present"].filter(Boolean).join(" – ");

/** A heading, unless the layout emptied it. */
function heading(section: Section, fallback: string): string {
  const text = section.heading === null ? fallback : section.heading;
  return text.trim() === "" ? "" : `<h2 class="section-heading">${escape(text)}</h2>`;
}

/* ------------------------------------------------------------- sections */

function renderHeader(section: Section, c: RenderContent): string {
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

  return `<header class="doc-header">
  <h1 class="name">${escape(c.name ?? "")}</h1>
  ${c.headline ? `<p class="headline">${escape(c.headline)}</p>` : ""}
  ${parts.length ? `<p class="contact">${parts.join('<span class="sep"> · </span>')}</p>` : ""}
</header>`;
}

function renderExperience(section: Section, c: RenderContent, surface: Surface): string {
  if (c.roles.length === 0) return "";
  const cap = section.options.maxBullets;

  const entries = c.roles.map((role) => {
    const when = dates(role.start, role.end, section.options.hideDates);
    const bullets = (cap ? role.bullets.slice(0, cap) : role.bullets)
      .map((text) => `<li>${escape(text)}</li>`)
      .join("\n      ");

    const projects =
      section.options.showProjects && role.projects.length > 0
        ? `<ul class="projects">${role.projects
            .map(
              (p) =>
                `<li><span class="project-name">${escape(p.name)}</span>${
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
    return `<article class="entry">
    <div class="entry-head">
      <h3 class="entry-title">${escape(role.title)}<span class="at">, </span><span class="entry-org">${escape(role.company)}</span></h3>
      <p class="entry-meta">${[when, section.options.hideDates ? "" : role.location]
        .filter(Boolean)
        .map(escape)
        .join(" · ")}</p>
    </div>
    ${role.summary && surface === "profile" ? `<p class="entry-summary">${escape(role.summary)}</p>` : ""}
    ${bullets ? `<ul class="bullets">\n      ${bullets}\n    </ul>` : ""}
    ${projects}
  </article>`;
  });

  return `<section class="section section-experience">
  ${heading(section, "Experience")}
  ${entries.join("\n  ")}
</section>`;
}

function renderProjects(section: Section, c: RenderContent): string {
  if (c.projects.length === 0) return "";
  const items = c.projects
    .map(
      (p) =>
        `<article class="entry entry-project">
    <h3 class="entry-title">${escape(p.name)}</h3>
    ${p.role ? `<p class="entry-meta">${escape(p.role)}</p>` : ""}
    ${p.blurb ? `<p class="entry-summary">${escape(p.blurb)}</p>` : ""}
  </article>`,
    )
    .join("\n  ");
  return `<section class="section section-projects">\n  ${heading(section, "Projects")}\n  ${items}\n</section>`;
}

function renderEducation(section: Section, c: RenderContent): string {
  if (c.education.length === 0) return "";
  const items = c.education
    .map((item) => {
      const what = [item.degree, item.field].filter(Boolean).map(escape).join(" ");
      return `<li><span class="edu-what">${what}</span>${what ? '<span class="sep">, </span>' : ""}<span class="edu-school">${escape(
        item.school,
      )}</span>${item.end ? `<span class="edu-when"> (${escape(item.end)})</span>` : ""}</li>`;
    })
    .join("\n    ");
  return `<section class="section section-education">\n  ${heading(section, "Education")}\n  <ul class="plain">\n    ${items}\n  </ul>\n</section>`;
}

function renderSkills(section: Section, c: RenderContent): string {
  if (c.skills.length === 0) return "";

  if (!section.options.grouped) {
    return `<section class="section section-skills">
  ${heading(section, "Skills")}
  <p class="skill-run">${c.skills.map((s) => escape(s.name)).join('<span class="sep"> · </span>')}</p>
</section>`;
  }

  const groups = new Map<string, string[]>();
  for (const skill of c.skills) {
    const key = skill.category ?? "Other";
    groups.set(key, [...(groups.get(key) ?? []), skill.name]);
  }
  const rows = [...groups.entries()]
    .map(
      ([category, names]) =>
        `<div class="skill-group"><span class="skill-category">${escape(category)}</span><span class="skill-names">${names
          .map(escape)
          .join('<span class="sep"> · </span>')}</span></div>`,
    )
    .join("\n  ");
  return `<section class="section section-skills">\n  ${heading(section, "Skills")}\n  ${rows}\n</section>`;
}

function renderProse(section: Section, fallback: string, blocks: { heading: string; body: string }[]): string {
  if (blocks.length === 0) return "";
  const body = blocks
    .map(
      (block) =>
        `<div class="prose-block">${
          block.heading ? `<h3 class="entry-title">${escape(block.heading)}</h3>` : ""
        }${block.body
          .split(/\n{2,}/)
          .map((p) => `<p>${escape(p.trim())}</p>`)
          .join("")}</div>`,
    )
    .join("\n  ");
  return `<section class="section section-prose">\n  ${heading(section, fallback)}\n  ${body}\n</section>`;
}

function renderInterests(section: Section, c: RenderContent): string {
  const { titles, include, note } = c.interests;
  if (titles.length === 0 && include.length === 0 && !note) return "";
  const wanted = [...titles, ...include];
  return `<section class="section section-interests">
  ${heading(section, "What I'm looking for")}
  ${wanted.length ? `<p class="skill-run">${wanted.map(escape).join('<span class="sep"> · </span>')}</p>` : ""}
  ${note ? `<p>${escape(note)}</p>` : ""}
</section>`;
}

function renderLinks(section: Section, c: RenderContent): string {
  if (c.links.length === 0) return "";
  return `<section class="section section-links">
  ${heading(section, "Links")}
  <ul class="plain">${c.links
    .map((l) => `<li><a href="${escape(l.url)}" rel="noopener nofollow">${escape(l.label)}</a></li>`)
    .join("")}</ul>
</section>`;
}

/* ------------------------------------------------------------- assembly */

/** The body of a document: sections in the layout's order, hidden ones left out. */
export function renderBody(spec: LayoutSpec, content: RenderContent, surface: Surface): string {
  const out: string[] = [];

  for (const section of spec.sections) {
    if (!section.visible) continue;

    switch (section.kind) {
      case "header":
        out.push(renderHeader(section, content));
        break;
      case "summary":
        if (content.summary) {
          out.push(
            `<section class="section section-summary">\n  ${heading(section, "Summary")}\n  <p>${escape(
              content.summary,
            )}</p>\n</section>`,
          );
        }
        break;
      case "experience":
        out.push(renderExperience(section, content, surface));
        break;
      case "projects":
        out.push(renderProjects(section, content));
        break;
      case "education":
        out.push(renderEducation(section, content));
        break;
      case "skills":
        out.push(renderSkills(section, content));
        break;
      case "values":
        out.push(renderProse(section, "How I work", content.values));
        break;
      case "interests":
        out.push(renderInterests(section, content));
        break;
      case "links":
        out.push(renderLinks(section, content));
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
  title?: string;
  /** Extra <head> markup, such as OpenGraph tags. Built by the caller. */
  head?: string;
}

/** A whole standalone document. */
export function renderDocument(options: DocumentOptions): string {
  const { spec, tokens, content, surface, paged = false, title, head = "" } = options;

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
${renderBody(spec, content, surface)}
</main>
</body>
</html>`;
}

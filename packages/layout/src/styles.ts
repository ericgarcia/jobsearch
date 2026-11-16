/**
 * The two stylesheets. Both are ours; both read only the tokens.
 *
 * They are written here rather than kept as files because a token has to
 * reach them, and because the resume sheet is the printed artefact: it is
 * easier to keep a page honest when the `@page` rule and the screen preview
 * of that page sit in one place.
 */
import type { Surface } from "./render.js";

/*
  Letter paper, in CSS pixels at the 96dpi the browser assumes.
  8.5in = 816px, 11in = 1056px. The preview draws a box of exactly that size
  so what is on screen is the page, not an impression of one.
*/
const PAGE_W = "8.5in";
const PAGE_H = "11in";

const SHARED = `
*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  color: var(--ink);
  background: var(--paper);
  font-family: var(--font-body);
  font-size: var(--font-size);
  line-height: var(--line-height);
  -webkit-text-size-adjust: 100%;
}

h1, h2, h3 {
  font-family: var(--font-heading);
  font-weight: var(--heading-weight);
  margin: 0;
}

/* One multiplier on every gap, so "tighter" is a single token. */
.section + .section { margin-top: calc(var(--section-gap) * var(--density)); }
.entry + .entry { margin-top: calc(var(--entry-gap) * var(--density)); }
.bullets li + li { margin-top: calc(var(--bullet-gap) * var(--density)); }

.section-heading {
  font-size: calc(var(--font-size) * var(--heading-scale));
  text-transform: var(--heading-case);
  letter-spacing: var(--heading-tracking);
  color: var(--accent);
  margin-bottom: calc(0.4rem * var(--density));
}

.name {
  font-size: calc(var(--font-size) * var(--heading-scale) * 1.9);
  letter-spacing: var(--heading-tracking);
  color: var(--accent);
}
.headline { margin: calc(0.15rem * var(--density)) 0 0; color: var(--muted); }
.contact { margin: calc(0.35rem * var(--density)) 0 0; color: var(--muted); font-size: 0.92em; }
.contact a { color: inherit; }
.sep { opacity: 0.5; }

.entry-title { font-size: calc(var(--font-size) * 1.02); }
.entry-org { font-weight: inherit; }
.entry-meta { margin: 0; color: var(--muted); font-size: 0.92em; }
.entry-summary { margin: calc(0.25rem * var(--density)) 0 0; }

.bullets { margin: calc(0.3rem * var(--density)) 0 0; padding-left: 1.1em; }
.bullets li { margin: 0; }
.projects { margin: calc(0.3rem * var(--density)) 0 0; padding-left: 1.1em; list-style: none; }
.project-name { font-weight: 600; }
.project-blurb { color: var(--muted); }

.plain { margin: 0; padding: 0; list-style: none; }
.skill-run { margin: 0; }
.skill-group { display: flex; gap: 0.6em; }
.skill-category { color: var(--muted); min-width: 8em; }
.prose-block + .prose-block { margin-top: calc(var(--entry-gap) * var(--density)); }
.prose-block p { margin: calc(0.4rem * var(--density)) 0 0; }
`;

/* Rules under headings, which is the one piece of ornament the tokens offer. */
const RULES = `
.section-heading { border-bottom: 0; padding-bottom: 0; }
body[data-rules="under-heading"] .section-heading,
.rules-under-heading .section-heading {
  border-bottom: 1px solid var(--rule);
  padding-bottom: calc(0.2rem * var(--density));
}
`;

const PROFILE = `
.doc {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: clamp(1.5rem, 5vw, 4rem) 1.25rem 6rem;
}
.doc-header { margin-bottom: calc(var(--section-gap) * var(--density)); }
.entry { border-radius: var(--corner-radius); }

@media (prefers-color-scheme: dark) {
  /*
    The tokens describe one palette, and a public page is read in both
    schemes. Rather than ask for a second set of colours nobody will keep in
    step, the dark rendering is derived: the page inverts to a dark ground
    and the author's accent stays theirs.
  */
  body.profile:not([data-theme="light"]) {
    background: #11131a;
    color: #e7e9ee;
  }
  body.profile:not([data-theme="light"]) .section-heading,
  body.profile:not([data-theme="light"]) .name { color: #f4f6fa; }
  body.profile:not([data-theme="light"]) .headline,
  body.profile:not([data-theme="light"]) .entry-meta,
  body.profile:not([data-theme="light"]) .contact,
  body.profile:not([data-theme="light"]) .skill-category,
  body.profile:not([data-theme="light"]) .project-blurb { color: #9aa3b2; }
  body.profile:not([data-theme="light"]) .section-heading { border-color: #2a2f3a; }
}
`;

/*
  The resume is a printed document that happens to be shown on a screen.

  `@page` governs the paper. The preview reproduces it with a box of the same
  size and the same margin, so the line that falls near the bottom of the
  preview is the line that falls near the bottom of the page. It is the same
  stylesheet either way, which is the only way the two stay in agreement.
*/
const RESUME = `
@page {
  size: ${PAGE_W} ${PAGE_H};
  margin: var(--page-margin);
}

.doc { padding: 0; }

/* Keep a role whole. A heading orphaned from its bullets reads as a fault. */
.entry, .prose-block { break-inside: avoid; }
.section-heading { break-after: avoid; }
.doc-header { break-after: avoid; }

@media screen {
  body.resume {
    background: #767b84;
    padding: 2rem 0;
  }
  body.resume .doc {
    width: ${PAGE_W};
    min-height: ${PAGE_H};
    margin: 0 auto;
    padding: var(--page-margin);
    background: var(--paper);
    box-shadow: 0 2px 16px rgba(0, 0, 0, 0.35);
  }

  /*
    Page edges, drawn as a repeating band behind the document.

    This shows where the paper ends. It does not reflow the content across
    page boxes — only printing does that — so treat it as a ruler rather than
    a rendering. The export is the browser's own print, which is the real
    thing rather than an imitation of it.
  */
  body.resume.paged .doc {
    background-image: repeating-linear-gradient(
      to bottom,
      transparent 0,
      transparent calc(${PAGE_H} - 2px),
      rgba(220, 38, 38, 0.45) calc(${PAGE_H} - 2px),
      rgba(220, 38, 38, 0.45) ${PAGE_H}
    );
    background-color: var(--paper);
  }
}

@media print {
  body.resume { background: #fff; padding: 0; }
  body.resume .doc {
    width: auto;
    min-height: 0;
    padding: 0;           /* @page owns the margin when printing. */
    box-shadow: none;
    background: none;
    background-image: none;
  }
}
`;

export function stylesheet(surface: Surface, paged: boolean): string {
  void paged; // The body class carries it; the sheet is the same either way.
  return [SHARED, RULES, surface === "profile" ? PROFILE : RESUME].join("\n");
}

/** The page size the preview and the print rule share, for the UI to echo. */
export const PAGE = { width: PAGE_W, height: PAGE_H };

import { DEFAULT_SPECS, SECTION_KINDS, SECTION_NOTES } from "./spec.js";
import { DEFAULTS, FONT_STACKS, TOKENS } from "./tokens.js";

/**
 * The styling guide, generated from the definitions it describes.
 *
 * Written out rather than kept as prose because a hand-written guide and a
 * validator drift, and the agent only finds out at the moment it is refused.
 * Generating it means a token added to `TOKENS` is documented the same hour,
 * with the range the checker will actually enforce.
 */

const PREAMBLE = `# Styling a profile or a resume

You change how these pages look by setting **tokens** and by **arranging
sections**. There is no stylesheet to write and no HTML to author — not
because it would be hard, but because a stored stylesheet fetches resources,
and that leaks the address of everyone who views the page to whoever wrote
it. Tokens give the same reach over appearance with none of that.

This is a constraint worth using well rather than working around. A request
like "make it warmer and more spacious" is four token values: it previews,
it diffs, and the person can undo it. The same request answered with ad-hoc
rules produces a page that fights the next change.

## How to work

1. Read the current layout before changing it. Someone may have set things
   deliberately.
2. Change the fewest tokens that answer the request. Prefer one that moves
   several things at once — \`density\` over four separate gaps.
3. Re-render and look, rather than assuming. A resume that grew to three
   pages is a worse answer than the two-page one it replaced.
4. Say what you changed, in the person's words, not in token names.

## Two surfaces, styled separately

The **profile** is a web page: read on a phone, in a dark room, by someone
who followed a link. The **resume** is a printed document that happens to be
on a screen: letter paper, a reader who spends twenty seconds on it, and
possibly an applicant tracking system that parses it before any person sees
it.

Style them separately. A resume is not a profile with narrower margins.

## Things worth knowing about resumes

- One column parses most reliably. A sidebar risks a tracking system reading
  the page in the wrong order, which can drop half of someone's experience.
- Below about 9.5pt is hard to read on paper, whatever it looks like on a
  screen.
- Keep the background near white. A reader may print it.
- If it runs to a second page, prefer cutting bullets with the
  \`maxBullets\` option over shrinking the type.
`;

function tokenTable(surface: "profile" | "resume"): string {
  const rows = Object.entries(TOKENS)
    .filter(([, def]) => def.surfaces.includes(surface))
    .map(([name, def]) => {
      let allowed: string;
      switch (def.type) {
        case "color":
          allowed = "hex colour, e.g. `#2b3a55`";
          break;
        case "enum":
          allowed = (def.values ?? []).map((v) => `\`${v}\``).join(", ");
          break;
        case "number":
          allowed = `number ${def.min} to ${def.max}`;
          break;
        case "length":
          allowed = `${def.min}–${def.max}, unit ${(def.values ?? []).map((u) => `\`${u}\``).join(" or ")}`;
          break;
      }
      return `| \`${name}\` | ${allowed} | \`${DEFAULTS[surface][name] ?? "—"}\` | ${def.note} |`;
    });

  return [`| Token | Accepts | Default | What it does |`, `| --- | --- | --- | --- |`, ...rows].join("\n");
}

export function stylingGuide(): string {
  const sections = SECTION_KINDS.map((kind) => `- \`${kind}\` — ${SECTION_NOTES[kind]}`).join("\n");

  const fonts = Object.entries(FONT_STACKS)
    .map(([name, stack]) => `- \`${name}\` — ${stack.split(",")[0]!.replace(/'/g, "")}`)
    .join("\n");

  const order = (surface: "profile" | "resume") =>
    DEFAULT_SPECS[surface].sections
      .map((s) => `${s.kind}${s.visible ? "" : " (off)"}`)
      .join(" → ");

  return `${PREAMBLE}
## Sections

Every section is listed in the layout whether it is shown or not, so hiding
one keeps its place and its settings for when it comes back. Order is the
order of the list.

${sections}

Default profile order: ${order("profile")}
Default resume order: ${order("resume")}

Section options: \`showProjects\`, \`maxBullets\` (1–20), \`hideDates\`,
\`grouped\` (skills), \`contact\` (which details the header prints).
A \`heading\` of \`null\` keeps the default wording; an empty string removes
the heading and keeps the section.

## Profile tokens

${tokenTable("profile")}

## Resume tokens

${tokenTable("resume")}

## Font names

${fonts}

Named stacks, not arbitrary faces, so a printed page renders in something the
reader's machine has. A webfont that fails to load substitutes silently, and
nobody notices until the PDF has been sent.

## What is refused, and why

- Anything with \`;\`, \`{\`, \`}\`, \`(\`, \`)\`, \`@\` or a quote in it. Those
  end a declaration, and a value that can end a declaration can start a rule.
- Colours other than hex. No \`rgb()\`, no names, no \`var()\`.
- A value outside its range. The ranges are the point: a 2pt resume and a 9in
  margin are not styles, they are mistakes.
- A token on the wrong surface. \`pageMargin\` means nothing to a web page.

A refusal names the token and the reason. Read it and correct the value
rather than trying a different spelling.
`;
}

/**
 * The design tokens, which are the whole styling surface.
 *
 * There is no user-authored CSS anywhere in this system, and that is the
 * point. A stylesheet is a program: it fetches resources, so it leaks every
 * visitor's address to whoever wrote it; it can cover the page, hide a
 * element the page is required to show, or display text through `content`
 * that no moderator reading the stored data would ever see. Tokens give the
 * same reach over how a page looks with none of that.
 *
 * It also makes the agent better rather than worse. "Make it warmer and more
 * spacious" becomes four values, which can be previewed, diffed and undone.
 * The same request against raw CSS produces declarations that fight the next
 * edit.
 *
 * A token value still reaches a stylesheet, so each one is checked against a
 * type here. Without that, an accent colour of `red; } body { background:
 * url(http://…)` would be exactly the stylesheet we refused to accept.
 */

export type TokenType = "color" | "length" | "number" | "enum";

export interface TokenDef {
  /** The CSS custom property this becomes. */
  css: string;
  type: TokenType;
  /** Which surfaces it applies to. */
  surfaces: ("profile" | "resume")[];
  /** For `enum`: the permitted values. For `length`: the permitted units. */
  values?: string[];
  /** For `number` and `length`: the permitted range, inclusive. */
  min?: number;
  max?: number;
  /** What it does, in one line. The styling skill shows this to the agent. */
  note: string;
}

/*
  Font stacks are named, not free text, so that a resume renders in a face the
  reader's machine actually has. A missing webfont on a printed page is a
  silent substitution nobody sees until the PDF is already sent.
*/
export const FONT_STACKS: Record<string, string> = {
  system: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  humanist: "'Optima', 'Gill Sans', 'Lucida Grande', sans-serif",
  grotesque: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  transitional: "'Charter', 'Georgia', 'Times New Roman', serif",
  oldstyle: "'Palatino', 'Palatino Linotype', 'Book Antiqua', serif",
  slab: "'Rockwell', 'Courier Bold', Courier, monospace",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

export const TOKENS: Record<string, TokenDef> = {
  /* ------------------------------------------------------------- colour */
  ink: { css: "--ink", type: "color", surfaces: ["profile", "resume"], note: "Body text." },
  muted: { css: "--muted", type: "color", surfaces: ["profile", "resume"], note: "Dates, locations, anything secondary." },
  accent: { css: "--accent", type: "color", surfaces: ["profile", "resume"], note: "Headings and rules." },
  paper: { css: "--paper", type: "color", surfaces: ["profile", "resume"], note: "The background. Keep a resume near white: a reader may print it." },
  rule: { css: "--rule", type: "color", surfaces: ["profile", "resume"], note: "Lines under section headings." },

  /* ----------------------------------------------------------- lettering */
  fontHeading: { css: "--font-heading", type: "enum", surfaces: ["profile", "resume"], values: Object.keys(FONT_STACKS), note: "Face for headings." },
  fontBody: { css: "--font-body", type: "enum", surfaces: ["profile", "resume"], values: Object.keys(FONT_STACKS), note: "Face for body text." },
  fontSize: { css: "--font-size", type: "length", surfaces: ["profile", "resume"], values: ["pt", "px"], min: 8, max: 14, note: "Base size. A resume below 9.5pt is hard to read on paper." },
  lineHeight: { css: "--line-height", type: "number", surfaces: ["profile", "resume"], min: 1.1, max: 2, note: "Leading, as a multiple of the size." },
  headingScale: { css: "--heading-scale", type: "number", surfaces: ["profile", "resume"], min: 1, max: 1.8, note: "How much bigger each heading level is." },
  headingWeight: { css: "--heading-weight", type: "enum", surfaces: ["profile", "resume"], values: ["400", "500", "600", "700", "800"], note: "Heading boldness." },
  headingCase: { css: "--heading-case", type: "enum", surfaces: ["profile", "resume"], values: ["none", "uppercase", "lowercase", "capitalize"], note: "Letter case of section headings." },
  headingTracking: { css: "--heading-tracking", type: "length", surfaces: ["profile", "resume"], values: ["em"], min: -0.05, max: 0.3, note: "Letter spacing on headings. Uppercase headings usually want some." },

  /* ------------------------------------------------------------- spacing */
  density: { css: "--density", type: "number", surfaces: ["profile", "resume"], min: 0.6, max: 1.6, note: "Multiplies every gap at once. Below 1 fits more on a page." },
  sectionGap: { css: "--section-gap", type: "length", surfaces: ["profile", "resume"], values: ["rem", "em", "pt"], min: 0, max: 4, note: "Space between sections." },
  entryGap: { css: "--entry-gap", type: "length", surfaces: ["profile", "resume"], values: ["rem", "em", "pt"], min: 0, max: 3, note: "Space between roles." },
  bulletGap: { css: "--bullet-gap", type: "length", surfaces: ["profile", "resume"], values: ["rem", "em", "pt"], min: 0, max: 1.5, note: "Space between bullets." },

  /* ---------------------------------------------------------------- page */
  pageMargin: { css: "--page-margin", type: "length", surfaces: ["resume"], values: ["in", "cm", "mm"], min: 0.3, max: 1.5, note: "Printed margin on all four sides." },
  columns: { css: "--columns", type: "enum", surfaces: ["resume"], values: ["one", "sidebar-left", "sidebar-right"], note: "One column prints and parses most reliably. A sidebar risks an applicant tracking system reading the page in the wrong order." },
  rulesStyle: { css: "--rules-style", type: "enum", surfaces: ["profile", "resume"], values: ["none", "under-heading", "full-width"], note: "Where lines are drawn." },

  /* ------------------------------------------------------------- profile */
  maxWidth: { css: "--max-width", type: "length", surfaces: ["profile"], values: ["rem", "px", "ch"], min: 30, max: 120, note: "Reading width of the public page." },
  cornerRadius: { css: "--corner-radius", type: "length", surfaces: ["profile"], values: ["px", "rem"], min: 0, max: 24, note: "Rounding on cards." },
};

/** Where a surface starts before anyone changes anything. */
export const DEFAULTS: Record<"profile" | "resume", Record<string, string>> = {
  profile: {
    ink: "#1a1d23", muted: "#5b6472", accent: "#1a1d23", paper: "#ffffff", rule: "#dfe3e9",
    fontHeading: "humanist", fontBody: "system", fontSize: "11pt", lineHeight: "1.6",
    headingScale: "1.25", headingWeight: "600", headingCase: "none", headingTracking: "0em",
    density: "1", sectionGap: "2rem", entryGap: "1.25rem", bulletGap: "0.4rem",
    rulesStyle: "under-heading", maxWidth: "46rem", cornerRadius: "8px",
  },
  resume: {
    ink: "#111111", muted: "#555555", accent: "#111111", paper: "#ffffff", rule: "#cccccc",
    fontHeading: "transitional", fontBody: "transitional", fontSize: "10.5pt", lineHeight: "1.35",
    headingScale: "1.12", headingWeight: "700", headingCase: "uppercase", headingTracking: "0.08em",
    density: "1", sectionGap: "0.85rem", entryGap: "0.6rem", bulletGap: "0.15rem",
    pageMargin: "0.65in", columns: "one", rulesStyle: "under-heading",
  },
};

/* ------------------------------------------------------------ validation */

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const LENGTH = /^(-?\d+(?:\.\d+)?)([a-z%]+)$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

export interface TokenProblem {
  token: string;
  value: string;
  why: string;
}

/**
 * Check one value against its definition.
 *
 * Deliberately strict. A colour is a hex literal and nothing else: no
 * `rgb()`, no named colours, no `var()`. Anything with a bracket or a
 * semicolon in it is a way out of the declaration it lands in, and the whole
 * reason tokens exist is that nothing reaches the stylesheet unchecked.
 */
export function checkToken(name: string, value: string): TokenProblem | null {
  const def = TOKENS[name];
  if (!def) return { token: name, value, why: `No such token. Known: ${Object.keys(TOKENS).join(", ")}` };

  const problem = (why: string): TokenProblem => ({ token: name, value, why });

  if (typeof value !== "string" || value.length > 40) return problem("A value must be a short string.");
  if (/[;{}()<>\\'"@]/.test(value)) return problem("A value may not contain punctuation that ends a declaration.");

  switch (def.type) {
    case "color":
      return COLOR.test(value) ? null : problem("Must be a hex colour such as #2b3a55.");

    case "enum":
      return def.values?.includes(value)
        ? null
        : problem(`Must be one of: ${(def.values ?? []).join(", ")}.`);

    case "number": {
      if (!NUMBER.test(value)) return problem("Must be a plain number.");
      const n = Number(value);
      if (def.min != null && n < def.min) return problem(`Must be at least ${def.min}.`);
      if (def.max != null && n > def.max) return problem(`Must be at most ${def.max}.`);
      return null;
    }

    case "length": {
      const match = LENGTH.exec(value);
      if (!match) return problem("Must be a number with a unit, such as 0.75in.");
      const [, raw, unit] = match;
      if (!def.values?.includes(unit!)) {
        return problem(`Unit must be one of: ${(def.values ?? []).join(", ")}.`);
      }
      const n = Number(raw);
      if (def.min != null && n < def.min) return problem(`Must be at least ${def.min}${unit}.`);
      if (def.max != null && n > def.max) return problem(`Must be at most ${def.max}${unit}.`);
      return null;
    }
  }
}

/** Check a whole set, and say which surface it is for. */
export function checkTokens(
  surface: "profile" | "resume",
  tokens: Record<string, string>,
): TokenProblem[] {
  const problems: TokenProblem[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    const problem = checkToken(name, value);
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (!TOKENS[name]!.surfaces.includes(surface)) {
      problems.push({ token: name, value, why: `Only applies to a ${TOKENS[name]!.surfaces.join(" or ")}.` });
    }
  }
  return problems;
}

/**
 * The CSS custom properties for a surface: its defaults, with any checked
 * overrides on top. An unchecked value never reaches here — callers validate
 * before storing, and this validates again rather than trusting the store.
 */
export function cssVariables(surface: "profile" | "resume", overrides: Record<string, string>): string {
  const lines: string[] = [];

  for (const [name, fallback] of Object.entries(DEFAULTS[surface])) {
    const def = TOKENS[name];
    if (!def || !def.surfaces.includes(surface)) continue;

    /*
      An override that no longer passes is replaced by the default, not
      dropped. Dropping it was the first version, and it emitted no custom
      property at all — so `var(--accent)` resolved to nothing and the
      declaration using it was simply invalid. A page with an unreadable
      heading is a worse answer than a page in the default colour, and it
      would have been reported as "the styling broke" rather than as a
      value that should never have been stored.
    */
    const override = overrides[name];
    const value = override !== undefined && !checkToken(name, override) ? override : fallback;

    const resolved = def.type === "enum" && FONT_STACKS[value] ? FONT_STACKS[value] : value;
    lines.push(`  ${def.css}: ${resolved};`);
  }
  return lines.join("\n");
}

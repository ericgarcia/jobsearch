import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Layout, LayoutSection, TokenDef, Vocabulary } from "../api.ts";
import type { Pages, Selection } from "./Document.tsx";

/**
 * The controls, above the document rather than beside it.
 *
 * They used to be a column of every control at once, which meant the page
 * was a narrow strip of the thing being styled, and the two were never in
 * the same place. Here the document has the room, and the bar shows what is
 * to hand: the whole template when nothing is chosen, and the part you
 * clicked when something is.
 *
 * Every control is still generated from `/api/layout/vocabulary`. A control
 * the UI invents is a control the server refuses, and the person finds out
 * by watching a change not happen.
 */

/* ------------------------------------------------------------- popovers */

function Popover({
  label,
  children,
  wide,
  selected,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  selected?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="popover" ref={box}>
      <button
        className={`bar-button${open || selected ? " on" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {label} <span className="caret">▾</span>
      </button>
      {open && <div className={`popover-panel${wide ? " wide" : ""}`}>{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- controls */

function TokenControl({
  name,
  def,
  value,
  fallback,
  onChange,
}: {
  name: string;
  def: TokenDef;
  value: string | undefined;
  fallback: string;
  onChange: (value: string) => void;
}) {
  const current = value ?? fallback;
  const set = value !== undefined;

  const control = () => {
    switch (def.type) {
      case "color":
        return (
          <span className="token-color">
            <input type="color" value={current} onChange={(e) => onChange(e.target.value)} aria-label={name} />
            <code>{current}</code>
          </span>
        );

      case "enum":
        return (
          <select value={current} onChange={(e) => onChange(e.target.value)} aria-label={name}>
            {(def.values ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        );

      case "number": {
        const step = (def.max ?? 1) - (def.min ?? 0) > 5 ? 1 : 0.05;
        return (
          <span className="token-range">
            <input
              type="range"
              min={def.min}
              max={def.max}
              step={step}
              value={Number(current)}
              onChange={(e) => onChange(e.target.value)}
              aria-label={name}
            />
            <code>{current}</code>
          </span>
        );
      }

      case "length": {
        // The unit is whatever is already in use, so a slider cannot produce
        // a combination the server would refuse.
        const match = /^(-?\d+(?:\.\d+)?)([a-z%]+)$/.exec(current);
        const unit = match?.[2] ?? def.values?.[0] ?? "rem";
        const span = (def.max ?? 1) - (def.min ?? 0);
        return (
          <span className="token-range">
            <input
              type="range"
              min={def.min}
              max={def.max}
              step={span > 20 ? 1 : span > 3 ? 0.25 : 0.05}
              value={Number(match?.[1] ?? def.min ?? 0)}
              onChange={(e) => onChange(`${e.target.value}${unit}`)}
              aria-label={name}
            />
            <code>{current}</code>
          </span>
        );
      }
    }
  };

  return (
    <label className={`token${set ? " token-set" : ""}`}>
      <span className="token-name" title={def.note}>
        {name.replace(/([A-Z])/g, " $1").toLowerCase()}
      </span>
      {control()}
      <button
        className="ghost token-reset"
        onClick={() => onChange("")}
        disabled={!set}
        title={set ? `Back to ${fallback}` : "Unchanged"}
      >
        ↺
      </button>
    </label>
  );
}

/** The options one kind of section has. Nothing for a kind that has none. */
function SectionOptions({
  section,
  onChange,
}: {
  section: LayoutSection;
  onChange: (next: LayoutSection) => void;
}) {
  if (section.kind === "experience") {
    return (
      <div className="section-options">
        <label>
          <input
            type="checkbox"
            checked={section.options.showProjects ?? false}
            onChange={(e) => onChange({ ...section, options: { ...section.options, showProjects: e.target.checked } })}
          />
          projects
        </label>
        <label>
          <input
            type="checkbox"
            checked={section.options.hideDates ?? false}
            onChange={(e) => onChange({ ...section, options: { ...section.options, hideDates: e.target.checked } })}
          />
          hide dates
        </label>
        <label className="bullets-cap">
          bullets
          <input
            type="number"
            min={1}
            max={20}
            value={section.options.maxBullets ?? ""}
            placeholder="all"
            onChange={(e) =>
              onChange({
                ...section,
                options: {
                  ...section.options,
                  maxBullets: e.target.value === "" ? undefined : Number(e.target.value),
                },
              })
            }
          />
        </label>
      </div>
    );
  }

  if (section.kind === "skills") {
    return (
      <div className="section-options">
        <label>
          <input
            type="checkbox"
            checked={section.options.grouped ?? false}
            onChange={(e) => onChange({ ...section, options: { ...section.options, grouped: e.target.checked } })}
          />
          group by category
        </label>
      </div>
    );
  }

  return null;
}

/* -------------------------------------------------------------- the list */

function SectionRow({
  section,
  index,
  count,
  note,
  onChange,
  onMove,
  onSelect,
}: {
  section: LayoutSection;
  index: number;
  count: number;
  note: string;
  onChange: (next: LayoutSection) => void;
  onMove: (to: number) => void;
  onSelect: () => void;
}) {
  return (
    <li className={`section-row${section.visible ? "" : " section-off"}`}>
      <div className="section-main">
        <label className="section-toggle">
          <input
            type="checkbox"
            checked={section.visible}
            onChange={(e) => onChange({ ...section, visible: e.target.checked })}
          />
          <span className="section-kind" title={note} onClick={onSelect}>
            {section.kind}
          </span>
        </label>

        <div className="section-move">
          <button className="ghost" onClick={() => onMove(index - 1)} disabled={index === 0} aria-label="Move up">
            ↑
          </button>
          <button
            className="ghost"
            onClick={() => onMove(index + 1)}
            disabled={index === count - 1}
            aria-label="Move down"
          >
            ↓
          </button>
        </div>
      </div>

      {section.visible && section.kind !== "header" && (
        <input
          className="section-heading-input"
          value={section.heading ?? ""}
          placeholder="(no heading)"
          onChange={(e) => onChange({ ...section, heading: e.target.value })}
          aria-label={`Heading for ${section.kind}`}
        />
      )}

      {section.visible && <SectionOptions section={section} onChange={onChange} />}
    </li>
  );
}

/* ------------------------------------------------------------ the groups */

const GROUPS: [string, string[]][] = [
  ["Colour", ["ink", "muted", "accent", "paper", "rule"]],
  [
    "Lettering",
    ["fontHeading", "fontBody", "fontSize", "lineHeight", "headingScale", "headingWeight", "headingCase", "headingTracking"],
  ],
  ["Spacing", ["density", "sectionGap", "entryGap", "bulletGap"]],
  ["Page", ["pageMargin", "columns", "rulesStyle", "maxWidth", "cornerRadius"]],
];

/**
 * Which tokens show when a section is selected.
 *
 * They are not the section's own: there is no such thing. A token is the
 * whole document's, and `headingScale` moves every heading on it. This list
 * is only the shorter one worth reaching for while looking at that part,
 * and the panel says plainly what it touches. Per-section styling would be
 * a change to the spec, the vocabulary and the validator, and it waits
 * until this is missed rather than being guessed at now.
 */
const AFFECTS: Record<string, string[]> = {
  header: ["accent", "ink", "muted", "fontHeading", "headingScale", "headingTracking", "rulesStyle"],
  summary: ["ink", "fontBody", "fontSize", "lineHeight", "sectionGap"],
  experience: ["ink", "muted", "accent", "fontBody", "fontSize", "lineHeight", "entryGap", "bulletGap", "density"],
  projects: ["ink", "muted", "fontBody", "entryGap", "density"],
  education: ["ink", "muted", "fontBody", "sectionGap"],
  skills: ["ink", "muted", "fontBody", "fontSize", "sectionGap"],
  values: ["ink", "fontBody", "lineHeight", "entryGap"],
  interests: ["ink", "muted", "fontBody", "sectionGap"],
  links: ["ink", "accent", "fontBody", "sectionGap"],
};

const FIELD_NAMES: Record<string, string> = {
  heading: "heading",
  name: "name",
  headline: "headline",
  contact: "contact details",
  summary: "summary",
  title: "job title",
  company: "company",
  when: "dates and place",
  "role-summary": "role summary",
  bullet: "bullet",
  "project-name": "project name",
  "project-blurb": "project blurb",
  "prose-heading": "heading",
  "interests-note": "note",
};

/* ----------------------------------------------------------------- bar */

export function DesignBar({
  surface,
  onSurface,
  layout,
  vocabulary,
  saving,
  pages,
  selection,
  onSelect,
  onToken,
  onSections,
  children,
}: {
  surface: "profile" | "resume";
  onSurface: (surface: "profile" | "resume") => void;
  layout: Layout;
  vocabulary: Vocabulary;
  saving: boolean;
  pages: Pages | null;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  onToken: (name: string, value: string) => void;
  onSections: (sections: LayoutSection[]) => void;
  /** The export control, which belongs to the surface rather than the bar. */
  children?: ReactNode;
}) {
  const sections = layout.spec.sections;
  const notes = Object.fromEntries(vocabulary.sections.map((s) => [s.kind, s.note]));

  const index = selection ? sections.findIndex((s) => s.kind === selection.section) : -1;
  const chosen = index >= 0 ? sections[index] : undefined;

  const replace = (at: number, next: LayoutSection) =>
    onSections(sections.map((section, i) => (i === at ? next : section)));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= sections.length) return;
    const next = [...sections];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onSections(next);
  };

  const tokenControl = (name: string) => {
    const def = vocabulary.tokens[name];
    if (!def || !def.surfaces.includes(surface)) return null;
    return (
      <TokenControl
        key={name}
        name={name}
        def={def}
        value={layout.tokens[name]}
        fallback={vocabulary.defaults[surface][name] ?? ""}
        onChange={(value) => onToken(name, value)}
      />
    );
  };

  return (
    <div className="design-bar">
      <div className="bar-group">
        <div className="surface-switch">
          <button aria-selected={surface === "resume"} onClick={() => onSurface("resume")}>
            Resume
          </button>
          <button aria-selected={surface === "profile"} onClick={() => onSurface("profile")}>
            Profile
          </button>
        </div>
        <span className="saving">{saving ? "saving…" : ""}</span>
      </div>

      <div className="bar-group bar-middle">
        {chosen ? (
          /* What was clicked, and the few things that act on it. */
          <>
            <span className="selection-chip" title={selection?.text}>
              <strong>{chosen.kind}</strong>
              {selection?.field && <span className="chip-field">{FIELD_NAMES[selection.field] ?? selection.field}</span>}
              {selection?.text && <span className="chip-text">{selection.text}</span>}
            </span>

            {chosen.kind !== "header" && (
              <input
                className="bar-heading-input"
                value={chosen.heading ?? ""}
                placeholder="(no heading)"
                aria-label={`Heading for ${chosen.kind}`}
                onChange={(e) => replace(index, { ...chosen, heading: e.target.value })}
              />
            )}

            {(chosen.kind === "experience" || chosen.kind === "skills") && (
              <Popover label="Options">
                <SectionOptions section={chosen} onChange={(next) => replace(index, next)} />
              </Popover>
            )}

            <Popover label="Style" wide>
              <p className="editor-note">
                Styling is the whole document's. These move every section like this one, not only the one
                selected.
              </p>
              {(AFFECTS[chosen.kind] ?? []).map(tokenControl)}
            </Popover>

            <div className="section-move">
              <button className="ghost" onClick={() => move(index, index - 1)} disabled={index === 0} aria-label="Move up">
                ↑
              </button>
              <button
                className="ghost"
                onClick={() => move(index, index + 1)}
                disabled={index === sections.length - 1}
                aria-label="Move down"
              >
                ↓
              </button>
            </div>

            <button className="ghost" onClick={() => replace(index, { ...chosen, visible: false })}>
              Hide
            </button>
            <button className="ghost" onClick={() => onSelect(null)} aria-label="Clear the selection">
              ✕
            </button>
          </>
        ) : (
          /* Nothing chosen: the template as a whole. */
          <>
            <Popover label="Sections" wide>
              <p className="editor-note">
                The order here is the order on the page. Hidden sections keep their place for when you want
                them back.
              </p>
              <ul className="section-list">
                {sections.map((section, at) => (
                  <SectionRow
                    key={section.kind}
                    section={section}
                    index={at}
                    count={sections.length}
                    note={notes[section.kind] ?? ""}
                    onChange={(next) => replace(at, next)}
                    onMove={(to) => move(at, to)}
                    onSelect={() => onSelect({ section: section.kind, text: "" })}
                  />
                ))}
              </ul>
            </Popover>

            {GROUPS.map(([title, names]) => {
              const controls = names.map(tokenControl).filter(Boolean);
              if (controls.length === 0) return null;
              return (
                <Popover key={title} label={title}>
                  {controls}
                </Popover>
              );
            })}

            <span className="bar-hint">Click the document to style a part of it.</span>
          </>
        )}
      </div>

      <div className="bar-group bar-right">
        <span className="bar-measure">
          {surface === "resume" ? "8.5in × 11in" : "Public profile"}
          {pages && (
            <>
              {" · "}
              <strong>
                {pages.count} page{pages.count === 1 ? "" : "s"}
              </strong>
              {pages.fill > 0.9 && <span className="warn"> · last page nearly full</span>}
              {pages.fill < 0.25 && pages.count > 1 && <span className="warn"> · last page almost empty</span>}
            </>
          )}
        </span>
        {children}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Layout, type LayoutSection, type TokenDef, type Vocabulary } from "../api.ts";
import { useChanges } from "../changes.ts";
import { Document, type Pages } from "./Document.tsx";

/**
 * Styling the profile and the resume.
 *
 * Every control here is generated from `/api/layout/vocabulary`, which the
 * server builds from the same definitions its validator uses. A control the
 * UI invents would be a control the server refuses, and the person would
 * find out by watching a change not happen.
 *
 * There is no field for writing CSS, and that is deliberate rather than
 * unfinished. See the README.
 */

type Surface = "profile" | "resume";

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

/* -------------------------------------------------------------- sections */

function SectionRow({
  section,
  index,
  count,
  note,
  onChange,
  onMove,
}: {
  section: LayoutSection;
  index: number;
  count: number;
  note: string;
  onChange: (next: LayoutSection) => void;
  onMove: (to: number) => void;
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
          <span className="section-kind" title={note}>
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

      {section.visible && section.kind === "experience" && (
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
      )}

      {section.visible && section.kind === "skills" && (
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
      )}
    </li>
  );
}

/* ---------------------------------------------------------------- editor */


/**
 * Download the resume as a PDF.
 *
 * A plain link would be simpler, but a failure would then replace the app
 * with a page of JSON — and this fails for ordinary reasons, chiefly Chrome
 * not being where the server expects it. Fetching lets the failure stay on
 * this screen, next to the thing it is about.
 */
function ExportPdf() {
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");
  const [why, setWhy] = useState<string | null>(null);

  const download = async () => {
    setState("working");
    setWhy(null);
    try {
      const response = await fetch("/api/resume.pdf");
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();
      const name =
        /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "resume.pdf";

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      // Revoked on the next tick: Safari has not started reading the blob
      // when click() returns, and revoking at once gives an empty file.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setState("idle");
    } catch (problem) {
      setState("failed");
      setWhy((problem as Error).message);
    }
  };

  return (
    <span className="export-pdf">
      {why && <span className="warn" title={why}>{why.slice(0, 60)}</span>}
      <button className="ghost" onClick={() => void download()} disabled={state === "working"}>
        {state === "working" ? "making the PDF…" : state === "failed" ? "Try again" : "Download PDF ↓"}
      </button>
    </span>
  );
}

export function LayoutEditor({ onSurface }: { onSurface?: (surface: Surface) => void }) {
  const [surface, setSurface] = useState<Surface>("resume");

  // Reported upward so the agent can be told which of the two is on screen.
  // "Make this warmer" means the one being looked at.
  useEffect(() => onSurface?.(surface), [surface, onSurface]);
  const [vocabulary, setVocabulary] = useState<Vocabulary | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pages, setPages] = useState<Pages | null>(null);

  const pending = useRef<number | undefined>(undefined);

  /*
    The agent styles through the same calls this panel makes, so its changes
    land on the controls and in the document. Held while a save of ours is in
    flight: taking the server's copy mid-write would show the value we are
    about to replace, then flip back a moment later.
  */
  useChanges(
    "layout",
    () => {
      void api
        .layouts(surface)
        .then((list) => {
          if (list[0]) setLayout(list[0]);
        })
        .catch(() => undefined);
    },
    () => saving,
  );

  useEffect(() => {
    void api.vocabulary().then(setVocabulary).catch(() => setError("Could not read what can be styled."));
  }, []);

  useEffect(() => {
    setPages(null);
    void api
      .layouts(surface)
      .then((list) => setLayout(list[0] ?? null))
      .catch(() => setError("Could not load the layout."));
  }, [surface]);

  /*
    Saved after a pause, not on every drag of a slider.

    A range input fires continuously, and a save is a write to the database.
    Waiting until the hand stops turns forty writes into one. The document
    does not wait for any of them: it is rendered from the state above, so a
    dragged slider shows while it is being dragged, and the save is only how
    it is kept.
  */
  const save = useCallback(
    (patch: { spec?: unknown; tokens?: Record<string, string> }, immediate = false) => {
      if (!layout) return;
      window.clearTimeout(pending.current);

      const run = async () => {
        setSaving(true);
        try {
          const next = await api.saveLayout(layout.id, patch);
          setLayout(next);
          setError(null);
        } catch (problem) {
          // The server's message names the token or section it refused, and
          // it is written to be read. Show it rather than a generic failure.
          setError((problem as Error).message);
        } finally {
          setSaving(false);
        }
      };

      if (immediate) void run();
      else pending.current = window.setTimeout(() => void run(), 250);
    },
    [layout],
  );

  // The page count is measured in the document itself, which reports it on
  // every change. See Document.tsx.

  const setSections = (sections: LayoutSection[]) => {
    setLayout((current) => (current ? { ...current, spec: { sections } } : current));
    save({ spec: { sections } }, true);
  };

  const move = (from: number, to: number) => {
    if (!layout || to < 0 || to >= layout.spec.sections.length) return;
    const sections = [...layout.spec.sections];
    const [moved] = sections.splice(from, 1);
    sections.splice(to, 0, moved!);
    setSections(sections);
  };

  const groups = useMemo(() => {
    if (!vocabulary) return [];
    const order: [string, string[]][] = [
      ["Colour", ["ink", "muted", "accent", "paper", "rule"]],
      ["Lettering", ["fontHeading", "fontBody", "fontSize", "lineHeight", "headingScale", "headingWeight", "headingCase", "headingTracking"]],
      ["Spacing", ["density", "sectionGap", "entryGap", "bulletGap"]],
      ["Page", ["pageMargin", "columns", "rulesStyle", "maxWidth", "cornerRadius"]],
    ];
    return order
      .map(([title, names]) => [
        title,
        names.filter((name) => vocabulary.tokens[name]?.surfaces.includes(surface)),
      ] as [string, string[]])
      .filter(([, names]) => names.length > 0);
  }, [vocabulary, surface]);

  if (!vocabulary || !layout) {
    return <div className="empty">{error ?? "Loading…"}</div>;
  }

  const notes = Object.fromEntries(vocabulary.sections.map((s) => [s.kind, s.note]));

  return (
    <div className="layout-editor">
      <div className="editor-controls">
        <div className="surface-switch">
          <button aria-selected={surface === "resume"} onClick={() => setSurface("resume")}>
            Resume
          </button>
          <button aria-selected={surface === "profile"} onClick={() => setSurface("profile")}>
            Profile
          </button>
          <span className="saving">{saving ? "saving…" : ""}</span>
        </div>

        {error && <div className="banner error">{error}</div>}

        <h3>Sections</h3>
        <p className="editor-note">
          The order here is the order on the page. Hidden sections keep their place for when you want them
          back.
        </p>
        <ul className="section-list">
          {layout.spec.sections.map((section, index) => (
            <SectionRow
              key={section.kind}
              section={section}
              index={index}
              count={layout.spec.sections.length}
              note={notes[section.kind] ?? ""}
              onChange={(next) =>
                setSections(layout.spec.sections.map((s, i) => (i === index ? next : s)))
              }
              onMove={(to) => move(index, to)}
            />
          ))}
        </ul>

        {groups.map(([title, names]) => (
          <section key={title} className="token-group">
            <h3>{title}</h3>
            {names.map((name) => (
              <TokenControl
                key={name}
                name={name}
                def={vocabulary.tokens[name]!}
                value={layout.tokens[name]}
                fallback={vocabulary.defaults[surface][name] ?? ""}
                onChange={(value) => {
                  setLayout((current) =>
                    current
                      ? {
                          ...current,
                          tokens:
                            value === ""
                              ? Object.fromEntries(Object.entries(current.tokens).filter(([k]) => k !== name))
                              : { ...current.tokens, [name]: value },
                        }
                      : current,
                  );
                  save({ tokens: { [name]: value } });
                }}
              />
            ))}
          </section>
        ))}

        <p className="editor-note">
          There is no box for writing CSS. Styling is these controls, and the agent sets the same ones — ask it
          for "warmer and more traditional" and watch them move.
        </p>
      </div>

      <div className="editor-preview">
        <div className="preview-bar">
          <span>
            {surface === "resume" ? "8.5in × 11in" : "Public profile"}
            {pages && (
              <>
                {" · "}
                <strong>
                  {pages.count} page{pages.count === 1 ? "" : "s"}
                </strong>
                {pages.fill > 0.9 && <span className="warn"> · last page nearly full</span>}
                {pages.fill < 0.25 && pages.count > 1 && (
                  <span className="warn"> · last page almost empty</span>
                )}
              </>
            )}
          </span>
          {surface === "resume" ? (
            <ExportPdf />
          ) : (
            <a href={`/api/render/${surface}`} target="_blank" rel="noreferrer" className="ghost">
              Open the page →
            </a>
          )}
        </div>
        <Document
          surface={surface}
          paged
          spec={layout.spec}
          tokens={layout.tokens}
          onPages={setPages}
          onError={setError}
        />
      </div>
    </div>
  );
}

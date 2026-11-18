import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Layout, type LayoutSection, type ResumeSummary, type Vocabulary } from "../api.ts";
import { useChanges } from "../changes.ts";
import { Document, type Pages, type Selection } from "./Document.tsx";
import { DesignBar } from "./DesignBar.tsx";

/**
 * Styling the profile and the resume.
 *
 * The document is the page, and the controls are a bar above it. Clicking a
 * part of the document says which part the bar is about; clicking the paper
 * around it says none. This file owns that state and the saving, and knows
 * nothing about how either is drawn — see DesignBar.tsx and Document.tsx.
 *
 * Every control is generated from `/api/layout/vocabulary`, which the server
 * builds from the same definitions its validator uses. There is no field for
 * writing CSS, and that is deliberate rather than unfinished. See the README.
 */

type Surface = "profile" | "resume";

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

export function LayoutEditor({
  onSurface,
  onSelection,
  onDraft,
  onAsk,
}: {
  onSurface?: (surface: Surface) => void;
  /** Reported upward so the agent can be told what "this" is. */
  onSelection?: (selection: Selection | null) => void;
  onDraft?: (id: number | null) => void;
  /** Put a question about the selection in the assistant's box. */
  onAsk?: (text: string) => void;
}) {
  const [surface, setSurface] = useState<Surface>("resume");

  // Reported upward so the agent can be told which of the two is on screen.
  // "Make this warmer" means the one being looked at.
  useEffect(() => onSurface?.(surface), [surface, onSurface]);

  const [vocabulary, setVocabulary] = useState<Vocabulary | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pages, setPages] = useState<Pages | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  /*
    Which content the template is showing: the stored profile, or one saved
    draft. It decides where typing goes — a bullet on the profile is the
    fact itself, and the same bullet on a draft is that draft's wording of
    it. See Document.tsx for why both ids travel with the line.
  */
  const [drafts, setDrafts] = useState<ResumeSummary[]>([]);
  const [draftId, setDraftId] = useState<number | null>(null);

  const pending = useRef<number | undefined>(undefined);

  /*
    The agent styles through the same calls this bar makes, so its changes
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

  const loadDrafts = useCallback(() => {
    void api.resumes().then(setDrafts).catch(() => undefined);
  }, []);
  useEffect(loadDrafts, [loadDrafts]);
  useChanges("resumes", loadDrafts);

  // A draft is a resume, so it has nothing to say about the public profile.
  useEffect(() => {
    if (surface !== "resume") setDraftId(null);
  }, [surface]);

  /*
    Changing which content is shown drops the selection.

    Without this the bar went on describing the line that was selected a
    moment ago — including where typing would go. "This draft only" over a
    document that is no longer the draft is the one kind of wrong this bar
    must not be.
  */
  useEffect(() => setSelection(null), [draftId]);

  // Both reported upward, for the same reason the surface is: so that what
  // the agent is told matches what is on the screen.
  useEffect(() => onSelection?.(selection), [selection, onSelection]);
  useEffect(() => onDraft?.(draftId), [draftId, onDraft]);

  useEffect(() => {
    setPages(null);
    // A selection names a section of the surface it was made on.
    setSelection(null);
    void api
      .layouts(surface)
      .then((list) => setLayout(list[0] ?? null))
      .catch(() => setError("Could not load the layout."));
  }, [surface]);

  /*
    Saved after a pause, not on every drag of a slider.

    A range input fires continuously, and a save is a write to the database.
    Waiting until the hand stops turns forty writes into one. The document
    does not wait for any of them: it is rendered from the state below, so a
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

  const setSections = (sections: LayoutSection[]) => {
    setLayout((current) => (current ? { ...current, spec: { sections } } : current));
    save({ spec: { sections } }, true);
  };

  const setToken = (name: string, value: string) => {
    setLayout((current) =>
      current
        ? {
            ...current,
            tokens:
              value === ""
                ? Object.fromEntries(Object.entries(current.tokens).filter(([key]) => key !== name))
                : { ...current.tokens, [name]: value },
          }
        : current,
    );
    save({ tokens: { [name]: value } });
  };

  /**
   * Where typed words go.
   *
   * The document says what was typed and what it was part of; this decides
   * what that means. The one distinction worth stating: a bullet on a saved
   * draft writes to that draft's line, which is checked against the stored
   * fact and may come back with a warning. The same bullet on the profile
   * writes to the fact itself, and changes every resume that cites it.
   */
  const commit = (chosen: Selection, text: string) => {
    const done = (work: Promise<unknown>) =>
      void work.then(() => setError(null)).catch((problem: Error) => setError(problem.message));

    if (chosen.field === "heading" && layout) {
      const at = layout.spec.sections.findIndex((section) => section.kind === chosen.section);
      if (at < 0) return;
      setSections(
        layout.spec.sections.map((section, i) => (i === at ? { ...section, heading: text } : section)),
      );
      return;
    }

    if (chosen.line != null && draftId != null) {
      done(api.saveResumeLine(draftId, chosen.line, text));
      return;
    }

    switch (chosen.field) {
      case "name":
      case "headline":
        done(api.patchProfile({ [chosen.field]: text }));
        return;

      case "summary":
        // On a draft, the summary belongs to the draft: it was written for
        // one posting, and it is checked against the whole profile.
        done(draftId == null ? api.patchProfile({ summary: text }) : api.saveResume(draftId, { summary: text }));
        return;

      case "title":
      case "company":
        if (chosen.role != null) done(api.patchRole(chosen.role, { [chosen.field]: text }));
        return;

      case "bullet":
        if (chosen.bullet != null) done(api.patchBullet(chosen.bullet, text));
        return;

      case "prose-heading":
        if (chosen.prose != null) done(api.saveSection(chosen.prose, { heading: text }));
        return;

      case "project-name":
        if (chosen.project != null) done(api.saveProject(chosen.project, { name: text }));
        return;

      case "project-blurb":
        if (chosen.project != null) done(api.saveProject(chosen.project, { blurb: text }));
        return;
    }
  };

  if (!vocabulary || !layout) {
    return <div className="empty">{error ?? "Loading…"}</div>;
  }

  return (
    <div className="layout-editor">
      <DesignBar
        surface={surface}
        onSurface={setSurface}
        layout={layout}
        vocabulary={vocabulary}
        saving={saving}
        pages={pages}
        selection={selection}
        onSelect={setSelection}
        onToken={setToken}
        onSections={setSections}
        drafts={drafts}
        draftId={draftId}
        onDraft={setDraftId}
        onAsk={onAsk}
      >
        {surface === "resume" ? (
          <ExportPdf />
        ) : (
          <a href={`/api/render/${surface}`} target="_blank" rel="noreferrer" className="ghost">
            Open the page →
          </a>
        )}
      </DesignBar>

      {error && <div className="banner error">{error}</div>}

      <div className="editor-stage">
        <Document
          surface={surface}
          resumeId={draftId}
          paged
          spec={layout.spec}
          tokens={layout.tokens}
          selection={selection}
          onSelect={setSelection}
          onEdit={commit}
          onPages={setPages}
          onError={setError}
        />
      </div>
    </div>
  );
}

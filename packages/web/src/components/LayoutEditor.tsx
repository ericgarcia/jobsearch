import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Layout, type LayoutSection, type Vocabulary } from "../api.ts";
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
  const [selection, setSelection] = useState<Selection | null>(null);

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
          paged
          spec={layout.spec}
          tokens={layout.tokens}
          selection={selection}
          onSelect={setSelection}
          onPages={setPages}
          onError={setError}
        />
      </div>
    </div>
  );
}

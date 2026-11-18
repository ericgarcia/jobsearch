import { useCallback, useEffect, useRef, useState } from "react";
import { renderBody, renderDocument } from "@jobsearch/layout/render";
import { cssVariables } from "@jobsearch/layout/tokens";
import type { LayoutSpec } from "@jobsearch/layout/spec";
import { api, type DocumentPayload } from "../api.ts";
import { useChanges } from "../changes.ts";

/**
 * The profile or the resume, rendered here rather than fetched as a page.
 *
 * It is the same `renderDocument` the server uses — the layout package
 * touches no Node API, which is what makes that possible — so what is on
 * screen is what the PDF route and the public page produce. A test compares
 * the two strings rather than trusting that sentence.
 *
 * Still in an iframe, and deliberately. The resume stylesheet is written
 * against a document body: `@page`, `body.resume .doc`, the page-edge ruler.
 * Those rules need a document to be about. What changes is that the document
 * is now ours to write into, so a moved slider is a style patch rather than
 * a round trip and a reload.
 */

const PAGE_PX = 11 * 96; // Letter, at the 96dpi CSS assumes.

export interface Pages {
  count: number;
  /** How much of the last page is used, 0 to 1. */
  fill: number;
}

/**
 * What a click landed on.
 *
 * `section` is always there, because every element in the document is in
 * one. The ids are whatever was under the pointer: a bullet carries its
 * role, its stored fact and, on a tailored draft, the line that words it.
 * `field` names the piece of text itself, which is what slice three will
 * let someone type into.
 */
export interface Selection {
  section: string;
  field?: string;
  role?: number;
  bullet?: number;
  line?: number;
  project?: number;
  education?: number;
  skill?: number;
  prose?: number;
  /** What it says now, for the bar to name it by. */
  text: string;
}

/** Every id a selection can carry, in the order a bar should prefer them. */
const IDS = ["line", "bullet", "project", "education", "skill", "prose", "role"] as const;

/**
 * The element a selection points at, found again after a re-render.
 *
 * Patching the body replaces every node, so a held reference is stale the
 * moment anything changes. A selector describes the thing rather than the
 * node, and survives.
 */
function selectorFor(selection: Selection): string {
  for (const name of IDS) {
    const id = selection[name];
    if (id !== undefined) {
      return selection.field ? `[data-${name}="${id}"][data-field]` : `[data-${name}="${id}"]`;
    }
  }
  return selection.field
    ? `[data-section="${selection.section}"] [data-field="${selection.field}"], [data-section="${selection.section}"][data-field="${selection.field}"]`
    : `[data-section="${selection.section}"]`;
}

/**
 * The editor's own stylesheet, injected into the document rather than part
 * of it. `stylesheet()` describes a resume on paper; an outline around the
 * thing you are editing is not something that can ever print.
 */
const EDITOR_CSS = `
[data-section] { cursor: default; }
[data-field], [data-role], [data-bullet], [data-line], [data-project], [data-education], [data-skill], [data-prose] { cursor: pointer; }
.jobsearch-hover { outline: 1px dashed rgba(59, 130, 246, 0.5); outline-offset: 2px; }
.jobsearch-selected, .jobsearch-selected.jobsearch-hover {
  outline: 2px solid #3b82f6;
  outline-offset: 3px;
}
@media print { .jobsearch-hover, .jobsearch-selected { outline: 0; } }
`;

const ANNOTATED =
  "[data-field], [data-role], [data-bullet], [data-line], [data-project], [data-education], [data-skill], [data-prose], [data-section]";

/** The most specific thing the pointer is over, or nothing. */
function nearest(start: Element | null): Element | null {
  return start?.closest?.(ANNOTATED) ?? null;
}

/** What was clicked, named by every id that encloses it. */
function resolve(start: Element | null): Selection | null {
  const section = start?.closest?.("[data-section]");
  if (!section) return null;

  const id = (name: string): number | undefined => {
    const raw = start?.closest(`[data-${name}]`)?.getAttribute(`data-${name}`);
    return raw == null ? undefined : Number(raw);
  };

  const chosen = nearest(start) ?? section;
  return {
    section: section.getAttribute("data-section") ?? "",
    field: start?.closest("[data-field]")?.getAttribute("data-field") ?? undefined,
    role: id("role"),
    bullet: id("bullet"),
    line: id("line"),
    project: id("project"),
    education: id("education"),
    skill: id("skill"),
    prose: id("prose"),
    text: (chosen.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
  };
}

export function Document({
  surface,
  resumeId = null,
  paged = false,
  spec,
  tokens,
  selection = null,
  onSelect,
  onPages,
  onError,
}: {
  surface: "profile" | "resume";
  /** A tailored draft instead of the stored profile. */
  resumeId?: number | null;
  paged?: boolean;
  /** The layout being edited, when the caller holds a live copy of it. */
  spec?: LayoutSpec;
  tokens?: Record<string, string>;
  /** What is selected. Given back, so the caller owns it. */
  selection?: Selection | null;
  onSelect?: (selection: Selection | null) => void;
  onPages?: (pages: Pages | null) => void;
  onError?: (message: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [payload, setPayload] = useState<DocumentPayload | null>(null);

  /*
    The shell is written once; everything after it is a patch. `written`
    counts the writes so the patching effects below run again after a new
    document replaces the one they edited.
  */
  const [written, setWritten] = useState<{ n: number; surface: string } | null>(null);

  // Held in refs as well as props: the shell effect needs the current values
  // without being re-run — and re-running it is the reload we are removing.
  const live = useRef({ spec, tokens, payload, paged });
  live.current = { spec, tokens, payload, paged };

  const report = useRef({ onPages, onError, onSelect });
  report.current = { onPages, onError, onSelect };

  const load = useCallback(() => {
    void api
      .document(surface, resumeId)
      .then(setPayload)
      .catch((problem: Error) => report.current.onError?.(problem.message));
  }, [surface, resumeId]);

  useEffect(load, [load]);

  /*
    Nothing to show while the other surface is being fetched. Without this
    the resume's stylesheet would be written around the profile's content for
    as long as the request took, which reads as a rendering fault.
  */
  useEffect(() => setPayload(null), [surface, resumeId]);

  // The content can change under a layout that did not: the agent writes a
  // bullet, and the document on screen is then out of date.
  useChanges("profile", load);
  useChanges("projects", load);
  useChanges("sections", load);
  useChanges("interests", load);
  useChanges("resumes", load);

  const measure = useCallback(() => {
    const onPages = report.current.onPages;
    if (!onPages) return;
    if (surface !== "resume") return onPages(null);

    const document_ = frame.current?.contentDocument;
    const doc = document_?.querySelector(".doc");
    if (!document_ || !doc) return;

    /*
      The content's own extent, not the box around it.

      The preview draws a page: `min-height: 11in`. Measuring that box said
      every short resume filled a page exactly, so a nearly empty one was
      reported as "last page nearly full" — a warning about the opposite of
      what was wrong. The last element's bottom edge, plus the margin below
      it, is where the text actually ends.
    */
    const last = doc.lastElementChild;
    const view = document_.defaultView;
    const padding = view ? Number.parseFloat(view.getComputedStyle(doc).paddingBottom) || 0 : 0;
    const height = last
      ? last.getBoundingClientRect().bottom - doc.getBoundingClientRect().top + padding
      : doc.getBoundingClientRect().height;

    onPages({
      count: Math.max(1, Math.ceil(height / PAGE_PX)),
      fill: (height % PAGE_PX || PAGE_PX) / PAGE_PX,
    });
  }, [surface]);

  /* ------------------------------------------------------------- the shell */

  useEffect(() => {
    const window_ = frame.current?.contentWindow;
    const current = live.current;
    if (!window_ || !current.payload) return;

    const document_ = window_.document;
    /*
      `write`, not `srcdoc`. It is synchronous, so the patches below find a
      document that exists; srcdoc would land on the next load event and the
      first patch of a surface would silently do nothing.
    */
    document_.open();
    document_.write(
      renderDocument({
        spec: current.spec ?? current.payload.layout.spec,
        tokens: current.tokens ?? current.payload.layout.tokens,
        content: current.payload.content,
        surface,
        paged: current.paged,
        // Only here. The PDF and the public page are rendered by the server
        // without it, and a test holds them to that.
        annotate: true,
      }),
    );
    document_.close();

    const editor = document_.createElement("style");
    editor.id = "editor-only";
    editor.textContent = EDITOR_CSS;
    document_.head.append(editor);

    /*
      One style element, appended after the renderer's own, holding whatever
      the caller is editing. Same specificity, later in the document, so it
      wins — and a token change is one `textContent` assignment rather than a
      new document. Empty until the first patch.
    */
    const live_ = document_.createElement("style");
    live_.id = "live-tokens";
    document_.head.append(live_);

    /*
      A click selects what is under it.

      A link would otherwise navigate the frame, and the document would
      become whatever site was linked, with no way back. Here a link is a
      line of a document, not something to follow — so it is selected like
      anything else, and opened in a tab of its own only on a second click
      with a modifier held.
    */
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a");

      if (anchor && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        const href = anchor.getAttribute("href");
        if (href) window.open(href, "_blank", "noopener,noreferrer");
        return;
      }
      if (anchor) event.preventDefault();

      report.current.onSelect?.(resolve(target));
    };

    /*
      A dashed outline follows the pointer, so that a document people have
      only ever read makes it plain that its parts can be taken hold of.
    */
    let hovered: Element | null = null;
    const onMove = (event: MouseEvent) => {
      const next = nearest(event.target as Element | null);
      if (next === hovered) return;
      hovered?.classList.remove("jobsearch-hover");
      hovered = next;
      hovered?.classList.add("jobsearch-hover");
    };
    const onLeave = () => {
      hovered?.classList.remove("jobsearch-hover");
      hovered = null;
    };

    // Escape inside the frame as well as outside it: the pointer is in the
    // document, so that is where the key goes.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") report.current.onSelect?.(null);
    };

    document_.addEventListener("click", onClick);
    document_.addEventListener("mousemove", onMove);
    document_.addEventListener("mouseleave", onLeave);
    document_.addEventListener("keydown", onKey);

    setWritten((previous) => ({ n: (previous?.n ?? 0) + 1, surface }));
    return () => {
      document_.removeEventListener("click", onClick);
      document_.removeEventListener("mousemove", onMove);
      document_.removeEventListener("mouseleave", onLeave);
      document_.removeEventListener("keydown", onKey);
    };
    // Not on spec, tokens or content: those are patched, which is the point.
  }, [surface, payload !== null]);

  /* ------------------------------------------------------------ the patches */

  const tokenKey = JSON.stringify(tokens ?? payload?.layout.tokens ?? {});

  useEffect(() => {
    // A document written for the other surface is not ours to patch.
    if (written?.surface !== surface) return;
    const document_ = frame.current?.contentDocument;
    const element = document_?.getElementById("live-tokens");
    if (!element) return;

    const values = tokens ?? payload?.layout.tokens;
    if (!values) return;
    // cssVariables puts a refused value back to the default rather than
    // dropping it, so an unfinished edit cannot leave a page unreadable.
    element.textContent = `:root {\n${cssVariables(surface, values)}\n}`;
    measure();
  }, [written, tokenKey, surface, measure]);

  const specKey = JSON.stringify(spec ?? payload?.layout.spec ?? null);

  useEffect(() => {
    if (written?.surface !== surface) return;
    const document_ = frame.current?.contentDocument;
    const main = document_?.querySelector("main.doc");
    if (!document_ || !main) return;

    const sections = spec ?? payload?.layout.spec;
    if (!sections || !payload) return;

    // Annotated, like the shell. A patch that forgot the flag would strip
    // every id from the document and leave nothing selectable.
    main.innerHTML = renderBody(sections, payload.content, surface, true);
    document_.body.classList.toggle("paged", paged);
    // After layout, not during it: the height of a document being replaced
    // is the height of neither version.
    requestAnimationFrame(measure);
  }, [written, specKey, payload, paged, surface, measure, spec]);

  /*
    The outline is put back after every patch, not held on a node.

    Patching the body replaces every element in it, so a remembered node is
    detached the moment a heading is renamed. The selection describes what
    it points at — a bullet id, a field in a section — and is found again.
    Declared after the patch above so it runs on the new document.
  */
  useEffect(() => {
    if (written?.surface !== surface) return;
    const document_ = frame.current?.contentDocument;
    if (!document_) return;

    for (const marked of document_.querySelectorAll(".jobsearch-selected")) {
      marked.classList.remove("jobsearch-selected");
    }
    if (!selection) return;
    document_.querySelector(selectorFor(selection))?.classList.add("jobsearch-selected");
  }, [written, selection, surface, specKey, payload]);

  return (
    <iframe
      ref={frame}
      className="document-frame"
      title={`${surface} document`}
      /*
        No sandbox: the markup is ours, every value in it is escaped, and the
        frame is same-origin on purpose — reading into it is how the page
        count is measured and how a click will find its section.
      */
    />
  );
}

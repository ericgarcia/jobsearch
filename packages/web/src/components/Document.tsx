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

export function Document({
  surface,
  resumeId = null,
  paged = false,
  spec,
  tokens,
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

  const report = useRef({ onPages, onError });
  report.current = { onPages, onError };

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

    const doc = frame.current?.contentDocument?.querySelector(".doc");
    if (!doc) return;
    const height = doc.getBoundingClientRect().height;
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
      }),
    );
    document_.close();

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
      A link in the document would otherwise navigate the frame, and the
      preview would become whatever site was linked, with no way back. The
      document is a document here, not a page being browsed.
    */
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      event.preventDefault();
      const href = anchor.getAttribute("href");
      if (href) window.open(href, "_blank", "noopener,noreferrer");
    };
    document_.addEventListener("click", onClick);

    setWritten((previous) => ({ n: (previous?.n ?? 0) + 1, surface }));
    return () => document_.removeEventListener("click", onClick);
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

    main.innerHTML = renderBody(sections, payload.content, surface);
    document_.body.classList.toggle("paged", paged);
    // After layout, not during it: the height of a document being replaced
    // is the height of neither version.
    requestAnimationFrame(measure);
  }, [written, specKey, payload, paged, surface, measure, spec]);

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

import { callBrowser } from "../agent/browserClient.js";
import { PORT } from "../config.js";

/**
 * How many letter pages a resume comes to.
 *
 * There is no way to know this without laying the text out, and laying text
 * out is what a browser does. Estimating from character counts would give a
 * number that is wrong in exactly the case that matters — the resume sitting
 * a few lines over a page break.
 *
 * So it is measured in a real browser, in a tab opened and closed for the
 * purpose. That costs a tab appearing briefly, which is the honest price of
 * an answer rather than a guess.
 *
 * This exists because the agent asked for it and could not get it: the
 * preview tool described a page count it never returned, so the agent
 * restyled a resume and then had to tell the person it could not say whether
 * the result still fitted.
 */

const PAGE_HEIGHT_PX = 11 * 96; // Letter, at the 96dpi CSS assumes.

export interface PageMeasurement {
  pages: number;
  /** How much of the last page is used, 0 to 1. Near 1 means a tight fit. */
  lastPageFill: number;
  heightPx: number;
}

function text(result: { content?: { text?: string }[] }): string {
  return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

/** The index of the tab showing `url`, from a Playwright tab listing. */
function indexOf(listing: string, needle: string): number | null {
  for (const line of listing.split("\n").map((l) => l.trim())) {
    if (/^-\s+\d+:/.test(line) && line.includes(needle)) {
      return Number(/^-\s+(\d+):/.exec(line)![1]);
    }
  }
  return null;
}

export async function measurePages(path: string): Promise<PageMeasurement> {
  const url = `http://127.0.0.1:${PORT}${path}`;
  const opened = await callBrowser("browser_tabs", { action: "new", url });
  if (opened.isError === true) throw new Error(text(opened));

  try {
    const listing = text(await callBrowser("browser_tabs", { action: "list" }));
    const index = indexOf(listing, path.split("?")[0] ?? path);
    if (index !== null) await callBrowser("browser_tabs", { action: "select", index });

    const measured = await callBrowser("browser_evaluate", {
      function: `() => {
        const doc = document.querySelector(".doc");
        if (!doc) return { error: "no document" };
        const height = doc.getBoundingClientRect().height;
        return { heightPx: Math.round(height) };
      }`,
    });

    const match = /"heightPx"\s*:\s*(\d+)/.exec(text(measured));
    if (!match) throw new Error(`Could not measure the page: ${text(measured).slice(0, 200)}`);

    const heightPx = Number(match[1]);
    const pages = Math.max(1, Math.ceil(heightPx / PAGE_HEIGHT_PX));
    return {
      pages,
      lastPageFill: Number(((heightPx % PAGE_HEIGHT_PX || PAGE_HEIGHT_PX) / PAGE_HEIGHT_PX).toFixed(2)),
      heightPx,
    };
  } finally {
    // Always, including after a failure: a measurement must not leave a tab
    // behind in someone's browser.
    const listing = text(await callBrowser("browser_tabs", { action: "list" }));
    const index = indexOf(listing, path.split("?")[0] ?? path);
    if (index !== null) await callBrowser("browser_tabs", { action: "close", index });
  }
}

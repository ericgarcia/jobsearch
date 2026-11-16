import { chromium, type Browser } from "playwright-core";
import { PORT } from "../config.js";

/**
 * Export a resume as a PDF.
 *
 * Chrome does the typesetting. Nothing else here would do it as well: a PDF
 * library would mean a second renderer and a second set of layout rules to
 * keep in step with the stylesheet, and the two would drift until the file
 * someone sends to an employer stopped matching what they approved on screen.
 *
 * Rasterising the page — html2canvas and friends — is not an option at all.
 * An applicant tracking system reads the text out of the file before any
 * person sees it, and a picture of a resume has no text in it. The PDFs this
 * produces hold real fonts and no images, which `npm test` checks.
 *
 * It uses the Chrome that is already installed, headless, through
 * `channel: "chrome"`. That needs no browser download: this product already
 * requires Chrome, because Split Pilot runs in it. The user's own windows are
 * untouched — this is a separate headless instance, not the browser they are
 * looking at.
 */

/*
  Kept warm between exports. Launching Chrome costs the best part of a second
  and someone adjusting a layout exports repeatedly; closing it after each one
  would make the second export as slow as the first.
*/
let browser: Browser | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const IDLE_MS = 60_000;

async function instance(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch (error) {
    throw new Error(
      "Could not start Chrome to make the PDF. This uses the Chrome already " +
        `installed on this machine. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  browser.on("disconnected", () => {
    browser = null;
  });
  return browser;
}

function keepWarm(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void browser?.close().catch(() => {});
    browser = null;
  }, IDLE_MS);
  idleTimer.unref();
}

/** Shut the exporter's browser down. Called when the server stops. */
export async function closePdfBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  const open = browser;
  browser = null;
  await open?.close().catch(() => {});
}

export interface PdfOptions {
  /** Which layout to render through. Omitted uses the default resume layout. */
  layoutId?: number;
  /** A tailored draft. Omitted renders the stored profile. */
  resumeId?: number | null;
}

export async function renderPdf(options: PdfOptions = {}): Promise<Buffer> {
  const path = options.layoutId
    ? `/api/layouts/${options.layoutId}/render`
    : `/api/render/resume`;
  const query = options.resumeId ? `?resume=${options.resumeId}` : "";

  // No `paged=1`: the page-edge guides are a screen aid, and printing hides
  // them anyway, but asking for them would be asking for the wrong document.
  const url = `http://127.0.0.1:${PORT}${path}${query}`;

  const chrome = await instance();
  const page = await chrome.newPage();
  try {
    const response = await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
    if (!response || !response.ok()) {
      throw new Error(`The resume did not render (${response?.status() ?? "no response"}).`);
    }

    return await page.pdf({
      // The stylesheet's own `@page` rule owns the paper size and the margin.
      // Without this Chrome applies its own defaults and the carefully set
      // page margin token means nothing.
      preferCSSPageSize: true,
      printBackground: true,
    });
  } finally {
    await page.close().catch(() => {});
    keepWarm();
  }
}

/** A filename someone will recognise in their downloads folder. */
export function pdfFilename(name: string | null, label?: string | null): string {
  const parts = [name ?? "resume", label ?? ""].filter(Boolean).join(" - ");
  return `${parts.replace(/[^\w .\-]+/g, "").trim() || "resume"}.pdf`;
}

/*
  The same shape browserServer.ts uses: a headless Chrome outliving the
  server it was started for is a process nobody can see and nobody will
  think to kill.
*/
for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void closePdfBrowser();
  });
}

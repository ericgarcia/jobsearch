import { callBrowser } from "./browserClient.js";
import { SPLIT_EXTENSION_ID } from "../config.js";

/**
 * Put the app and a driven page side by side, and keep them that way.
 *
 * The order matters, and it is not the obvious one. Split Pilot can make its
 * own stage tab, but a tab it makes is one Playwright never opened, and the
 * bridge only knows the tabs it opened itself — so the agent would end up
 * watching a pane it could not address. Instead Playwright opens the tab and
 * the extension adopts it: moves it alongside the app and splits with it. The
 * tab stays one the bridge knows, and gains the split and the link routing.
 *
 * Everything here runs through the extension's control surface, which only
 * answers pages on localhost. So the call is made from inside the app's own
 * tab, by evaluating it there.
 */

export interface SplitState {
  paired: boolean;
  split?: boolean;
  left?: { id: number; index: number; url: string };
  right?: { id: number; index: number; url: string };
  error?: string;
}

/*
  Playwright answers in sections, and echoes the code it ran as one of them.
  Here that code is this file's own template, several hundred tokens of it,
  returned verbatim on every call. The agent has no use for it — it did not
  write it and cannot change it — so keep the sections that say what happened
  and drop the one that says how.
*/
const NOISE = new Set(["Ran Playwright code", "Ran Playwright code:"]);

function text(result: { content?: { text?: string }[] }): string {
  const whole = (result.content ?? []).map((block) => block.text ?? "").join("\n");

  const kept = whole
    .split(/^### /m)
    .filter(Boolean)
    .filter((section) => !NOISE.has((section.split("\n")[0] ?? "").trim()))
    .map((section) => section.trimEnd());

  return (kept.length > 0 ? kept.map((s) => `### ${s}`).join("\n") : whole).trim();
}

/**
 * Bring the app's own tab into view, because only it may ask.
 *
 * The extension answers pages on localhost and nobody else. Running a command
 * in whatever tab happened to be current meant asking from a job posting, or
 * from Playwright's own connect page after a reconnection — both of which
 * answer "receiving end does not exist", which reads like the extension is
 * missing when it is simply being asked by the wrong page.
 */
async function focusApp(): Promise<void> {
  const listing = text(await callBrowser("browser_tabs", { action: "list" }));

  // Lines look like: "- 3: (current) [title](http://localhost:5173/)"
  const LINE = /^-\s+(\d+):\s*(\(current\)\s*)?\[[^\]]*\]\((http:\/\/(?:localhost|127\.0\.0\.1):[^)]+)\)/;

  for (const raw of listing.split("\n")) {
    const match = LINE.exec(raw.trim());
    if (!match) continue;
    if (match[2]) return; // Already in view.
    await callBrowser("browser_tabs", { action: "select", index: Number(match[1]) });
    return;
  }
}

/** Run a Split Pilot command from the app's tab. */
async function command(message: Record<string, unknown>): Promise<string> {
  await focusApp();

  const call = `() => new Promise((done) => {
    if (typeof chrome === "undefined" || !chrome.runtime) {
      return done({ error: "This page cannot reach the extension. It answers only pages on localhost." });
    }
    chrome.runtime.sendMessage(${JSON.stringify(SPLIT_EXTENSION_ID)}, ${JSON.stringify(message)}, (reply) => {
      done(reply ?? { error: (chrome.runtime.lastError || {}).message || "Split Pilot did not answer. Is it installed and enabled?" });
    });
  })`;
  return text(await callBrowser("browser_evaluate", { function: call }));
}

/**
 * Open the split. `appUrl` is the tab that drives; it is brought into view
 * first, because the command has to run in its page.
 */
export async function openSplit(appUrl: string, stageUrl = "about:blank"): Promise<string> {
  await callBrowser("browser_navigate", { url: appUrl });

  // Playwright opens the stage, so the bridge knows it from the start.
  await callBrowser("browser_tabs", { action: "new", url: stageUrl });

  // command() brings the app back into view; it is the only page allowed to
  // ask, and after opening the stage the stage is what is in view.
  return command({ type: "split-pilot:adopt" });
}

/** Where the two tabs are, as the extension sees them. */
export async function splitState(): Promise<string> {
  return command({ type: "split-pilot:state" });
}

/** Send a URL to the stage without touching the tab in view. */
export async function openOnStage(url: string): Promise<string> {
  return command({ type: "split-pilot:open", url });
}

/** Take the arrangement apart. Both tabs stay open. */
export async function closeSplit(): Promise<string> {
  return command({ type: "split-pilot:unpair" });
}

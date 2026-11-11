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
async function focusApp(): Promise<boolean> {
  const listing = text(await callBrowser("browser_tabs", { action: "list" }));

  // Lines look like: "- 3: (current) [title](http://localhost:5173/)"
  const LINE = /^-\s+(\d+):\s*(\(current\)\s*)?\[[^\]]*\]\((http:\/\/(?:localhost|127\.0\.0\.1):[^)]+)\)/;

  for (const raw of listing.split("\n")) {
    const match = LINE.exec(raw.trim());
    if (!match) continue;
    if (match[2]) return true; // Already in view.
    await callBrowser("browser_tabs", { action: "select", index: Number(match[1]) });
    return true;
  }
  return false;
}

/** Whether Playwright can address two tabs: the app and a stage beside it. */
async function bridgeKnowsBothPanes(): Promise<boolean> {
  const listing = text(await callBrowser("browser_tabs", { action: "list" }));
  const tabs = listing.split("\n").filter((line) => /^-\s+\d+:/.test(line.trim()));
  return tabs.length >= 2;
}

/**
 * Close blank tabs left over from previous arrangements.
 *
 * Every setup opens a stage. Unsplitting leaves that tab behind as an
 * ordinary blank tab, so splitting again a few times buries the window in
 * them — three after two rounds, in the run that found this. Only blank tabs
 * Playwright itself opened are closed: a blank tab is by definition one
 * nobody has put anything in.
 */
async function closeOrphanedStages(): Promise<void> {
  const listing = text(await callBrowser("browser_tabs", { action: "list" }));
  const BLANK = /^-\s+(\d+):\s*(\(current\)\s*)?\[\s*\]\(about:blank\)/;

  const indices = listing
    .split("\n")
    .map((line) => BLANK.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));

  // Highest first: closing a tab renumbers everything after it.
  for (const index of indices.sort((a, b) => b - a)) {
    await callBrowser("browser_tabs", { action: "close", index });
  }
}

/** A call's output, and whether it actually worked. */
interface Outcome {
  ok: boolean;
  text: string;
}

/** Run a Split Pilot command from the app's tab. */
async function run(message: Record<string, unknown>, setUpFrom?: string): Promise<Outcome> {
  if (setUpFrom !== undefined) {
    if (!(await focusApp())) await callBrowser("browser_navigate", { url: setUpFrom });
    await closeOrphanedStages();
    const opened = await callBrowser("browser_tabs", { action: "new", url: "about:blank" });
    if (opened.isError === true) return { ok: false, text: text(opened) };
  }
  await focusApp();

  const call = `() => new Promise((done) => {
    if (typeof chrome === "undefined" || !chrome.runtime) {
      return done({ error: "This page cannot reach the extension. It answers only pages on localhost." });
    }
    chrome.runtime.sendMessage(${JSON.stringify(SPLIT_EXTENSION_ID)}, ${JSON.stringify(message)}, (reply) => {
      done(reply ?? { error: (chrome.runtime.lastError || {}).message || "Split Pilot did not answer. Is it installed and enabled?" });
    });
  })`;
  const result = await callBrowser("browser_evaluate", { function: call });
  return { ok: result.isError !== true, text: text(result) };
}

/** The same, for callers that only want something to show. */
async function command(message: Record<string, unknown>): Promise<string> {
  return (await run(message)).text;
}

/**
 * Open the split. `appUrl` is the tab that drives; it is brought into view
 * first, because the command has to run in its page.
 */
export async function openSplit(appUrl: string, stageUrl = "about:blank"): Promise<string> {
  /*
    Only navigate when there is no app tab to use.

    Navigating first was fine when a person pressed a button, having just
    decided they wanted this. Run automatically it is not: the tab the relay
    happens to hold could be anything the person was reading, and taking it
    over to show the app is the kind of help nobody asks for twice.
  */
  if (!(await focusApp())) await callBrowser("browser_navigate", { url: appUrl });

  // Playwright opens the stage, so the bridge knows it from the start.
  await callBrowser("browser_tabs", { action: "new", url: stageUrl });

  // command() brings the app back into view; it is the only page allowed to
  // ask, and after opening the stage the stage is what is in view.
  return command({ type: "split-pilot:adopt" });
}

/**
 * Open a stage tab for a page that is about to adopt it, if one is needed.
 *
 * The adopting is done by the page, not here, because only the extension can
 * tell which tab is asking — a page cannot know its own tab id, and two tabs
 * showing the app are indistinguishable from the outside. Picking "a tab
 * showing localhost" is what left a second app tab unsplit while the window
 * reported itself arranged.
 *
 * So this does the one part the page cannot: have Playwright open the tab, so
 * the stage is one the bridge knows and the assistant can address.
 */
export async function openStageFor(role: string | null): Promise<{ needed: boolean }> {
  // Already the left pane, and the bridge can still reach the other one.
  if (role === "left" && (await bridgeKnowsBothPanes())) return { needed: false };

  await closeOrphanedStages();
  const opened = await callBrowser("browser_tabs", { action: "new", url: "about:blank" });
  if (opened.isError === true) throw new Error(text(opened));
  return { needed: true };
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

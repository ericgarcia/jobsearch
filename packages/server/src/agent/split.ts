import { callBrowser } from "./browserClient.js";
import { APP_URL, SPLIT_EXTENSION_ID } from "../config.js";

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

  /*
    Playwright opens the stage, so the bridge knows it from the start — and
    opens it empty, so the split is there before the page is. Navigating
    afterwards goes through the extension, which does not wait for a load,
    and is the same path every later page takes.
  */
  await callBrowser("browser_tabs", { action: "new", url: "about:blank" });

  // command() brings the app back into view; it is the only page allowed to
  // ask, and after opening the stage the stage is what is in view.
  const arranged = await command({ type: "split-pilot:adopt" });
  if (stageUrl && stageUrl !== "about:blank") {
    return await command({ type: "split-pilot:open", url: stageUrl });
  }
  return arranged;
}

/**
 * Open an empty tab, for the app to adopt as its pane.
 *
 * Playwright opens it, not the extension and not the browser, and that is
 * the whole point of the round trip: a tab the bridge did not open is one
 * the assistant can watch and never touch, so "open this posting" would
 * give a pane it cannot read. The adopting is left to the page, because
 * only the extension can tell which tab is asking and a page cannot know
 * its own tab id.
 *
 * Empty, and the caller navigates it afterwards. Opening it at the real
 * URL meant this call did not return until that page had loaded — 5.6
 * seconds for one that takes five — and the split appeared only after
 * that. The person had clicked a link and watched nothing happen. A blank
 * tab opens at once, so the pane is there immediately and fills in at the
 * page's own pace, which is what every other browser does.
 */
let opening: Promise<{ opened: boolean }> | null = null;
let openedAt = 0;

/** A stage opened this recently is the one everybody should be adopting. */
const STAGE_IS_FRESH_MS = 5000;

export async function openStage(): Promise<{ opened: boolean }> {
  /*
    One stage at a time, however many tabs ask.

    Each app tab throttles only its own asking, because a page cannot see
    what another tab is doing. Four requests arrived in five seconds during
    testing and each opened a tab — which is where the stray about:blank
    tabs came from. The server is the only place that can see all of them.
  */
  if (opening) return opening;
  if (Date.now() - openedAt < STAGE_IS_FRESH_MS) return { opened: true };

  opening = (async () => {
    await closeOrphanedStages();
    const opened = await callBrowser("browser_tabs", { action: "new", url: "about:blank" });
    if (opened.isError === true) throw new Error(text(opened));
    return { opened: true };
  })();

  try {
    return await opening;
  } finally {
    opening = null;
    openedAt = Date.now();
  }
}

/** Where the two tabs are, as the extension sees them. */
export async function splitState(): Promise<string> {
  return command({ type: "split-pilot:state" });
}

/**
 * Read the page in the pane, without moving what the person is looking at.
 *
 * The browser tools act on the tab in view, and the tab in view is the app.
 * Selecting the pane, snapshotting, and selecting back is visible as the
 * window flickering through two tab changes for a read; doing it here keeps
 * it to one hop and puts the view back. "What is beside me" is the question
 * the pane exists to make answerable, so it should not cost the person
 * their place.
 */
export async function readPane(): Promise<string> {
  const state = parse<{ paired?: boolean; right?: { url?: string } }>(await splitState());
  if (state?.paired !== true || !state.right?.url) return "Nothing is open in the pane.";

  const wanted = state.right.url;
  const listing = text(await callBrowser("browser_tabs", { action: "list" }));

  /*
    Chrome's tab indices and the bridge's are different numberings, and the
    tools say so. The URL is the thing both agree on, so it is what the pane
    is found by here.
  */
  const LINE = /^-\s+(\d+):\s*(?:\(current\)\s*)?\[[^\]]*\]\(([^)]+)\)/;
  let index: number | null = null;
  let current: number | null = null;
  for (const raw of listing.split("\n")) {
    const found = LINE.exec(raw.trim());
    if (!found) continue;
    if (raw.includes("(current)")) current = Number(found[1]);
    if (found[2] === wanted) index = Number(found[1]);
  }

  if (index === null) {
    return `The pane is showing ${wanted}, but the bridge cannot address that tab — it was opened outside Playwright, so its contents cannot be read here. Ask the person what it says, or open the page again from the app.`;
  }

  await callBrowser("browser_tabs", { action: "select", index });
  const snapshot = text(await callBrowser("browser_snapshot", {}));
  if (current !== null && current !== index) {
    await callBrowser("browser_tabs", { action: "select", index: current });
  }
  return `The pane is showing ${wanted}\n\n${snapshot}`;
}

/**
 * What the extension answered, out of Playwright's report of the call.
 *
 * The reply is a JSON object inside a block of prose about running the code.
 * Reading it back is worth the awkwardness: the alternative is deciding
 * whether the panes are arranged by looking for a phrase in that prose,
 * which changes whenever the tool's output format does.
 */
function parse<T>(report: string): T | null {
  const start = report.indexOf("{");
  const end = report.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(report.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * Show a URL on the stage, making the arrangement if there is none.
 *
 * The app no longer opens a split as it loads, so most of the time there is
 * nothing to send to: the window is one tab with the app in it. Opening a
 * page is what makes the split, and this is the path that opens pages.
 */
export async function openOnStage(url: string): Promise<string> {
  const state = parse<{ paired?: boolean }>(await splitState());
  if (state?.paired !== true) return await openSplit(APP_URL, url);
  return command({ type: "split-pilot:open", url });
}

/** Take the arrangement apart. Both tabs stay open. */
export async function closeSplit(): Promise<string> {
  return command({ type: "split-pilot:unpair" });
}

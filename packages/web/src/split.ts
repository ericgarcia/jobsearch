/**
 * Talking to Split Pilot, the Chrome extension that holds the two panes.
 *
 * The extension answers pages on localhost, so the app can ask it directly:
 * no server round trip, and the tab that asks becomes the left pane, which is
 * exactly the tab this code runs in.
 *
 * Every call degrades to "not there". The extension is optional — without it
 * the app works as it always did, links open in new tabs, and nothing here
 * should make a fuss about its absence.
 */

export interface SplitState {
  paired: boolean;
  split?: boolean;
  left?: { id: number; index: number; url: string };
  right?: { id: number; index: number; url: string };
}

type Chrome = {
  runtime?: {
    sendMessage: (id: string, message: unknown, reply: (value: unknown) => void) => void;
    lastError?: { message?: string };
  };
};

function runtime(): Chrome["runtime"] | null {
  return (globalThis as { chrome?: Chrome }).chrome?.runtime ?? null;
}

async function ask<T>(id: string, message: Record<string, unknown>): Promise<T | null> {
  const api = runtime();
  if (!api) return null;
  return new Promise<T | null>((done) => {
    try {
      api.sendMessage(id, message, (reply) => {
        // lastError must be read, or Chrome logs it as unchecked.
        const failed = api.lastError;
        done(failed ? null : ((reply as T) ?? null));
      });
    } catch {
      done(null);
    }
  });
}

/** Is Split Pilot installed and answering? */
export async function splitInstalled(id: string): Promise<boolean> {
  return (await ask<SplitState>(id, { type: "split-pilot:state" })) != null;
}

/*
  There is deliberately no openSplit here, and no closeSplit either.

  The extension can make its own stage, and from this page that is the wrong
  thing to do: a tab this page creates is one Playwright never opened, so the
  assistant could watch that pane and never drive it. Arranging the panes goes
  through the server — POST /api/split/open — which has Playwright open the
  stage and the extension adopt it.

  Nothing takes the panes apart from the app. The two panes are how it is
  meant to be used, and the assistant needs both to do its job; a control
  whose only effect is to take half of that away is not a control worth
  having. The extension's own popup can still unpair, because the extension
  is not this app's.
*/

/**
 * Tell the extension which token Playwright will present.
 *
 * Without this the person copies a string from the extension's popup into
 * .env and keeps the two in step by hand. The app already knows the token, so
 * it says so.
 */
export async function syncToken(id: string, token: string): Promise<void> {
  await ask(id, { type: "split-pilot:set-token", token });
}

/**
 * Which pane this tab is, if any.
 *
 * Asked of the extension rather than worked out here, because a page cannot
 * know its own tab id and two tabs showing the app look identical from the
 * outside. The extension is told who is asking by Chrome itself.
 */
export async function myRole(id: string): Promise<"left" | "right" | null> {
  const reply = await ask<{ role: "left" | "right" | null }>(id, { type: "split-pilot:my-role" });
  return reply?.role ?? null;
}

/**
 * Take the tab the server just opened as this tab's stage.
 *
 * This has to be asked by the page that wants to be the left pane: the
 * extension makes the asking tab the driver, which is the only way to be sure
 * the right tab is paired.
 */
export async function adoptStage(id: string): Promise<void> {
  await ask(id, { type: "split-pilot:adopt" });
}

/**
 * Show a URL in the pane beside the app.
 *
 * Answers false when there is no pane yet, which is the app's cue to have
 * one opened and adopt it.
 */
export async function routeToPane(id: string | null, url: string): Promise<boolean> {
  if (!id) return false;
  const reply = await ask<{ routed: boolean }>(id, { type: "split-pilot:open", url });
  return reply?.routed === true;
}

/* -------------------------------------------------------------- threads */

/**
 * Say which thread this tab is showing.
 *
 * Everything opened from this tab afterwards belongs to that thread. The
 * alternative was carrying a thread id through every path that can open a
 * page — a click caught in the content script, a URL routed by the agent, an
 * adopted stage — and a path that forgot would quietly leak tabs.
 */
export async function tellThread(id: string | null, thread: number | null): Promise<void> {
  if (!id) return;
  await ask(id, { type: "split-pilot:thread", thread });
}

export interface ThreadTab {
  id: number;
  title: string;
  url: string;
  /** On screen now, so closing it would take a page away as it is read. */
  active: boolean;
}

/** What closing this thread would close. Asked before it is done. */
export async function threadTabs(id: string | null, thread: number): Promise<ThreadTab[]> {
  if (!id) return [];
  const reply = await ask<{ tabs: ThreadTab[] }>(id, { type: "split-pilot:thread-tabs", thread });
  return reply?.tabs ?? [];
}

/** Show one of them in the pane, making the split again if it is gone. */
export async function showInPane(id: string | null, tabId: number): Promise<boolean> {
  if (!id) return false;
  const reply = await ask<{ error?: string }>(id, { type: "split-pilot:show", tabId });
  return reply != null && reply.error === undefined;
}

/** Close one page, leaving the thread and its other pages alone. */
export async function closeTab(id: string | null, tabId: number): Promise<void> {
  if (!id) return;
  await ask(id, { type: "split-pilot:close-tab", tabId });
}

/**
 * Step out of the split without closing anything.
 *
 * The pane's page stays open as an ordinary tab, so the app can give it the
 * window back and then take it again. Closing it instead would mean the
 * only way to read the app in full was to throw away what you were reading.
 */
export async function leaveSplit(id: string | null): Promise<void> {
  if (!id) return;
  await ask(id, { type: "split-pilot:unpair" });
}

/** Close them. The app asks only once the person has agreed. */
export async function closeThreadTabs(id: string | null, thread: number): Promise<number> {
  if (!id) return 0;
  const reply = await ask<{ closed: number }>(id, { type: "split-pilot:close-thread", thread });
  return reply?.closed ?? 0;
}

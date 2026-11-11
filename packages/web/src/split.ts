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

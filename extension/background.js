/*
  Split Pilot — keep two tabs side by side, and keep the right one still.

  An agent driving a browser has one recurring problem: the page it is working
  on will not hold still. A link opens a tab, the new tab takes focus, the next
  instruction lands somewhere unexpected, and the window the person arranged is
  gone. The usual answer is to tell the agent to be careful, which is not an
  answer.

  This takes the other route. Two tabs are paired in a native split view. The
  left one is yours — an app, a list, a document. Every link in it is caught
  before the browser can act on it and sent to the right tab instead, which
  navigates in place. The right tab is therefore always the same tab, at a
  known position next to the left one, so an agent addressing tabs by index
  finds the same stage every time.

  There is nothing here about any particular app. A pair is two tab ids.
*/

/** One pair per window: the window is what the person sees. */
const KEY = "pairs";

async function pairs() {
  const stored = await chrome.storage.session.get(KEY);
  return stored[KEY] ?? {};
}

async function putPair(windowId, pair) {
  const all = await pairs();
  const previous = all[windowId];
  if (pair) all[windowId] = pair;
  else delete all[windowId];
  await chrome.storage.session.set({ [KEY]: all });

  // The content scripts decide synchronously whether to catch a click, so they
  // are told their role rather than asked for it at the moment of the click.
  if (previous) {
    tell(previous.left, null);
    tell(previous.right, null);
  }
  if (pair) {
    tell(pair.left, "left");
    tell(pair.right, "right");
  }
}

function tell(tabId, role) {
  chrome.tabs.sendMessage(tabId, { type: "split-pilot:you-are", role }).catch(() => {
    // No content script in that tab — a chrome:// page, or one loaded before
    // the extension. It will ask for itself when it next loads.
  });
}

async function pairForWindow(windowId) {
  return (await pairs())[windowId] ?? null;
}

/** The pair a given tab belongs to, and which side it is. */
async function sideOf(tabId) {
  for (const [windowId, pair] of Object.entries(await pairs())) {
    if (pair.left === tabId) return { windowId: Number(windowId), pair, side: "left" };
    if (pair.right === tabId) return { windowId: Number(windowId), pair, side: "right" };
  }
  return null;
}

/*
  Chrome grew tabs.createSplit in 155. Without it the pairing still works —
  links still land in the right tab — but the two tabs are ordinary neighbours
  rather than a visible split, so say so rather than failing.
*/
const canSplit = () => typeof chrome.tabs.createSplit === "function";

/**
 * Make the given tab the left of a new pair, and open a right tab beside it.
 *
 * splitWithTabId puts the new tab to the right, which is the arrangement the
 * rest of this file assumes: left drives, right is driven.
 */
async function startPair(leftTab, url = "about:blank") {
  await dissolve(leftTab.windowId);

  let right;
  if (canSplit()) {
    right = await chrome.tabs.create({ splitWithTabId: leftTab.id, url, active: false });
  } else {
    right = await chrome.tabs.create({
      windowId: leftTab.windowId,
      index: leftTab.index + 1,
      url,
      active: false,
    });
  }

  const pair = {
    left: leftTab.id,
    right: right.id,
    splitViewId: right.splitViewId ?? -1,
    split: canSplit(),
  };
  await putPair(leftTab.windowId, pair);
  return pair;
}

/** Take the pair apart, leaving both tabs open. */
async function dissolve(windowId) {
  const pair = await pairForWindow(windowId);
  if (!pair) return;
  if (pair.split && pair.splitViewId >= 0 && typeof chrome.tabs.unsplit === "function") {
    try {
      await chrome.tabs.unsplit(pair.splitViewId);
    } catch {
      // The split may already be gone, which is the state we wanted anyway.
    }
  }
  await putPair(windowId, null);
}

/**
 * Send a URL to the right tab of the pair the given tab belongs to.
 *
 * The right tab is never replaced, only navigated, so its index stays put and
 * an agent holding on to that index keeps working.
 */
async function sendToRight(fromTabId, url) {
  const found = await sideOf(fromTabId);
  if (!found || found.side !== "left") return false;

  try {
    await chrome.tabs.update(found.pair.right, { url });
    return true;
  } catch {
    // The right tab is gone. Drop the pair rather than silently swallowing
    // every link from here on.
    await putPair(found.windowId, null);
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "split-pilot:open") {
    void sendToRight(sender.tab?.id, message.url).then((routed) => respond({ routed }));
    return true;
  }
  if (message?.type === "split-pilot:role") {
    void sideOf(sender.tab?.id).then((found) => respond({ role: found?.side ?? null }));
    return true;
  }

  // From the popup. It cannot import this worker, so it asks.
  if (message?.type === "split-pilot:state") {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const pair = tab ? await pairForWindow(tab.windowId) : null;
      respond({ tabId: tab?.id ?? null, pair, canSplit: canSplit() });
    })();
    return true;
  }
  if (message?.type === "split-pilot:pair") {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      respond(tab ? await startPair(tab, message.url) : null);
    })();
    return true;
  }
  if (message?.type === "split-pilot:unpair") {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await dissolve(tab.windowId);
      respond({ ok: true });
    })();
    return true;
  }
  return false;
});

/*
  Some links cannot be caught in the page: a target="_blank" form, a download
  that turns into a navigation, anything opened by the browser itself. Those
  still arrive as a new tab. If one was opened by the left tab, move its URL
  into the right tab and close it, so the arrangement survives.
*/
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId === undefined) return;
  const found = await sideOf(tab.openerTabId);
  if (!found || found.side !== "left") return;
  if (tab.id === found.pair.right) return;

  const url = tab.pendingUrl ?? tab.url;
  if (!url || url === "about:blank" || url === "chrome://newtab/") return;

  await chrome.tabs.update(found.pair.right, { url });
  try {
    await chrome.tabs.remove(tab.id);
  } catch {
    // Already gone.
  }
});

/** A pair with a missing half is not a pair. */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const found = await sideOf(tabId);
  if (found) await putPair(found.windowId, null);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await putPair(windowId, null);
});

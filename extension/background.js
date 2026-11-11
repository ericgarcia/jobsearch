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

import { RelayConnection } from "./relay.js";

/* ------------------------------------------------------------------- relay */

/**
 * The token that gates a Playwright connection, or null before there is one.
 *
 * It used to be generated here, on install. That guaranteed a token nobody
 * else knew, so every real connection was refused as a mismatch — and because
 * a token existed, the connect page never offered to approve one either. The
 * gate was shut with no handle on it.
 *
 * A token is not something this extension invents. It is something it is
 * told: by the app, which reads it from the same .env the server does, or by
 * the person approving a connection once.
 */
async function token() {
  return (await chrome.storage.local.get("token")).token ?? null;
}

let relay = null;

/**
 * Open the relay and give Playwright a tab to work with.
 *
 * Playwright attaches to tabs it is offered, and offers nothing itself, so a
 * session that begins with no tab can do nothing at all. The tab in view is
 * the right first offer: it is what the person is looking at, and in a pair
 * it is the driver, from which the stage is one command away.
 */
async function connectRelay(relayUrl) {
  relay?.close("Replaced by a new connection");

  const socket = new WebSocket(relayUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("The relay refused the connection."));
    setTimeout(() => reject(new Error("The relay did not answer within 5s.")), 5000);
  });

  const connection = new RelayConnection(socket);
  connection.onclose = () => {
    if (relay === connection) relay = null;
  };
  relay = connection;
  connection.announce();

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && !/^(chrome|edge|devtools):/.test(active.url ?? "")) connection.offer(active);
  return connection;
}

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

/** A URL the stage can show. Everything else is the browser's business. */
function routable(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
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

/**
 * Which tab to adopt: one named outright, else the last one opened in this
 * window that is not the caller. A tool that has just opened a tab wants that
 * tab, and it rarely knows its id.
 */
async function findCandidate(leftTab, message) {
  const tabs = (await chrome.tabs.query({ windowId: leftTab.windowId })).filter(
    (t) => t.id !== leftTab.id,
  );
  if (message.tabId) return tabs.find((t) => t.id === message.tabId) ?? null;
  if (message.url) return tabs.filter((t) => t.url === message.url).pop() ?? null;
  // Highest id is the most recently created, which is what "the tab I just
  // opened" means. Index would give whichever sits rightmost, a different tab.
  return tabs.sort((a, b) => a.id - b.id).pop() ?? null;
}

/** Move a tab next to the driver and split with it. */
async function adopt(leftTab, stage) {
  await dissolve(leftTab.windowId);

  // createSplit refuses tabs that are already split, or not neighbours.
  if (stage.splitViewId !== undefined && stage.splitViewId >= 0 && chrome.tabs.unsplit) {
    try {
      await chrome.tabs.unsplit(stage.splitViewId);
    } catch {
      // Already apart.
    }
  }

  const me = await chrome.tabs.get(leftTab.id);
  if (stage.index !== me.index + 1) {
    await chrome.tabs.move(stage.id, { index: me.index + 1 });
  }

  let split = false;
  if (canSplit()) {
    try {
      await chrome.tabs.createSplit([leftTab.id, stage.id]);
      split = true;
    } catch {
      // No split view; the pair is two neighbours, and routing still works.
    }
  }

  const after = await chrome.tabs.get(stage.id);
  const pair = {
    left: leftTab.id,
    right: stage.id,
    splitViewId: after.splitViewId ?? -1,
    split,
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

  /* From connect.html, which Playwright opened with the relay address. */
  if (message?.type === "split-pilot:connect") {
    void connectRelay(message.relayUrl).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: error.message }),
    );
    return true;
  }

  if (message?.type === "split-pilot:token") {
    void token().then((value) => respond({ token: value, connected: relay != null }));
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
  The control surface, for a page served from an origin in the manifest's
  externally_connectable list.

  Neither the popup nor any chrome-extension:// page can be automated — Chrome
  refuses to let the debugger attach to them — so without this there is no way
  for anything but a human hand to pair two tabs. That makes the arrangement
  unusable by the agent it exists to serve.

  The tab that sends the message becomes the left tab. A page can only ever
  make itself the driver, never some other tab it has no business touching.
*/
chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  const tab = sender.tab;
  if (!tab) return false;

  switch (message?.type) {
    case "split-pilot:pair":
      void startPair(tab, message.url ?? "about:blank").then(respond);
      return true;

    /*
      Take an existing tab as the stage, instead of making one.

      A driving tool only knows the tabs it opened itself. A stage this
      extension creates is invisible to it, so it can watch the stage navigate
      and never address it — which is half a tool. The way round is for the
      tool to open the tab, and for us to adopt it: move it alongside and
      split with it. It stays a tab the tool knows.
    */
    case "split-pilot:adopt":
      void (async () => {
        const candidate = await findCandidate(tab, message);
        if (!candidate) return respond({ error: "no tab to adopt" });
        respond(await adopt(tab, candidate));
      })();
      return true;

    case "split-pilot:set-token": {
      /*
        Let the app set the token, rather than making the person copy one. The
        app and the server read the same .env, so the token the server hands
        Playwright is already known on the app's side; copying it by hand only
        creates a step to get wrong. This is no weaker than the rest of this
        surface: a page that can set the token can already pair and unpair.
      */
      const value = String(message.token ?? "");
      if (!value) {
        respond({ ok: false, error: "empty token" });
        return true;
      }
      void chrome.storage.local.set({ token: value }).then(() => respond({ ok: true }));
      return true;
    }

    case "split-pilot:unpair":
      void dissolve(tab.windowId).then(() => respond({ ok: true }));
      return true;

    case "split-pilot:open":
      void sendToRight(tab.id, message.url).then((routed) => respond({ routed }));
      return true;

    /*
      Where the stage is. An agent addresses tabs by index, and an index moves
      whenever another tab opens or closes, so it has to be able to ask rather
      than remember.
    */
    case "split-pilot:state":
      void (async () => {
        const pair = await pairForWindow(tab.windowId);
        if (!pair) return respond({ paired: false });
        const [left, right] = await Promise.all([
          chrome.tabs.get(pair.left).catch(() => null),
          chrome.tabs.get(pair.right).catch(() => null),
        ]);
        respond({
          paired: true,
          split: pair.split,
          left: left && { id: left.id, index: left.index, url: left.url },
          right: right && { id: right.id, index: right.index, url: right.url },
        });
      })();
      return true;

    default:
      return false;
  }
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

  /*
    Only a page the stage could actually show. The net used to check for
    about:blank and nothing else, which swept up chrome-extension:// tabs —
    including the connect page Playwright's own extension opens to establish
    its session. Hijacking that killed the connection it was trying to make.
  */
  const url = tab.pendingUrl ?? tab.url;
  if (!routable(url)) return;

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

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
 * The first tab to hand Playwright.
 *
 * It must be a real page. The obvious choice — whatever is active — is wrong
 * at exactly this moment, because what is active is the connect page that
 * just ran, and attaching to that leaves Playwright holding a tab which is
 * about to close itself. Debugger cannot attach to chrome:// or devtools://
 * at all, and an extension page is no use even where it can.
 */
async function firstOffer() {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const usable = tabs.filter((tab) => /^https?:/.test(tab.url ?? ""));
  return usable.find((tab) => tab.active) ?? usable[usable.length - 1] ?? null;
}

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

  const first = await firstOffer();
  if (first) connection.offer(first);
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
    tell(previous.left, null, false);
    tell(previous.right, null, false);
  }
  if (pair) {
    tell(pair.left, "left", pair.split === true);
    tell(pair.right, "right", pair.split === true);
  }
}

/**
 * Answer a message, whether the work behind it succeeded or not.
 *
 * Chrome holds the port open until respond() is called. A handler that throws
 * instead never calls it, so the page that asked waits for an answer that is
 * not coming, and the failure surfaces only as an uncaught rejection in the
 * worker's console with nothing to say which message caused it. That is how
 * "No tab with id" was reaching the error page.
 *
 * Anything that touches a tab can fail — a tab stops existing the moment the
 * person closes it — so answering is the handler's business rather than
 * something each happy path remembers. Returns true, which is Chrome's signal
 * that the answer is coming later.
 */
function answer(respond, work) {
  Promise.resolve().then(work).then(respond, (error) => {
    respond({ error: String(error?.message ?? error) });
  });
  return true;
}

/** The tab a popup's command is about. */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/*
  Tell a tab what it is.

  The split flag travels with the role because the app wants it: the left
  pane shows only the assistant while the window is split, and the whole
  column has to come back the moment it is not. A page can ask for the state,
  but it would have to keep asking — nothing else tells it the arrangement
  changed — and a poll for an answer that changes twice an hour is the thing
  this file already refuses to do for the role.
*/
function tell(tabId, role, split) {
  chrome.tabs.sendMessage(tabId, { type: "split-pilot:you-are", role, split }).catch(() => {
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

/* ------------------------------------------------- tabs, and whose they are

  A thread owns the tabs it opened.

  The app is several conversations, and each one sends the person somewhere:
  a posting, a company page, a form. Closing the conversation should take
  those pages with it, or a day's work leaves a window nobody can read. The
  app cannot do this itself — a page may not close a tab it did not open, and
  it cannot see them at all — so the register lives here, where the tab ids
  are.

  Two maps, both in session storage, both thrown away with the browser:

    threads  thread id  -> the tab ids it opened
    current  left tab   -> the thread that tab is showing now

  The second is what makes the first cheap. Rather than carrying a thread id
  through every path that can open a page — a link click caught in the
  content script, a routed URL, an adopted stage — the app says which thread
  it is on when that changes, and everything opened from that tab afterwards
  belongs to it.
*/

const THREADS = "threads";
const CURRENT = "current";

async function stored(key) {
  return (await chrome.storage.session.get(key))[key] ?? {};
}

/** The thread the given tab is showing, if it has said. */
async function threadOf(tabId) {
  const current = await stored(CURRENT);
  return current[tabId] ?? null;
}

/** Say which thread a tab is showing. null when it is on none. */
async function setThread(tabId, thread) {
  const current = await stored(CURRENT);
  if (thread === null || thread === undefined) delete current[tabId];
  else current[tabId] = thread;
  await chrome.storage.session.set({ [CURRENT]: current });
}

/** Record that `tabId` was opened for whatever thread `leftTabId` is showing. */
async function remember(leftTabId, tabId) {
  const thread = await threadOf(leftTabId);
  if (thread === null || tabId === undefined) return;
  const threads = await stored(THREADS);
  const had = threads[thread] ?? [];
  if (!had.includes(tabId)) threads[thread] = [...had, tabId];
  await chrome.storage.session.set({ [THREADS]: threads });
}

/**
 * The tabs a thread still has open.
 *
 * A tab that has been navigated somewhere else is still the thread's tab.
 * It was opened for this conversation, the person followed it onward, and
 * the conversation is still what it belongs to — tracking the URL instead
 * would mean a tab stops being anybody's the moment it is used.
 */
async function tabsOfThread(thread) {
  const ids = (await stored(THREADS))[thread] ?? [];
  const found = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)));
  return found.filter((tab) => tab !== null);
}

/** Whether any thread claims this tab. */
async function ownedByThread(tabId) {
  return Object.values(await stored(THREADS)).some((ids) => ids.includes(tabId));
}

/** Forget a thread's tabs, whether or not they were closed from here. */
async function forgetThread(thread) {
  const threads = await stored(THREADS);
  delete threads[thread];
  await chrome.storage.session.set({ [THREADS]: threads });
}

/*
  Chrome grew tabs.createSplit in 155. Without it the pairing still works —
  links still land in the right tab — but the two tabs are ordinary neighbours
  rather than a visible split, so say so rather than failing.
*/
const canSplit = () => typeof chrome.tabs.createSplit === "function";

/**
 * Take apart whatever pair a window has, and name the stage it had.
 *
 * dissolve() leaves both tabs open, which is right when a person unpairs —
 * they still want what they were reading. It is wrong when a new stage is
 * arriving: the old one is then a tab nothing will ever navigate again, and
 * left open it collects. So the two cases are separated here, and a caller
 * that is replacing a pair passes what this returns to retire().
 */
async function supersede(windowId) {
  const previous = await pairForWindow(windowId);
  await dissolve(windowId);
  return previous?.right;
}

/**
 * Close a stage that a new arrangement has replaced.
 *
 * Only the extension can do this. The server sees "a tab with a page in it"
 * and cannot tell the stage it just replaced from something the person opened
 * themselves, which is why its own sweep is limited to blank tabs.
 *
 * `keep` is the tabs now in use as panes, never closed however the ids line up.
 */
async function retire(superseded, ...keep) {
  if (superseded === undefined || keep.includes(superseded)) return;

  /*
    A page a conversation opened is not litter.

    This used to close whatever stage the last arrangement had, which was
    right when there was one permanent stage per window: the old one was a
    tab nothing would navigate again. Now a stage is a page somebody asked
    for, belonging to the thread that asked, and it closes with that thread
    rather than with the next arrangement. An empty stage is still litter,
    and still goes.
  */
  const tab = await chrome.tabs.get(superseded).catch(() => null);
  if (!tab) return;
  if (routable(tab.url ?? tab.pendingUrl) && (await ownedByThread(superseded))) return;

  await chrome.tabs.remove(superseded).catch(() => {
    // Already gone. That is the outcome we wanted.
  });
}

/**
 * Make the given tab the left of a new pair, and open a right tab beside it.
 *
 * splitWithTabId puts the new tab to the right, which is the arrangement the
 * rest of this file assumes: left drives, right is driven.
 */
async function startPair(leftTab, url = "about:blank") {
  const superseded = await supersede(leftTab.windowId);

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

  // After the new pair is stored, so a failure here cannot lose the pairing.
  await retire(superseded, leftTab.id, right.id);
  await remember(leftTab.id, right.id);
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
  const superseded = await supersede(leftTab.windowId);

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

  // After the new pair is stored, so a failure here cannot lose the pairing.
  await retire(superseded, leftTab.id, stage.id);
  await remember(leftTab.id, stage.id);
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
    await remember(found.pair.left, found.pair.right);
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
    return answer(respond, async () => ({ routed: await sendToRight(sender.tab?.id, message.url) }));
  }
  if (message?.type === "split-pilot:role") {
    return answer(respond, async () => {
      const found = await sideOf(sender.tab?.id);
      return { role: found?.side ?? null, split: found?.pair.split === true };
    });
  }

  /* From connect.html, which Playwright opened with the relay address. */
  if (message?.type === "split-pilot:connect") {
    const page = sender.tab?.id;
    void connectRelay(message.relayUrl).then(
      () => {
        respond({ ok: true });
        /*
          Close the connect tab from here. A page cannot close a tab it did
          not open, so its own window.close() is refused and the tab lingers
          in every listing Playwright makes.
        */
        if (page !== undefined) setTimeout(() => void chrome.tabs.remove(page).catch(() => {}), 500);
      },
      (error) => respond({ ok: false, error: error.message }),
    );
    return true;
  }

  if (message?.type === "split-pilot:token") {
    return answer(respond, async () => ({ token: await token(), connected: relay != null }));
  }

  // From the popup. It cannot import this worker, so it asks.
  if (message?.type === "split-pilot:state") {
    return answer(respond, async () => {
      const tab = await activeTab();
      const pair = tab ? await pairForWindow(tab.windowId) : null;
      return { tabId: tab?.id ?? null, pair, canSplit: canSplit() };
    });
  }
  if (message?.type === "split-pilot:pair") {
    return answer(respond, async () => {
      const tab = await activeTab();
      return tab ? await startPair(tab, message.url) : null;
    });
  }
  if (message?.type === "split-pilot:unpair") {
    return answer(respond, async () => {
      const tab = await activeTab();
      if (tab) await dissolve(tab.windowId);
      return { ok: true };
    });
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
      return answer(respond, () => startPair(tab, message.url ?? "about:blank"));

    /*
      Take an existing tab as the stage, instead of making one.

      A driving tool only knows the tabs it opened itself. A stage this
      extension creates is invisible to it, so it can watch the stage navigate
      and never address it — which is half a tool. The way round is for the
      tool to open the tab, and for us to adopt it: move it alongside and
      split with it. It stays a tab the tool knows.
    */
    case "split-pilot:adopt":
      return answer(respond, async () => {
        const candidate = await findCandidate(tab, message);
        if (!candidate) return { error: "no tab to adopt" };
        return await adopt(tab, candidate);
      });

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
      return answer(respond, async () => {
        await chrome.storage.local.set({ token: value });
        return { ok: true };
      });
    }

    /*
      Which pane the asking tab is, if any.

      A page cannot know its own tab id, and nothing else can tell it apart
      from another tab showing the same URL. Only this listener knows, because
      Chrome supplies the sender. Without it, "is the app already the left
      pane?" gets answered for whichever tab happened to be found first, which
      is how opening the app in a second tab left that tab unsplit while
      everything reported itself arranged.
    */
    case "split-pilot:my-role":
      return answer(respond, async () => ({ role: (await sideOf(tab.id))?.side ?? null }));

    case "split-pilot:unpair":
      return answer(respond, async () => {
        await dissolve(tab.windowId);
        return { ok: true };
      });

    /* The app saying which thread it is showing. See the register above. */
    case "split-pilot:thread":
      return answer(respond, async () => {
        await setThread(tab.id, message.thread ?? null);
        return { ok: true };
      });

    /*
      What closing a thread would close.

      Asked before doing it, so the app can warn about a tab the person is
      looking at. Closing the page someone is reading, with no word, is the
      kind of help that makes people stop trusting a feature — and the app
      cannot see the tabs to warn by itself.
    */
    case "split-pilot:thread-tabs":
      return answer(respond, async () => ({
        tabs: (await tabsOfThread(message.thread)).map((other) => ({
          id: other.id,
          title: other.title ?? "",
          url: other.url ?? "",
          /*
            In view means on screen now.

            The active tab of its window is the obvious half. The other half
            is a tab in a split: both panes are displayed, and only one of
            them is Chrome's active tab — so the page beside the app, the
            very page this feature puts there, would have been closed with
            no warning at all. A tab carries a splitViewId while it is in
            one.
          */
          active: other.active === true || (other.splitViewId ?? -1) >= 0,
        })),
      }));

    /* And doing it. The app asks only after the person has agreed. */
    case "split-pilot:close-thread":
      return answer(respond, async () => {
        const open = await tabsOfThread(message.thread);
        await forgetThread(message.thread);
        for (const other of open) {
          await chrome.tabs.remove(other.id).catch(() => {
            // Gone already, which is where we were heading.
          });
        }
        return { closed: open.length };
      });

    case "split-pilot:open":
      return answer(respond, async () => ({ routed: await sendToRight(tab.id, message.url) }));

    /*
      Where the stage is. An agent addresses tabs by index, and an index moves
      whenever another tab opens or closes, so it has to be able to ask rather
      than remember.
    */
    case "split-pilot:state":
      return answer(respond, async () => {
        const pair = await pairForWindow(tab.windowId);
        if (!pair) return { paired: false };
        const [left, right] = await Promise.all([
          chrome.tabs.get(pair.left).catch(() => null),
          chrome.tabs.get(pair.right).catch(() => null),
        ]);
        return {
          paired: true,
          split: pair.split,
          left: left && { id: left.id, index: left.index, url: left.url },
          right: right && { id: right.id, index: right.index, url: right.url },
        };
      });

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

  /*
    No pair yet, and the app opened this: make it the split.

    This is the other half of "a split only while a site is open". The app
    sits in one tab with its own two columns until something is opened from
    it; then that page becomes the pane beside it, and the app's canvas
    steps aside. An app tab is one that has told us which thread it is
    showing — nothing else in the browser does that.
  */
  if (!found) {
    if ((await threadOf(tab.openerTabId)) === null) return;
    if (!routable(tab.pendingUrl ?? tab.url)) return;
    const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
    if (opener) await adopt(opener, tab);
    return;
  }

  if (found.side !== "left") return;
  if (tab.id === found.pair.right) return;

  /*
    Only a page the stage could actually show. The net used to check for
    about:blank and nothing else, which swept up chrome-extension:// tabs —
    including the connect page Playwright's own extension opens to establish
    its session. Hijacking that killed the connection it was trying to make.
  */
  const url = tab.pendingUrl ?? tab.url;
  if (!routable(url)) return;

  /*
    Through sendToRight, which survives a stage that is no longer there.

    Calling tabs.update directly threw "No tab with id" into an async listener,
    where nothing catches it — it reached the console as an uncaught rejection
    and the handler stopped, leaving the link in a tab this was meant to
    absorb. The stage can be gone for ordinary reasons: the person closed it,
    or an arrangement replaced it a moment ago.

    And close the intercepted tab only if the URL actually landed. Closing it
    after a failed route would throw the link away.
  */
  if (await sendToRight(tab.openerTabId, url)) {
    await chrome.tabs.remove(tab.id).catch(() => {
      // Already gone.
    });
  }
});

/*
  A pair with a missing half is not a pair.

  This is also how the split comes apart when the person closes the page
  themselves: the pair goes, every tab is told its role again, and the app
  gets its canvas back without anyone asking it to.
*/
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const found = await sideOf(tabId);
  if (found) await putPair(found.windowId, null);
  await forget(tabId);
});

/** Drop a closed tab from the register, and from any thread that owned it. */
async function forget(tabId) {
  const current = await stored(CURRENT);
  if (current[tabId] !== undefined) {
    delete current[tabId];
    await chrome.storage.session.set({ [CURRENT]: current });
  }

  const threads = await stored(THREADS);
  let changed = false;
  for (const [thread, ids] of Object.entries(threads)) {
    if (!ids.includes(tabId)) continue;
    const left = ids.filter((id) => id !== tabId);
    if (left.length > 0) threads[thread] = left;
    else delete threads[thread];
    changed = true;
  }
  if (changed) await chrome.storage.session.set({ [THREADS]: threads });
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  await putPair(windowId, null);
});

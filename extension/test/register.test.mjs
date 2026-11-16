/*
  The thread register, driven through the worker's own message handlers.

  The register decides which tabs close with a conversation, and getting it
  wrong is expensive in both directions: a tab that outlives its thread is
  litter, and a tab closed by mistake is a page somebody was reading. None of
  that is visible from the app, which cannot see tabs at all, so it is
  checked here against a stubbed Chrome rather than by opening windows and
  looking.

  This loads the real background.js. Nothing is reimplemented: the stub
  provides the Chrome APIs it calls, and the test talks to it the way the app
  does, through onMessageExternal.

  Run: node extension/test/register.test.mjs
*/

import assert from "node:assert/strict";

let passed = 0;
function ok(what) {
  passed += 1;
  console.log(`  ok   ${what}`);
}

/* ------------------------------------------------------------------ stub */

const session = new Map();
const tabs = new Map();
const external = [];
const internal = [];
let nextTabId = 100;

function tabStub(props) {
  const tab = { id: nextTabId++, windowId: 1, index: tabs.size, active: false, url: "", title: "", ...props };
  tabs.set(tab.id, tab);
  return tab;
}

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => internal.push(fn) },
    onMessageExternal: { addListener: (fn) => external.push(fn) },
    lastError: undefined,
  },
  storage: {
    session: {
      get: async (key) => (session.has(key) ? { [key]: session.get(key) } : {}),
      set: async (patch) => {
        for (const [key, value] of Object.entries(patch)) session.set(key, value);
      },
    },
    local: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: () => {} },
  },
  tabs: {
    onCreated: { addListener: (fn) => (onCreated = fn) },
    onRemoved: { addListener: (fn) => (onRemoved = fn) },
    onUpdated: { addListener: () => {} },
    get: async (id) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error(`No tab with id ${id}`);
      return tab;
    },
    query: async () => [...tabs.values()],
    create: async (props) => tabStub(props),
    update: async (id, props) => Object.assign(await chrome.tabs.get(id), props),
    move: async () => {},
    remove: async (id) => {
      if (!tabs.has(id)) throw new Error(`No tab with id ${id}`);
      tabs.delete(id);
      await onRemoved(id);
    },
    sendMessage: async () => {},
  },
  windows: { onRemoved: { addListener: () => {} } },
  debugger: { onEvent: { addListener: () => {} }, onDetach: { addListener: () => {} } },
  action: { onClicked: { addListener: () => {} } },
};

let onRemoved = async () => {};
let onCreated = async () => {};

await import("../background.js");

/** Send a message as a page would, and wait for the worker's reply. */
function say(message, senderTab) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`no reply to ${message.type}`)), 2000);
    for (const listener of external) {
      const handled = listener(message, { tab: senderTab }, (reply) => {
        clearTimeout(timer);
        done(reply);
      });
      if (handled) return;
    }
    clearTimeout(timer);
    fail(new Error(`nobody handled ${message.type}`));
  });
}

/* ------------------------------------------------------------------ tests */

const app = tabStub({ url: "http://localhost:5173/", title: "jobsearch" });

console.log("\n1. A thread owns what it opens");

await say({ type: "split-pilot:thread", thread: 7 }, app);
const posting = tabStub({ url: "https://example.com/job/1", title: "A job" });
await say({ type: "split-pilot:adopt", tabId: posting.id }, app);

let mine = (await say({ type: "split-pilot:thread-tabs", thread: 7 }, app)).tabs;
assert.deepEqual(mine.map((t) => t.id), [posting.id]);
ok("the adopted page is recorded against the open thread");

console.log("\n2. Following a link onward does not change whose it is");

// The person reads on. The tab is the same tab; its URL is not.
tabs.get(posting.id).url = "https://elsewhere.example/about";
tabs.get(posting.id).title = "Somewhere else";
mine = (await say({ type: "split-pilot:thread-tabs", thread: 7 }, app)).tabs;
assert.equal(mine.length, 1);
assert.equal(mine[0].url, "https://elsewhere.example/about");
ok("still the thread's tab after it is navigated away");

console.log("\n3. A tab in view is reported as such");

tabs.get(posting.id).active = true;
mine = (await say({ type: "split-pilot:thread-tabs", thread: 7 }, app)).tabs;
assert.equal(mine[0].active, true, "the app needs this to warn before closing");
ok("in view is reported, so the app can ask first");

console.log("\n3b. So is a pane of a split, which is never the active tab");

tabs.get(posting.id).active = false;
tabs.get(posting.id).splitViewId = 42;
mine = (await say({ type: "split-pilot:thread-tabs", thread: 7 }, app)).tabs;
assert.equal(
  mine[0].active,
  true,
  "both panes of a split are on screen; only one of them is Chrome's active tab",
);
ok("the page beside the app counts as in view");

delete tabs.get(posting.id).splitViewId;
tabs.get(posting.id).active = true;

console.log("\n4. Another thread's pages are its own");

await say({ type: "split-pilot:thread", thread: 8 }, app);
const other = tabStub({ url: "https://example.com/job/2", title: "Another job" });
await say({ type: "split-pilot:adopt", tabId: other.id }, app);

assert.deepEqual(
  (await say({ type: "split-pilot:thread-tabs", thread: 7 }, app)).tabs.map((t) => t.id),
  [posting.id],
);
assert.deepEqual(
  (await say({ type: "split-pilot:thread-tabs", thread: 8 }, app)).tabs.map((t) => t.id),
  [other.id],
);
ok("thread 7 and thread 8 keep their own tabs");

console.log("\n5. Closing a thread closes its pages and nothing else");

const closed = await say({ type: "split-pilot:close-thread", thread: 7 }, app);
assert.equal(closed.closed, 1);
assert.equal(tabs.has(posting.id), false, "the thread's page is gone");
assert.equal(tabs.has(other.id), true, "the other thread's page is untouched");
assert.equal(tabs.has(app.id), true, "and so is the app");
ok("only that thread's pages close");

assert.deepEqual((await say({ type: "split-pilot:thread-tabs", thread: 7 }, app)).tabs, []);
ok("the thread is forgotten afterwards");

console.log("\n6. A page closed by hand leaves no ghost behind");

await chrome.tabs.remove(other.id);
assert.deepEqual((await say({ type: "split-pilot:thread-tabs", thread: 8 }, app)).tabs, []);
ok("closing a tab drops it from its thread");

console.log("\n7. A thread with nothing open closes nothing");

const nothing = await say({ type: "split-pilot:close-thread", thread: 99 }, app);
assert.equal(nothing.closed, 0);
ok("an unknown thread is not an error");

console.log("\n8. A link from the app opens beside the app, thread or no thread");

/*
  The case that reached the person: the app on no conversation, a posting
  opened from it, and a stray tab instead of a pane. An app tab with no
  thread open stored nothing, so nothing could tell it from any other tab
  in the browser.
*/
const plain = tabStub({ url: "http://localhost:5173/", title: "jobsearch" });
await say({ type: "split-pilot:thread", thread: null }, plain);

const posted = tabStub({ openerTabId: plain.id, pendingUrl: "https://jobs.example.com/1" });
await onCreated(posted);

const state = await say({ type: "split-pilot:state" }, plain);
assert.equal(state.paired, true, "the link should have made the pair");
assert.equal(state.right.id, posted.id);
ok("a posting opened from the app becomes the pane beside it");

console.log("\n9. A tab the app did not open is left alone");

const stranger = tabStub({ url: "https://news.example.com/", title: "News" });
const fromStranger = tabStub({ openerTabId: stranger.id, pendingUrl: "https://news.example.com/2" });
await onCreated(fromStranger);
assert.equal(tabs.has(fromStranger.id), true, "still open, and not adopted");
ok("the extension does not touch the rest of the browser");

console.log(`\n${passed} passed, 0 failed`);

/*
  The relay's focus rules, driven through the real RelayConnection.

  The driving tool selects a tab before most of what it does, and a selected
  tab raises the Chrome window — which on a Mac with several desktops takes
  the person away from whatever they were doing. The relay answers those two
  commands without acting on them, and opens driven tabs in the background.
  Both are checked here against a stubbed Chrome, because the fault they fix
  is invisible in any single call: it shows up as a window jumping.

  Run: node extension/test/relay.test.mjs
*/

import assert from "node:assert/strict";

let passed = 0;
function ok(what) {
  passed += 1;
  console.log(`  ok   ${what}`);
}

/* ------------------------------------------------------------------ stub */

/** Every CDP command the relay passed to Chrome, in order. */
const sent = [];
/** Every tabs.create the relay passed to Chrome, with its arguments. */
const created = [];
/** Every tab the relay actually closed. */
const removed = [];
/** Session storage, as the worker sees it. */
const session = new Map();
/** The tabs Chrome has, so a remembered id can be checked for existence. */
const living = new Set([3, 4]);
let nextTabId = 20;

function listenable() {
  return { addListener: () => {}, removeListener: () => {} };
}

globalThis.chrome = {
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (target, method, params) => {
      sent.push({ target, method, params });
      return { done: method };
    },
    onEvent: listenable(),
    onDetach: listenable(),
  },
  tabs: {
    create: async (properties) => {
      created.push(properties);
      const id = nextTabId++;
      living.add(id);
      return { id, ...properties };
    },
    remove: async (id) => {
      for (const one of Array.isArray(id) ? id : [id]) {
        removed.push(one);
        living.delete(one);
      }
    },
    get: async (id) => {
      if (!living.has(id)) throw new Error(`No tab with id: ${id}`);
      return { id };
    },
    onCreated: listenable(),
    onRemoved: listenable(),
  },
  storage: {
    session: {
      get: async (key) => (session.has(key) ? { [key]: session.get(key) } : {}),
      set: async (patch) => {
        for (const [key, value] of Object.entries(patch)) session.set(key, value);
      },
    },
  },
};

globalThis.WebSocket = { OPEN: 1 };

/** A socket that keeps what was written to it, in the order it arrived. */
class SocketStub {
  readyState = 1;
  written = [];
  onmessage;
  onclose;

  send(text) {
    this.written.push(JSON.parse(text));
  }

  close() {}

  /** A command from Playwright, answered. */
  async ask(id, method, params) {
    await this.onmessage({ data: JSON.stringify({ id, method, params }) });

    /*
      Wait for the answer, rather than for a tick.

      This used to let one setImmediate pass and then look. The handler is
      async all the way down and some paths await more than once, so the
      answer was usually there and occasionally was not — a test that fails
      about one run in ten teaches people to re-run it rather than to read
      it, which costs more than the bug it would have caught.
    */
    for (let tries = 0; tries < 200; tries += 1) {
      const answer = this.written.find((message) => message.id === id);
      if (answer) return answer;
      await new Promise((done) => setImmediate(done));
    }
    return undefined;
  }
}

const { RelayConnection } = await import("../relay.js");

const socket = new SocketStub();
const relay = new RelayConnection(socket);
relay.announce();

/* ----------------------------------------------------------------- tests */

console.log("\n1. A command that only raises the window is answered, not run");

let reply = await socket.ask(1, "chrome.debugger.sendCommand", [{ tabId: 3 }, "Page.bringToFront"]);
assert.deepEqual(reply, { id: 1, result: {} }, "it must look like an ordinary success");
assert.equal(
  sent.find((call) => call.method === "Page.bringToFront"),
  undefined,
  "Page.bringToFront reached Chrome",
);
ok("Page.bringToFront is dropped and reported as done");

reply = await socket.ask(2, "chrome.debugger.sendCommand", [{ tabId: 3 }, "Target.activateTarget"]);
assert.deepEqual(reply, { id: 2, result: {} });
assert.equal(
  sent.find((call) => call.method === "Target.activateTarget"),
  undefined,
  "Target.activateTarget reached Chrome",
);
ok("Target.activateTarget is dropped and reported as done");

console.log("\n2. Everything else still goes through");

reply = await socket.ask(3, "chrome.debugger.sendCommand", [
  { tabId: 3 },
  "Runtime.evaluate",
  { expression: "1 + 1" },
]);
assert.deepEqual(reply, { id: 3, result: { done: "Runtime.evaluate" } });
assert.equal(sent.at(-1)?.method, "Runtime.evaluate", "the command must reach Chrome unchanged");
assert.deepEqual(sent.at(-1)?.params, { expression: "1 + 1" });
ok("reading and driving a page is untouched");

console.log("\n3. A tab the tool opens arrives in the background");

reply = await socket.ask(4, "chrome.tabs.create", [{ url: "about:blank" }]);
assert.equal(reply?.result?.url, "about:blank", "the tab is still created and answered");
assert.deepEqual(
  created.at(-1),
  { url: "about:blank", active: false },
  "a new tab must not take the window",
);
ok("tabs.create is forced to active: false");

/*
  The tool asks for an active tab in so many words. Honouring it is what
  moved the person's desktop, so the answer is the same tab, opened quietly.
*/
await socket.ask(5, "chrome.tabs.create", [{ url: "https://example.com/", active: true }]);
assert.equal(created.at(-1)?.active, false, "an explicit active: true was obeyed");
ok("an explicit request to activate is overridden");

console.log("\n4. A tab the bridge did not open cannot be closed");

/*
  Tab 3 is the person's: the extension offers the session a tab to work with
  as it connects, and that is whatever they had in view. A disconnecting
  client asking to close it is how a window of their pages was lost.
*/
reply = await socket.ask(7, "chrome.tabs.remove", [3]);
assert.match(reply?.error ?? "", /only the tabs this bridge opened/);
assert.deepEqual(removed, [], "it closed a tab belonging to the person");
ok("closing an offered tab is refused");

console.log("\n5. A tab it did open still closes");

reply = await socket.ask(8, "chrome.tabs.create", [{ url: "about:blank" }]);
const stage = reply?.result?.id;
assert.equal(typeof stage, "number", "the stage must come back with an id");
reply = await socket.ask(9, "chrome.tabs.remove", [stage]);
assert.equal(reply?.error, undefined, reply?.error ?? "");
assert.deepEqual(removed, [stage], "the stage must be the only thing closed");
ok("closing a tab the bridge opened works");

console.log("\n6. And a mixed list closes nothing");

const second = (await socket.ask(10, "chrome.tabs.create", [{ url: "about:blank" }]))?.result?.id;
removed.length = 0;
reply = await socket.ask(11, "chrome.tabs.remove", [[second, 4]]);
assert.match(reply?.error ?? "", /only the tabs this bridge opened/);
assert.deepEqual(removed, [], "one of the person's tabs went with the batch");
ok("a remove naming one tab of theirs is refused whole");

console.log("\n7. A method outside the five is still refused");

reply = await socket.ask(12, "chrome.windows.update", [1, { focused: true }]);
assert.match(reply?.error ?? "", /Unknown method/);
ok("the allowed list is unchanged");

console.log(`\n${passed} passed, 0 failed`);

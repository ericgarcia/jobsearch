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
      return { id: 7, ...properties };
    },
    remove: async () => {},
    get: async (id) => ({ id }),
    onCreated: listenable(),
    onRemoved: listenable(),
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
    // The handler is async all the way down; let its last await settle.
    await new Promise((done) => setImmediate(done));
    return this.written.find((message) => message.id === id);
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

console.log("\n4. A method outside the five is still refused");

reply = await socket.ask(6, "chrome.windows.update", [1, { focused: true }]);
assert.match(reply?.error ?? "", /Unknown method/);
ok("the allowed list is unchanged");

console.log(`\n${passed} passed, 0 failed`);

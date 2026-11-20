/*
  The extension as the way in, against a stubbed Chrome and a real daemon.

  The reason to have this path at all is that it is not subject to Chrome's
  private-network rule: the service worker holds host permissions, so its
  fetch is an ordinary one. The reason to be careful with it is the same
  fact from the other side — a relayed request arrives at the service with
  no page origin on it, so the Origin check that guards the direct path
  cannot work here, and the ticket is carrying the whole load.

  So this tests both halves: that the bridge only relays for pages it
  should, and that the service still refuses a relayed request that has no
  good ticket.

  Run: node spikes/connect/bridge.test.mjs
*/

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const HUB_PORT = 7311;
const DAEMON_PORT = 7312;
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
process.env.SPIKE_HUB_PORT = String(HUB_PORT);
process.env.SPIKE_DAEMON_PORT = String(DAEMON_PORT);
process.env.SPIKE_HUB = `http://127.0.0.1:${HUB_PORT}`;
process.env.SPIKE_EXTENSION_ID = EXTENSION_ID;

globalThis.JOBSEARCH_DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;
const { daemon, pair, unpair } = await import("./daemon.mjs");
const { hub, mintTicket } = await import("./hub.mjs");
const { bridge, allowedSenders } = await import("./bridge.js");

let passed = 0;
const ok = (what) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

const hubServer = hub().listen(HUB_PORT);
const daemonServer = daemon().listen(DAEMON_PORT, "127.0.0.1");

const paired = await pair(async (line) => {
  const code = /enter\s+([0-9A-F]+)/.exec(line);
  if (!code) return;
  await fetch(`http://127.0.0.1:${HUB_PORT}/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "who=eric" },
    body: JSON.stringify({ user_code: code[1] }),
  });
});

/* ------------------------------------------------------------------ stub */

/**
 * A port, as Chrome hands one to onConnectExternal.
 *
 * Everything the page would see comes back through `heard`, so a test can
 * read what a page would have been told.
 */
function fakePort() {
  const listeners = { message: [], disconnect: [] };
  const heard = [];
  let open = true;
  return {
    heard,
    get open() {
      return open;
    },
    name: "jobsearch:work",
    postMessage: (value) => heard.push(value),
    disconnect: () => {
      open = false;
      for (const one of listeners.disconnect) one();
    },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    /* The page's side. */
    send: async (value) => {
      for (const one of listeners.message) await one(value);
    },
  };
}

/*
  The extension's fetch, which is an ordinary one with the extension's own
  origin on it — exactly what Chrome sends from a service worker, and the
  reason the daemon cannot read the page's origin on this path.
*/
const asExtension = (url, options = {}) =>
  fetch(url, {
    ...options,
    headers: { ...(options.headers ?? {}), origin: `chrome-extension://${EXTENSION_ID}` },
  });

const ticketFor = (owner = "eric", id = paired.daemon_id, key = paired.secret, life = 120_000) =>
  mintTicket(id, owner, key, life);

const settled = (port) =>
  new Promise((done) => {
    port.onDisconnect.addListener(done);
    setTimeout(done, 3000);
  });

console.log("\n1. Only pages the extension is for");

{
  const port = fakePort();
  bridge(port, { origin: "https://evil.example" }, asExtension);
  assert.deepEqual(port.heard[0].at, "refused");
  assert.equal(port.open, false);
  ok("a page the extension should not serve is refused before anything is fetched");
}

{
  const port = fakePort();
  bridge(port, { origin: "https://evil.example" }, async () => {
    throw new Error("the bridge fetched for a page it should have refused");
  });
  await port.send({ type: "work", ticket: ticketFor() });
  ok("and sending work to a refused port reaches no fetch at all");
}

assert.ok(allowedSenders().every((one) => /^https?:\/\//.test(one)));
ok("the senders it will serve are exact origins, not patterns");

console.log("\n2. A page it is for, with a good ticket");

{
  const port = fakePort();
  bridge(port, { origin: "http://localhost:7201" }, asExtension);
  await port.send({ type: "work", ticket: ticketFor() });
  await settled(port);
  const steps = port.heard.map((one) => one.at);
  assert.deepEqual(steps, ["start", "working", "working", "working", "done", "closed"]);
  ok("the work streams through the extension to the page, a piece at a time");
  assert.equal(port.heard[0].owner, "eric");
  ok("and the service knows whose work it is, from the ticket rather than the page");
}

console.log("\n3. The ticket is carrying the whole load here");

for (const [what, ticket] of [
  ["none", ""],
  ["signed with the wrong secret", mintTicket(paired.daemon_id, "eric", randomBytes(32).toString("base64url"))],
  ["for somebody else", ticketFor("sam")],
  ["for another machine", ticketFor("eric", "machine-2")],
  ["expired", ticketFor("eric", paired.daemon_id, paired.secret, -1000)],
]) {
  const port = fakePort();
  bridge(port, { origin: "http://localhost:7201" }, asExtension);
  await port.send({ type: "work", ticket });
  await settled(port);
  assert.deepEqual(port.heard, [{ at: "refused", status: 401 }], `ticket ${what} was not refused`);
}
ok("a relayed request with no good ticket is refused, five ways");

console.log("\n4. The service tells the two paths apart");

{
  /*
    The same request without the extension's origin on it is a browser
    request from nowhere, and the Origin check that guards the direct path
    turns it away. That is what makes naming one extension id meaningful
    rather than decorative.
  */
  const bare = await fetch(`http://127.0.0.1:${DAEMON_PORT}/work`, {
    headers: { authorization: `Bearer ${ticketFor()}`, origin: "chrome-extension://someone-else" },
  });
  assert.equal(bare.status, 403);
  ok("another extension relaying the same good ticket is refused");
}

console.log("\n5. Taking the machine back reaches this path too");

unpair();
{
  const port = fakePort();
  bridge(port, { origin: "http://localhost:7201" }, asExtension);
  await port.send({ type: "work", ticket: ticketFor() });
  await settled(port);
  assert.deepEqual(port.heard, [{ at: "refused", status: 401 }]);
  ok("a disconnected machine refuses through the extension exactly as it does directly");
}

console.log(`\n${passed} passed, 0 failed`);
hubServer.close();
daemonServer.close();

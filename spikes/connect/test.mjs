/*
  What the daemon refuses.

  Everything else in this spike is plumbing that either works or visibly
  does not. This is the part that fails quietly: a daemon on a known port
  is reachable by every page the person visits, so each of these is a way
  somebody else's site could drive their computer.

  Run: node spikes/connect/test.mjs
*/

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

const HUB_PORT = 7301;
const DAEMON_PORT = 7302;
/* Set before the modules load, because both read their config at import. */
process.env.SPIKE_HUB_PORT = String(HUB_PORT);
process.env.SPIKE_DAEMON_PORT = String(DAEMON_PORT);
process.env.SPIKE_HUB = `http://127.0.0.1:${HUB_PORT}`;

const { daemon, pairing, pair, unpair } = await import("./daemon.mjs");
const { hub, mintTicket } = await import("./hub.mjs");

let passed = 0;
const ok = (what) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

const MINE = "http://localhost:7201";
const THEIRS = "https://evil.example";

const hubServer = hub().listen(HUB_PORT);
const daemonServer = daemon().listen(DAEMON_PORT, "127.0.0.1");
const at = (path) => `http://127.0.0.1:${DAEMON_PORT}${path}`;

/*
  Paired through the real flow rather than by reaching inside the daemon:
  it asks the hub for a code, the code is approved as a signed-in person,
  and the daemon collects the result. Anything that skipped this would be
  testing a handshake nobody performs.
*/
const paired = await pair(async (line) => {
  const code = /enter\s+([0-9A-F]+)/.exec(line);
  if (!code) return;
  await fetch(`http://127.0.0.1:${HUB_PORT}/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "who=eric" },
    body: JSON.stringify({ user_code: code[1] }),
  });
});
assert.equal(paired.owner, "eric");
assert.equal(pairing().owner, "eric");

const ticketFor = (owner = "eric", id = paired.daemon_id, key = paired.secret, life = 120_000) =>
  mintTicket(id, owner, key, life);

console.log("\n1. A page we do not know gets nothing");

const foreign = await fetch(at("/ping"), { headers: { origin: THEIRS } });
assert.equal(foreign.status, 403);
assert.equal(foreign.headers.get("access-control-allow-origin"), null);
ok("a request from another site is refused, with no CORS header to let it read the answer");

const foreignWithTicket = await fetch(at("/work"), {
  headers: { origin: THEIRS, authorization: `Bearer ${ticketFor()}` },
});
assert.equal(foreignWithTicket.status, 403);
ok("and a stolen ticket does not help it, because the origin is checked first");

console.log("\n2. Our own page still needs a ticket");

const noTicket = await fetch(at("/work"), { headers: { origin: MINE } });
assert.equal(noTicket.status, 401);
ok("a page on the right origin with no ticket is refused");

const wrongKey = await fetch(at("/work"), {
  headers: { origin: MINE, authorization: `Bearer ${ticketFor("eric", paired.daemon_id, randomBytes(32).toString("base64url"))}` },
});
assert.equal(wrongKey.status, 401);
ok("a ticket signed with the wrong secret is refused, which is the one that matters");

const forged = (() => {
  const claim = Buffer.from(
    JSON.stringify({ daemon: paired.daemon_id, owner: "eric", exp: Date.now() + 60_000 }),
  ).toString("base64url");
  return `${claim}.${createHmac("sha256", "guess").update(claim).digest("base64url")}`;
})();
assert.equal((await fetch(at("/work"), { headers: { origin: MINE, authorization: `Bearer ${forged}` } })).status, 401);
ok("and so is one somebody signed themselves");

console.log("\n3. A ticket is for one person, one machine, one moment");

const sam = await fetch(at("/work"), {
  headers: { origin: MINE, authorization: `Bearer ${ticketFor("sam")}` },
});
assert.equal(sam.status, 401);
ok("a ticket for somebody else is refused, so sharing a computer is not sharing an account");

const other = await fetch(at("/work"), {
  headers: { origin: MINE, authorization: `Bearer ${ticketFor("eric", "machine-2")}` },
});
assert.equal(other.status, 401);
ok("a ticket for another machine is refused, so one is no use on the rest of their computers");

const stale = await fetch(at("/work"), {
  headers: { origin: MINE, authorization: `Bearer ${ticketFor("eric", paired.daemon_id, paired.secret, -1000)}` },
});
assert.equal(stale.status, 401);
ok("an expired ticket is refused, so one left in a log stops working");

console.log("\n4. What it does for a caller that passes");

const working = await fetch(at("/work"), {
  headers: { origin: MINE, authorization: `Bearer ${ticketFor()}` },
});
assert.equal(working.status, 200);
assert.equal(working.headers.get("content-type"), "text/event-stream");
const streamed = [];
for await (const chunk of working.body) {
  for (const line of Buffer.from(chunk).toString("utf8").split("\n")) {
    if (line.startsWith("data: ")) streamed.push(JSON.parse(line.slice(6)));
  }
}
assert.deepEqual(
  streamed.map((one) => one.at),
  ["start", "working", "working", "working", "done"],
);
ok("the work streams back a piece at a time, which is what an agent is");

console.log("\n5. The preflight a public page needs");

const preflight = await fetch(at("/work"), {
  method: "OPTIONS",
  headers: {
    origin: MINE,
    "access-control-request-method": "GET",
    "access-control-request-private-network": "true",
  },
});
assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
assert.equal(preflight.headers.get("access-control-allow-origin"), MINE);
ok("a known origin asking to reach a private address is told it may");

const theirPreflight = await fetch(at("/work"), {
  method: "OPTIONS",
  headers: {
    origin: THEIRS,
    "access-control-request-method": "GET",
    "access-control-request-private-network": "true",
  },
});
assert.equal(theirPreflight.headers.get("access-control-allow-private-network"), null);
assert.equal(theirPreflight.headers.get("access-control-allow-origin"), null);
ok("and an unknown one is told nothing, so the request never leaves the browser");

console.log("\n6. Taking the machine back");

unpair();
assert.equal(
  (await fetch(at("/work"), { headers: { origin: MINE, authorization: `Bearer ${ticketFor()}` } }))
    .status,
  401,
);
ok("every ticket for a machine stops the moment its pairing is gone");

const quiet = await fetch(at("/ping"), { headers: { origin: MINE } }).then((r) => r.json());
assert.deepEqual(Object.keys(quiet).sort(), ["app", "paired"]);
assert.equal(quiet.paired, false);
ok("and the one call that answers without a ticket still names nobody and nothing");

console.log(`\n${passed} passed, 0 failed`);
hubServer.close();
daemonServer.close();

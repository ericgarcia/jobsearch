/*
  The hosted app, standing in for Next on Vercel.

  It owns the account and the page, and it is the only thing that can say
  "this machine belongs to this person". It never talks to the daemon: the
  browser does that directly, which is the whole point — the person's work
  does not pass through here.

  What it issues instead is a ticket. Each paired machine shares a secret
  with the hub, and a ticket is that secret's signature over "this owner,
  this machine, for the next two minutes". The daemon can check one with no
  network call, which matters because the daemon has to work when this is
  unreachable.

  Everything here is in memory and the sign-in is a name in a box. Both are
  wrong for production and right for a spike: the question is the transport
  and the handshake, and a real session store would answer neither.
*/

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.SPIKE_HUB_PORT ?? 7201);
const here = path.dirname(new URL(import.meta.url).pathname);

/** device_code -> { user_code, owner, daemon_id, secret } */
const pairings = new Map();
/** daemon_id -> { owner, secret } */
const machines = new Map();

function body(request) {
  return new Promise((done) => {
    let text = "";
    request.on("data", (part) => (text += part));
    request.on("end", () => {
      try {
        done(text ? JSON.parse(text) : {});
      } catch {
        done({});
      }
    });
  });
}

function json(response, code, value) {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

/**
 * Who is asking.
 *
 * A cookie with a name in it. In the real thing this is the session, and
 * everything below it is unchanged: the ticket is minted for whoever the
 * session says is signed in, and for no one else.
 */
function signedIn(request) {
  const cookie = request.headers.cookie ?? "";
  const found = /(?:^|;\s*)who=([^;]+)/.exec(cookie);
  return found ? decodeURIComponent(found[1]) : null;
}

/** A short-lived note from the hub that this person owns that machine. */
function mintTicket(daemon_id, owner, secret, lifeMs = 120_000) {
  const claim = Buffer.from(
    JSON.stringify({ daemon: daemon_id, owner, exp: Date.now() + lifeMs }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(claim).digest("base64url");
  return `${claim}.${signature}`;
}

export function hub() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);

    /* ---- the page itself, which is all the person ever sees ---- */
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const page = await readFile(path.join(here, "page.html"), "utf8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }

    if (url.pathname === "/signin") {
      const who = url.searchParams.get("who") ?? "eric";
      response.writeHead(302, {
        "set-cookie": `who=${encodeURIComponent(who)}; Path=/; SameSite=Lax`,
        location: "/",
      });
      response.end();
      return;
    }

    if (url.pathname === "/me") {
      return json(response, 200, { who: signedIn(request) });
    }

    /* ---- the device grant ---- */

    /* Started by the machine, which has no browser and no password. */
    if (url.pathname === "/device/code" && request.method === "POST") {
      const device_code = randomUUID();
      const user_code = randomBytes(3).toString("hex").toUpperCase();
      pairings.set(device_code, { user_code, owner: null, daemon_id: null, secret: null });
      return json(response, 200, {
        device_code,
        user_code,
        verify_url: `http://127.0.0.1:${PORT}/`,
      });
    }

    /*
      Approved in the app, by the person, under their own session. This is
      the only place a machine is bound to an owner, and it cannot happen
      without somebody signed in typing the code they are looking at.
    */
    if (url.pathname === "/device/approve" && request.method === "POST") {
      const who = signedIn(request);
      if (!who) return json(response, 401, { error: "sign in first" });
      const { user_code } = await body(request);
      const found = [...pairings.entries()].find(
        ([, one]) => one.user_code === String(user_code ?? "").toUpperCase(),
      );
      if (!found) return json(response, 404, { error: "no such code" });

      const [, pairing] = found;
      pairing.owner = who;
      pairing.daemon_id = randomUUID();
      pairing.secret = randomBytes(32).toString("base64url");
      machines.set(pairing.daemon_id, { owner: who, secret: pairing.secret });
      return json(response, 200, { connected: true });
    }

    /* Polled by the machine until the person has said yes. */
    if (url.pathname === "/device/token" && request.method === "POST") {
      const { device_code } = await body(request);
      const pairing = pairings.get(device_code);
      if (!pairing) return json(response, 404, { error: "unknown device code" });
      if (!pairing.owner) return json(response, 200, { error: "pending" });
      pairings.delete(device_code);
      return json(response, 200, {
        daemon_id: pairing.daemon_id,
        owner: pairing.owner,
        secret: pairing.secret,
      });
    }

    /*
      The ticket the page carries to the daemon. Minted for the signed-in
      person and the machine they own, and good for two minutes — long
      enough to start a piece of work, short enough that one left in a log
      is not a key to somebody's computer.
    */
    if (url.pathname === "/connect-ticket") {
      const who = signedIn(request);
      if (!who) return json(response, 401, { error: "sign in first" });
      const mine = [...machines.entries()].find(([, one]) => one.owner === who);
      if (!mine) return json(response, 404, { error: "no machine connected" });
      const [daemon_id, machine] = mine;
      return json(response, 200, {
        daemon_id,
        ticket: mintTicket(daemon_id, who, machine.secret),
      });
    }

    /* Taking a machine back, which stops every ticket for it at once. */
    if (url.pathname === "/device/revoke" && request.method === "POST") {
      const who = signedIn(request);
      if (!who) return json(response, 401, { error: "sign in first" });
      for (const [id, one] of machines) if (one.owner === who) machines.delete(id);
      return json(response, 200, { revoked: true });
    }

    return json(response, 404, { error: "no such route" });
  });
}

export { PORT, mintTicket, machines };

if (process.argv[1]?.endsWith("hub.mjs")) {
  hub().listen(PORT, () => console.log(`  hub on http://127.0.0.1:${PORT}`));
}

/*
  The local service, with no UI of its own.

  This is what a person installs. It holds the Claude credential, runs the
  agent, drives their Chrome and reads the folders they allow — none of
  which can move to a server. Everything they look at is served from the
  hosted app, so the only question this spike exists to answer is whether a
  page on a public origin can reach this, safely, and what it costs.

  The dangerous part is that any page can reach it. A daemon on a known
  port that answers an unauthenticated request is a daemon that evil.com
  can drive: read the folders its owner granted, run the agent, read the
  profile. So two checks, and both of them every time.

  The Origin has to be one we know. That stops a page from another site
  being *given* an answer by the browser, and it is cheap and strong, but
  it is one header on a request anything can make, so it is not enough on
  its own.

  And the caller has to hold a ticket, signed with a secret this daemon and
  the hub agreed at pairing. That is the one that actually proves something:
  only the hub has the secret, and the hub only mints a ticket for the
  person who owns this daemon.
*/

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.SPIKE_DAEMON_PORT ?? 7202);
const HUB = process.env.SPIKE_HUB ?? "http://127.0.0.1:7201";

/*
  The origins a page may call us from. In the real thing this is the hosted
  app and nothing else; the localhost entry is here because that is where
  the hosted app runs while it is being written.
*/
const ALLOWED = (process.env.SPIKE_ALLOWED_ORIGINS ?? "https://jobsearch.example,http://localhost:7201,http://127.0.0.1:7201")
  .split(",")
  .map((one) => one.trim())
  .filter(Boolean);

/*
  The one extension allowed to relay, when there is one. Named exactly: an
  extension id is as good as an origin, and "any extension" would be a hole
  the size of whatever else the person has installed.
*/
const EXTENSION_ID = process.env.SPIKE_EXTENSION_ID ?? null;

/* What pairing produced: who owns this machine, and the secret we share. */
let paired = null; // { daemon_id, owner, secret }

/* ------------------------------------------------------------- tickets */

function sign(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Whether this ticket was minted by the hub, for us, for our owner, now.
 *
 * Compared in constant time, because a check that returns early on the
 * first wrong byte tells the caller how much of the signature was right.
 */
function ticketHolder(ticket) {
  if (!paired || typeof ticket !== "string") return null;
  const [body, signature] = ticket.split(".");
  if (!body || !signature) return null;

  const want = Buffer.from(sign(paired.secret, body));
  const got = Buffer.from(signature);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;

  let claim;
  try {
    claim = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claim.daemon !== paired.daemon_id) return null;
  if (claim.owner !== paired.owner) return null;
  if (typeof claim.exp !== "number" || claim.exp < Date.now()) return null;
  return claim.owner;
}

/* ---------------------------------------------------------------- CORS */

/**
 * What a browser is told about a request from a page.
 *
 * Chrome asks before letting a public page reach a private address — the
 * preflight carries Access-Control-Request-Private-Network and wants
 * Access-Control-Allow-Private-Network back. Answering it is the price of
 * being reachable at all; refusing is how a daemon that did not mean to be
 * public stays unreachable.
 */
/**
 * The extension relaying for a page, which is the other way in.
 *
 * A fetch from a service worker carries the extension's own origin, not
 * the page's, and a header claiming the page's origin would be a string
 * the page could write. So on this path the Origin check cannot do its
 * job, and the ticket is the whole of the proof — which it was anyway, the
 * Origin being the cheap second fence rather than the lock. The fence moves
 * into the extension's manifest: whatever may connect to the extension may
 * relay through it.
 */
function fromExtension(request) {
  const origin = request.headers.origin ?? "";
  return EXTENSION_ID !== null && origin === `chrome-extension://${EXTENSION_ID}`;
}

function cors(request, response) {
  const origin = request.headers.origin;
  if (fromExtension(request)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    return true;
  }
  if (!origin || !ALLOWED.includes(origin)) return false;

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  return true;
}

function json(response, code, body) {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/* -------------------------------------------------------------- pairing */

/**
 * Ask the hub to start a pairing, and wait for the person to approve it.
 *
 * The device grant, because the thing being paired has no browser of its
 * own and should never ask anybody for a password. It prints a short code;
 * the person types that into the app they are already signed in to; the
 * approval happens there, under their own session, and this learns who it
 * belongs to only once they have said so.
 */
export async function pair(say = console.log) {
  const started = await fetch(`${HUB}/device/code`, { method: "POST" }).then((r) => r.json());
  say(`\n  Connect this computer: open ${started.verify_url} and enter  ${started.user_code}\n`);

  for (;;) {
    await new Promise((go) => setTimeout(go, 500));
    const answer = await fetch(`${HUB}/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: started.device_code }),
    }).then((r) => r.json());

    if (answer.error === "pending") continue;
    if (answer.error) throw new Error(answer.error);
    paired = answer;
    say(`  Connected as ${answer.owner}.`);
    return answer;
  }
}

/** Forget this machine's pairing, as taking it back on the account does. */
export function unpair() {
  paired = null;
}

export function pairing() {
  return paired;
}

/* --------------------------------------------------------------- server */

export function daemon() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
    /*
      Logged because the question this spike cannot answer by itself is
      whether a request from a public page reaches a private address at
      all. A refusal here is the daemon's; silence is the browser's.
    */
    console.log(
      `  ${request.method} ${url.pathname} from ${request.headers.origin ?? "no origin"}${
        request.headers["access-control-request-private-network"] ? " [private-network]" : ""
      }`,
    );
    const known = cors(request, response);

    if (request.method === "OPTIONS") {
      /*
        A preflight from somewhere we do not know gets no CORS headers, so
        the browser refuses the request that would have followed. Answering
        204 either way keeps this from being a way to ask which origins are
        allowed.
      */
      response.writeHead(204);
      response.end();
      return;
    }

    /*
      Is anybody home? Deliberately says nothing else: not who owns this
      machine, not what is on it. The hosted app calls this to decide
      between "your computer is connected" and "it is not", and a page that
      has no business here learns only that something is listening.
    */
    if (url.pathname === "/ping") {
      if (!known) return json(response, 403, { error: "unknown origin" });
      return json(response, 200, { app: "jobsearch", paired: paired !== null });
    }

    if (!known) return json(response, 403, { error: "unknown origin" });

    const ticket = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    const holder = ticketHolder(ticket);
    if (!holder) return json(response, 401, { error: "no ticket for this machine" });

    /*
      Work, streamed. The spike's point is that a long answer reaches the
      page a piece at a time through this transport, because that is what
      the agent is: minutes of output, not one reply.
    */
    if (url.pathname === "/work") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": request.headers.origin,
      });
      const say = (data) => response.write(`data: ${JSON.stringify(data)}\n\n`);
      say({ at: "start", owner: holder });
      let n = 0;
      const tick = setInterval(() => {
        n += 1;
        say({ at: "working", step: n });
        if (n === 3) {
          clearInterval(tick);
          say({ at: "done" });
          response.end();
        }
      }, 120);
      request.on("close", () => clearInterval(tick));
      return;
    }

    return json(response, 404, { error: "no such route" });
  });
}

export { PORT, ALLOWED, randomUUID };

if (process.argv[1]?.endsWith("daemon.mjs")) {
  daemon().listen(PORT, "127.0.0.1", () => {
    console.log(`  daemon on http://127.0.0.1:${PORT}`);
    void pair();
  });
}

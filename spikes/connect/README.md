# Can a hosted page drive a service on the person's own machine?

Yes, over `http://127.0.0.1`, and the handshake that makes it safe is small.
One check is still open: whether Chrome lets a genuinely public page through
to a private address. See **What is still unanswered** below.

The shape this is for: the person installs a service and a Chrome extension
and never runs a web app locally. Everything they look at is served from the
hosted app. The service holds the Claude credential, runs the agent, drives
their Chrome and reads the folders they allow — none of which can move to a
server, and all of which the hosted page has to be able to start.

Run it:

```
node spikes/connect/hub.mjs
```

```
node spikes/connect/daemon.mjs
```

Then open `http://localhost:7201`, type the code the daemon printed, and
press Run. The refusals have their own suite:

```
node spikes/connect/test.mjs
```

## The three pieces

| | stands in for | holds |
| --- | --- | --- |
| `hub.mjs` | Next on Vercel | the account, the page, and the secret each paired machine shares |
| `daemon.mjs` | the installed service | the pairing, and the work |
| `page.html` | the hosted app | everything the person sees |

The hub never calls the daemon. The browser does, directly, so the person's
work does not pass through the server — which is the reason to build it this
way rather than relaying everything.

## The handshake

The device grant, because the thing being paired has no browser of its own
and should never ask anyone for a password.

1. The service asks the hub for a code and prints it.
2. The person types that code into the app they are already signed in to.
3. The hub binds the machine to them and generates a secret the two share.
4. The page asks the hub for a **ticket**: that secret's signature over
   "this owner, this machine, for the next two minutes".
5. The page presents the ticket to the service, which checks it with no
   network call — so the service keeps working when the hub is unreachable.

## What stops another site driving their computer

This is the part worth being careful about. A service on a known port is
reachable by **every page the person visits**, so each row here is a way
somebody else's site could read the folders they granted or run the agent.

Two checks, both every time. The Origin must be one we know, and the caller
must hold a ticket. Neither alone: an Origin header is one line on a request
anything can make, and a ticket could in principle be captured.

| A caller that | gets |
| --- | --- |
| is another site | `403`, and no CORS header, so the browser will not hand it the answer either |
| is another site holding a valid ticket | `403` — the origin is checked first |
| is our page with no ticket | `401` |
| signs its own ticket | `401` |
| holds a ticket signed with the wrong secret | `401` |
| holds a ticket for a different person | `401` |
| holds a ticket for a different machine | `401` |
| holds a ticket that has expired | `401` |
| holds a ticket for a machine whose pairing was taken back | `401` |
| asks `/ping` from a known origin | `{app, paired}` — never who owns it or what is on it |

Thirteen assertions in `test.mjs`. They are the spike's real output: the
streaming and the pairing either work in front of you or visibly do not,
but a missing refusal fails quietly and in somebody else's favour.

## What it settled

- A page on one origin can call a service on `127.0.0.1` on another port,
  and read the answer, given CORS from the service. No TLS needed on the
  service: browsers treat `localhost` and `127.0.0.1` as trustworthy, so
  this is not mixed content.
- Server-sent events come back through that call a piece at a time, which
  is what the agent needs — minutes of output, not one reply.
- A ticket signed with a per-machine secret lets the service authorise a
  caller with no call to the hub, so the service does not go down when the
  hub does.
- Taking a machine back on the account stops every ticket for it at once,
  because the service checks against its own pairing rather than a copy.
- "Your computer is not connected" is a 1.5-second timeout on `/ping`, and
  the hosted app can show it honestly. That path matters more than the happy
  one: everything the product does well depends on a service being installed
  and running.

## What is still unanswered

**Whether Chrome lets a public HTTPS page reach `127.0.0.1` at all.**

Chrome gates public-to-private requests behind a preflight that asks for
`Access-Control-Allow-Private-Network`. The service sends that header to a
known origin and withholds it from everything else, and both are asserted —
but asserting a header is not the same as watching a browser accept it, and
the behaviour has shifted across Chrome versions.

Testing it needs a genuinely public origin: a page on `localhost:7201`
calling `127.0.0.1:7202` is private-to-private and never meets the rule. So:

1. Deploy `page.html` to a Vercel preview.
2. Start the daemon with that origin allowed:
   `SPIKE_ALLOWED_ORIGINS=https://your-preview.vercel.app node spikes/connect/daemon.mjs`
3. Open the preview and press Run, then read the daemon's log.

The log is the instrument. A line with `[private-network]` means the browser
let the preflight through and the rule is satisfied. **No line at all** means
the browser stopped it before it left, and the fallback is the extension:
its service worker has host permissions, so it can reach the service without
CORS or private-network preflights, and the page talks to the extension
through `externally_connectable`. That is the reason to keep the transport
swappable rather than calling `fetch` from fifty places.

## What this is not

In-memory everything, and a sign-in that is a name in a box. Both are wrong
for production and right here: the questions were the transport and the
handshake, and a real session store would have answered neither.

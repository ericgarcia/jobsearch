/*
  The extension as the way in, instead of the page calling the service.

  A page on a public origin reaching 127.0.0.1 is subject to Chrome's
  private-network rule, and that rule has moved across versions. The
  extension is not: its service worker holds host permissions, so a fetch
  from here faces neither CORS nor a private-network preflight. The page
  never touches the service at all — it opens a port to the extension, and
  the extension does the fetching.

  This is written to be lifted into background.js beside the other
  split-pilot handlers. It is kept here while it is a spike so that the
  shipped extension does not grow a surface before the shape is settled.

  The thing to understand before using it: relaying through an extension
  takes away the service's Origin check. A fetch from a service worker does
  not carry the page's origin, and a header claiming one would be a string
  the page could write. So on this path the ticket is the whole of the
  proof, and the second fence moves into the manifest — whatever is in
  `externally_connectable.matches` can relay. Today that list is a wildcard
  over every localhost port, so any page served from any local port can.
  For this to carry real traffic it has to name the hosted origin, with
  localhost there only while the hosted app is being written.

  (The pattern itself is not quoted here: a glob with a star next to a
  slash closes a block comment, which is how this file first failed to
  parse.)
*/

/**
 * Where the service listens. One address, fixed here rather than taken
 * from the page: a page that could name the host could point this at
 * anything and have the extension fetch it with host permissions.
 *
 * Overridable only from the extension's own environment, which in the
 * shipped thing is a constant and here is how a test reaches its own
 * daemon instead of whichever one happens to be running.
 */
const DAEMON = globalThis.JOBSEARCH_DAEMON ?? "http://127.0.0.1:7202";

/** How long one piece of work may stream before the bridge gives up. */
const LONGEST_MS = 10 * 60 * 1000;

/**
 * Pages allowed to relay, checked here as well as in the manifest.
 *
 * Belt and braces, and cheap: `externally_connectable` is the real gate,
 * but it is a wildcard during development and a mistake there would be
 * silent. This list is exact.
 */
export function allowedSenders() {
  return ["https://jobsearch.example", "http://localhost:7201", "http://127.0.0.1:7201"];
}

function originOf(sender) {
  /* Chrome gives the sender's origin; fall back to the tab's URL. */
  if (sender?.origin) return sender.origin;
  try {
    return sender?.url ? new URL(sender.url).origin : null;
  } catch {
    return null;
  }
}

/**
 * Carry one piece of work between a page and the service.
 *
 * A port rather than a message, because the answer arrives over minutes in
 * pieces. The page posts what it wants once; everything after that goes the
 * other way.
 */
export function bridge(port, sender, fetchImpl = fetch) {
  const from = originOf(sender);
  if (!allowedSenders().includes(from)) {
    port.postMessage({ at: "refused", why: "this page may not reach your computer" });
    port.disconnect();
    return;
  }

  let stop = null;

  port.onMessage.addListener(async (message) => {
    if (message?.type !== "work") return;
    if (stop) return; /* One piece of work per port. */

    const control = new AbortController();
    stop = control;
    const giveUp = setTimeout(() => control.abort(), LONGEST_MS);

    try {
      const answer = await fetchImpl(`${DAEMON}/work`, {
        /*
          The ticket, and nothing else that matters. The service checks it
          against the secret it shares with the hub, which is the one thing
          a page cannot forge and an extension cannot launder.
        */
        headers: { authorization: `Bearer ${String(message.ticket ?? "")}` },
        signal: control.signal,
      });

      if (!answer.ok) {
        port.postMessage({ at: "refused", status: answer.status });
        port.disconnect();
        return;
      }

      const reader = answer.body.getReader();
      const decode = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decode.decode(value, { stream: true }).split("\n")) {
          if (line.startsWith("data: ")) port.postMessage(JSON.parse(line.slice(6)));
        }
      }
      port.postMessage({ at: "closed" });
    } catch (error) {
      port.postMessage({ at: "failed", why: String(error?.message ?? error) });
    } finally {
      clearTimeout(giveUp);
      port.disconnect();
    }
  });

  /* The page went away: stop asking the service to keep working. */
  port.onDisconnect.addListener(() => stop?.abort());
}

/** Registered the way background.js registers its other external surfaces. */
export function listen(runtime = globalThis.chrome?.runtime) {
  runtime.onConnectExternal.addListener((port) => {
    if (port.name !== "jobsearch:work") return;
    bridge(port, port.sender);
  });
}

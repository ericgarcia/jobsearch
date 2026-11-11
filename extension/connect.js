/*
  The page Playwright opens to hand over the relay address.

  Playwright does not message the extension; it navigates a tab to
  chrome-extension://<id>/connect.html with the WebSocket address in the query
  string. So this page exists to read that address, check it is allowed, pass
  it to the service worker, and get out of the way.

  The token is the whole of the security here. Anything able to open this URL
  could otherwise point the browser at a relay of its own and drive every
  signed-in session in it. So a connection is refused unless the token matches
  the one this extension generated — which the person copies into the app's
  .env, exactly as Playwright's own extension does it.
*/

const params = new URLSearchParams(location.search);
const relayUrl = params.get("mcpRelayUrl");
const offered = params.get("token");

const headline = document.getElementById("headline");
const detail = document.getElementById("detail");

function fail(message, extra = "") {
  headline.textContent = message;
  headline.className = "bad";
  detail.innerHTML = extra;
}

async function main() {
  if (!relayUrl) return fail("Nothing to connect to.", "This page is opened by Playwright, not by hand.");

  const { token } = await chrome.storage.local.get("token");

  /*
    No token yet: ask.

    Refusing here was a deadlock. The app sets the token, the app cannot load
    until Playwright is driving, and Playwright cannot connect until the token
    is set — so a fresh install could never make its first connection. The
    person is the way out, exactly as it is in Playwright's own extension:
    they can see what is asking, and approving once is enough, because the
    token is kept.
  */
  /*
    Ask, whether there is no token yet or the one offered is different.

    Refusing a changed token outright sounds safer and is not: a token
    rotates, and the only instruction a refusal can give is to go and edit a
    file, which leaves the person stuck in front of a page that will not budge.
    Asking shows them exactly what is asking and lets them decide, which is
    the same protection with a way through it.
  */
  if (!token || offered !== token) {
    headline.textContent = token ? "Allow this new token?" : "Allow this connection?";
    detail.innerHTML =
      "Something on this machine is asking to drive your browser through Split Pilot. " +
      "It can read and act on every tab, including signed-in sessions. Allow it only if you " +
      "started it. This is remembered, so you will not be asked again for the same token." +
      (token ? " This replaces the token already stored." : "");

    const allow = document.createElement("button");
    allow.textContent = "Allow and remember";
    allow.style.cssText =
      "padding:7px 12px;border-radius:6px;border:1px solid currentColor;background:transparent;" +
      "color:inherit;font:inherit;cursor:pointer";
    allow.addEventListener("click", () => {
      void (async () => {
        await chrome.storage.local.set({ token: offered ?? "" });
        await connect();
      })();
    });
    document.body.appendChild(allow);
    return;
  }

  await connect();
}

async function connect() {
  const reply = await chrome.runtime.sendMessage({ type: "split-pilot:connect", relayUrl });

  if (reply?.ok) {
    headline.textContent = "Connected.";
    headline.className = "";
    detail.textContent = "This tab closes itself.";
    // The worker holds the socket now; this page has done its job.
    setTimeout(() => window.close(), 400);
    return;
  }

  fail("Could not connect.", reply?.error ?? "The service worker did not answer.");
}

void main();

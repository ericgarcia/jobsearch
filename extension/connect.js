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

  if (!token) {
    return fail(
      "This extension has no token yet.",
      "Open its popup once to generate one, then put it in your <code>.env</code>.",
    );
  }

  if (offered !== token) {
    return fail(
      "That token does not match.",
      "Set <code>PLAYWRIGHT_MCP_EXTENSION_TOKEN</code> in your <code>.env</code> to the token in this extension's popup, then restart the app. " +
        "Nothing was connected.",
    );
  }

  const reply = await chrome.runtime.sendMessage({ type: "split-pilot:connect", relayUrl });

  if (reply?.ok) {
    headline.textContent = "Connected.";
    detail.textContent = "This tab closes itself.";
    // The worker holds the socket now; this page has done its job.
    setTimeout(() => window.close(), 400);
    return;
  }

  fail("Could not connect.", reply?.error ?? "The service worker did not answer.");
}

void main();

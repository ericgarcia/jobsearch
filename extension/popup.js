/* The popup cannot import the service worker, so it asks it for everything. */

const $ = (id) => document.getElementById(id);
const ask = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

async function render() {
  const state = await ask("split-pilot:state");
  const paired = state?.pair != null;
  const isLeft = paired && state.pair.left === state.tabId;
  const isRight = paired && state.pair.right === state.tabId;

  $("state").textContent = !paired
    ? "No pair in this window."
    : isLeft
      ? "This tab drives. Its links open on the right."
      : isRight
        ? "This tab is the stage. Links from the left land here."
        : "This window has a pair, but it is not this tab.";

  $("pair").textContent = paired ? "Re-split from this tab" : "Split this tab";
  $("unpair").hidden = !paired;

  $("note").textContent = state?.canSplit
    ? ""
    : "Chrome 155 or newer is needed for a visible split. Links are still routed; the two tabs are just ordinary neighbours.";
  $("note").className = state?.canSplit ? "" : "warn";
}

$("pair").addEventListener("click", async () => {
  await ask("split-pilot:pair");
  await render();
});

$("unpair").addEventListener("click", async () => {
  await ask("split-pilot:unpair");
  await render();
});

async function renderToken() {
  const reply = await ask("split-pilot:token");
  const tokenBox = $("token");
  tokenBox.value = reply?.token ?? "";
  tokenBox.placeholder = "none yet — approve a connection, or start the app";
  $("relay").textContent = reply?.connected
    ? "Playwright is connected through this extension."
    : "Playwright is not connected.";
}

$("token").addEventListener("focus", (event) => event.target.select());

void render();
void renderToken();

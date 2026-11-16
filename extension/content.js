/*
  Catch anything in this tab that would open a new tab, and hand it to the
  worker instead.

  This runs in the isolated world, so it can talk to the extension but cannot
  see the page's own JavaScript. Clicks are caught here; window.open is caught
  by page.js in the main world, which forwards through postMessage because it
  has no access to chrome.runtime.

  The role is learned up front and then pushed by the worker whenever the
  pairing changes, so the click handler already knows the answer when it runs.
  Asking at click time would mean preventing the default first and apologising
  afterwards if the answer came back "not the left tab", which drops links on
  every page in the browser whenever the worker is slow to wake.
*/

let role = null;
/*
  Whether the two tabs are a visible split rather than plain neighbours. It
  rides along with the role because the app uses it: the left pane gives the
  whole window to the assistant while a site is open beside it.
*/
let split = false;

/*
  The main world cannot ask the worker anything, so page.js is told. It is told
  only when the answer changes: this script runs in every frame of every tab in
  the browser, and a timer in each of them to repeat an answer that changes
  perhaps twice a day is a poor way to spend a machine.
*/
function setRole(next, nextSplit = false) {
  if (next === role && nextSplit === split) return;
  role = next;
  split = nextSplit;
  window.postMessage({ type: "split-pilot:role", role, split }, "*");
}

async function askRole() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "split-pilot:role" });
    setRole(reply?.role ?? null, reply?.split === true);
  } catch {
    setRole(null); // The worker is asleep, or the extension was reloaded.
  }
}

void askRole();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "split-pilot:you-are") setRole(message.role, message.split === true);
});

function send(url) {
  chrome.runtime.sendMessage({ type: "split-pilot:open", url }).catch(() => {});
}

/** A URL worth sending. Anything the right tab cannot display is left alone. */
function routable(url) {
  if (!url) return false;
  try {
    const { protocol } = new URL(url, location.href);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

document.addEventListener(
  "click",
  (event) => {
    if (role !== "left") return;
    if (event.defaultPrevented || event.button !== 0) return;

    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor) return;

    // Only what would otherwise leave this tab: an explicit new-tab target, or
    // the modifier the person uses to ask for one. An ordinary link navigating
    // this tab is the page's own business.
    if (anchor.target !== "_blank" && !event.metaKey && !event.ctrlKey) return;
    if (!routable(anchor.href)) return;

    event.preventDefault();
    event.stopPropagation();
    send(anchor.href);
  },
  true,
);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  // page.js came up; tell it where things stand, whether or not that changed.
  if (event.data?.type === "split-pilot:ready") {
    window.postMessage({ type: "split-pilot:role", role, split }, "*");
    return;
  }

  /* window.open, forwarded from the main world by page.js. */
  if (event.data?.type !== "split-pilot:page-open") return;
  if (role !== "left" || !routable(event.data.url)) return;
  send(event.data.url);
});

# Split Pilot

Pair two Chrome tabs in a split view. Every link in the left tab opens in the
right one, which navigates in place and never moves.

Nothing here knows about any particular app. A pair is two tab ids. It is kept
in this repository because the jobsearch app is what it was built for, but it
has no dependency on it and can be lifted out as it stands.

## The problem it solves

An agent driving a browser needs the page to hold still. It does not. A link
opens a new tab, the new tab takes focus, the next instruction lands somewhere
unexpected, and the side-by-side arrangement the person set up is gone. Telling
the agent to be careful is not a fix, because the browser is what is moving.

Split Pilot fixes it at the browser. The right tab is the only stage. Links
never create tabs; they navigate the stage. So the stage keeps its identity and
its position — the tab immediately right of the driver — and an agent that
addresses tabs by index finds the same one every time.

## Requirements

Chrome 155 or newer, for `tabs.createSplit`. Native split view itself arrived
in Chrome 145, and the extension API to control it in 155.

On older Chrome the pairing still works and links are still routed. The two
tabs are ordinary neighbours instead of a visible split, and the popup says so.

## Install

It is not in the Chrome Web Store. Load it unpacked:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**, top right.
3. Choose **Load unpacked** and select this `extension` folder.

Chrome cannot automate its own settings pages, so these three steps are
yours — no extension, this one included, can do them for you.

## Use

1. Go to the tab you want to drive from.
2. Click the Split Pilot toolbar button, then **Split this tab**.

A second tab opens to the right, split with the first. From then on every link
in the left tab opens on the right.

**Unpair** takes the split apart and leaves both tabs open.

## What it catches

| How a page opens a tab | Caught |
| --- | --- |
| `<a target="_blank">` | yes, in the page |
| Cmd-click or Ctrl-click on any link | yes, in the page |
| `window.open(...)` | yes, in the page's own world |
| Anything else that still reaches the browser | yes, after the fact |

The last row is the safety net. A `target="_blank"` form, or a navigation the
browser starts by itself, arrives as a real new tab. If its opener was the left
tab, its URL is moved to the right tab and the stray tab is closed.

Only `http:` and `https:` are routed. A `mailto:`, a download or an extension
page is left to the browser.

## How it is put together

| File | World | Does |
| --- | --- | --- |
| `background.js` | service worker | Owns the pairs, creates and dissolves splits, moves URLs to the right tab |
| `content.js` | isolated | Catches clicks; relays `window.open` from the main world |
| `page.js` | main | Overrides `window.open`, which a content script cannot see |
| `popup.js` | popup | Asks the worker for state; pairs and unpairs |

Each tab's content script is **told** its role when a pair forms or dissolves,
rather than asking when a click happens. Asking at click time would mean
cancelling the click first and making up for it if the answer came back "not
the left tab" — which would drop links on every page in the browser whenever
the worker was slow to wake.

A pair lives in `chrome.storage.session`, not in a variable, because the
service worker is stopped and restarted at Chrome's discretion.

## Permissions, and why

| Permission | Why |
| --- | --- |
| `tabs` | Create the split, navigate the right tab, notice tabs closing |
| `storage` | Remember the pair across service-worker restarts |
| `<all_urls>` | Catch links on any site — the point of a general-purpose tool |

`<all_urls>` is broad. The content scripts read nothing and send nothing but a
URL you clicked, and only while the tab is the left of a pair you made. To
limit it, narrow `content_scripts.matches` in `manifest.json` to the sites you
actually drive from.

## Driving both sides with Playwright

Both halves of a split are ordinary tabs, so the Playwright MCP extension
bridge drives either one. Tabs are addressed by index:

```
browser_tabs { action: "list" }            # left is N, right is N+1
browser_tabs { action: "select", index: N } # then drive the left
browser_snapshot
```

Indices are positional and shift when other tabs open or close. The split keeps
the pair adjacent, so the right tab stays directly after the left, but neither
index is stable against the rest of the window.

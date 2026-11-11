/*
  The CDP relay: what makes this extension a Playwright target.

  Adapted from the Playwright Extension's background service worker,
  Copyright (c) Microsoft Corporation, licensed under the Apache License 2.0.
  See NOTICE. The protocol is theirs; this is a reimplementation of it against
  a pinned @playwright/mcp, kept here so the browser needs one extension
  rather than two.

  The protocol is smaller than its reputation. Playwright sends
  {id, method, params} where method is a dotted path into the chrome API, and
  gets back {id, result} or {id, error}. Five methods are permitted and no
  others, so this is not general remote control of the browser: it is
  debugger attach/detach/sendCommand, plus tab create/remove.

  Traffic the other way is events, {method, params}, forwarded only for tabs
  that are currently attached. A tab is offered to Playwright by sending it a
  chrome.tabs.onCreated for that tab; Playwright answers by attaching to it.
*/

const ALLOWED = new Set([
  "chrome.debugger.attach",
  "chrome.debugger.detach",
  "chrome.debugger.sendCommand",
  "chrome.tabs.create",
  "chrome.tabs.remove",
]);

const EVENTS = [
  "chrome.debugger.onEvent",
  "chrome.debugger.onDetach",
  "chrome.tabs.onCreated",
  "chrome.tabs.onRemoved",
];

/*
  chrome.debugger drops its attachment when a tab navigates across certain
  boundaries, reporting target_closed for a tab that is still very much open.
  Re-attaching immediately works; re-attaching forever does not, so a tab that
  detaches twice in quick succession is left alone.
*/
const REATTACH_DELAY_MS = 150;
const REATTACH_VERIFY_MS = 2500;
const REATTACH_COOLDOWN_MS = 3000;

/** Walk a dotted chrome path: "chrome.debugger.attach" -> [chrome.debugger, "attach"]. */
function resolve(fullMethod) {
  const parts = fullMethod.split(".");
  if (parts[0] !== "chrome" || parts.length < 3) throw new Error(`Bad method: ${fullMethod}`);
  let object = chrome;
  for (let i = 1; i < parts.length - 1; i += 1) {
    object = object?.[parts[i]];
    if (object === undefined) throw new Error(`Unknown chrome path in ${fullMethod}`);
  }
  return { object, name: parts[parts.length - 1] };
}

async function invoke(fullMethod, args) {
  const { object, name } = resolve(fullMethod);
  const fn = object[name];
  if (typeof fn !== "function") throw new Error(`Not a function: ${fullMethod}`);
  return fn.apply(object, args);
}

function detachQuietly(tabId) {
  chrome.debugger.detach({ tabId }).catch(() => {
    // Already detached, or the tab is gone. Either way there is nothing to do.
  });
}

export class RelayConnection {
  #ws;
  #attached = new Set();
  #everAttached = false;
  #listeners = [];
  #closed = false;
  #pendingReattach = new Set();
  #recentReattach = new Set();

  /** Called when the connection ends, for whatever reason. */
  onclose;

  constructor(ws) {
    this.#ws = ws;
    this.#forwardEvents();
    ws.onmessage = (event) => void this.#onMessage(event).catch(() => {});
    ws.onclose = () => this.#onClose();
  }

  get attached() {
    return this.#attached;
  }

  /** Tell Playwright we are here. It will not send anything before this. */
  announce() {
    this.#send({ method: "extension.initialized", params: [] });
  }

  /**
   * Offer a tab to Playwright. There is no "attach this" message: a tab is
   * offered as though it had just been created, and Playwright attaches to it
   * if it wants it.
   */
  offer(tab) {
    if (this.#closed || this.#attached.has(tab.id)) return;
    this.#send({ method: "chrome.tabs.onCreated", params: [tab] });
  }

  close(reason) {
    try {
      this.#ws.close(1000, reason);
    } catch {
      // Already closing.
    }
    this.#onClose();
  }

  #send(message) {
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
  }

  #forwardEvents() {
    for (const fullMethod of EVENTS) {
      const { object, name } = resolve(fullMethod);
      const listener = (...args) => this.#onChromeEvent(fullMethod, args);
      object[name].addListener(listener);
      this.#listeners.push(() => object[name].removeListener(listener));
    }
  }

  #tabIdFor(fullMethod, args) {
    switch (fullMethod) {
      case "chrome.debugger.onEvent":
      case "chrome.debugger.onDetach":
        return args[0]?.tabId;
      // A tab opened BY an attached tab: Playwright wants to follow the popup.
      case "chrome.tabs.onCreated":
        return args[0]?.openerTabId;
      case "chrome.tabs.onRemoved":
        return args[0];
      default:
        return undefined;
    }
  }

  #onChromeEvent(fullMethod, args) {
    const tabId = this.#tabIdFor(fullMethod, args);
    if (tabId === undefined || !this.#attached.has(tabId)) return;

    this.#send({ method: fullMethod, params: args });

    if (fullMethod === "chrome.debugger.onDetach") {
      this.#attached.delete(tabId);
      if (args[1] === "target_closed" && this.#scheduleReattach(tabId)) return;
      this.#closeIfNothingLeft();
    }
  }

  #scheduleReattach(tabId) {
    if (this.#closed || this.#recentReattach.has(tabId)) return false;

    this.#recentReattach.add(tabId);
    setTimeout(() => this.#recentReattach.delete(tabId), REATTACH_COOLDOWN_MS);
    this.#pendingReattach.add(tabId);
    setTimeout(() => void this.#reattach(tabId), REATTACH_DELAY_MS);
    return true;
  }

  async #reattach(tabId) {
    const aborted = () => this.#closed || !this.#pendingReattach.has(tabId);
    if (aborted()) return;

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      this.#pendingReattach.delete(tabId);
      this.#closeIfNothingLeft();
      return;
    }
    if (aborted()) return;
    if (this.#attached.has(tabId)) {
      this.#pendingReattach.delete(tabId);
      return;
    }

    this.offer(tab);
    setTimeout(() => {
      if (aborted()) return;
      this.#pendingReattach.delete(tabId);
      if (!this.#attached.has(tabId)) this.#closeIfNothingLeft();
    }, REATTACH_VERIFY_MS);
  }

  /*
    Once a session has had a tab and has none left, it is over. Without this
    the socket stays open against a browser Playwright can no longer reach,
    and the next command fails somewhere less obvious.
  */
  #closeIfNothingLeft() {
    if (this.#everAttached && this.#attached.size === 0 && this.#pendingReattach.size === 0) {
      this.close("All controlled tabs detached");
    }
  }

  async #onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      this.#send({ error: { code: -32700, message: `Bad JSON: ${error.message}` } });
      return;
    }

    const response = { id: message.id };
    try {
      if (!ALLOWED.has(message.method)) throw new Error(`Unknown method: ${message.method}`);
      const args = message.params ?? [];
      const result = await invoke(message.method, args);

      if (message.method === "chrome.debugger.attach") {
        const tabId = args[0]?.tabId;
        if (tabId !== undefined) {
          // Racing a close: detach again rather than leak the attachment.
          if (this.#closed) detachQuietly(tabId);
          else {
            this.#attached.add(tabId);
            this.#everAttached = true;
            this.#pendingReattach.delete(tabId);
          }
        }
      }
      response.result = result ?? {};
    } catch (error) {
      response.error = error.message;
    }
    this.#send(response);
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingReattach.clear();
    this.#recentReattach.clear();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
    for (const tabId of [...this.#attached]) {
      detachQuietly(tabId);
      this.#attached.delete(tabId);
    }
    this.onclose?.();
  }
}

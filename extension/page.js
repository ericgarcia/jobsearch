/*
  window.open, caught in the page's own world.

  A content script cannot see this: it runs isolated, with its own window. So
  this small script runs in the main world, where the page's scripts live, and
  forwards to the isolated world by postMessage, which is the only channel
  between them. It knows nothing about the extension and holds no permissions.

  It suppresses the call only while this tab is the left of a pair. Everywhere
  else window.open behaves exactly as the page wrote it.
*/

(() => {
  let role = null;

  window.addEventListener("message", (event) => {
    if (event.source === window && event.data?.type === "split-pilot:role") {
      role = event.data.role;
    }
  });

  const open = window.open.bind(window);

  window.open = function (url, target, features) {
    if (role !== "left" || !url) return open(url, target, features);

    let absolute;
    try {
      absolute = new URL(url, location.href).href;
    } catch {
      return open(url, target, features);
    }

    window.postMessage({ type: "split-pilot:page-open", url: absolute }, "*");

    /*
      The caller gets null, which is what it would get if a popup blocker had
      stopped it. Pages handle that case; they do not handle a window object
      that refers to a tab they cannot reach.
    */
    return null;
  };
})();

/*
  Can a public profile be fully custom HTML and JavaScript, stored in the
  user's database, served without weirdness, and still carry good OpenGraph?

  This runs the two designs side by side so the difference can be measured
  rather than argued about.

  Two hosts, because an origin is scheme + host + port and cookies ignore the
  port. Using two ports on one host would have made the isolation look better
  than it is.

    http://app.localhost:7101          the app. Holds the session cookie.
      /naive/<slug>                    user HTML served straight from here
      /safe/<slug>                     a shell with OpenGraph + an iframe
    http://usercontent.localhost:7102  the sandbox. Holds nothing.
      /doc/<slug>                      the user's document, verbatim

  Start it, then run probe.mjs.
*/
import http from "node:http";
import { createClient } from "@libsql/client";

const APP = 7101;
const SANDBOX = 7102;
const APP_ORIGIN = `http://app.localhost:${APP}`;
const SANDBOX_ORIGIN = `http://usercontent.localhost:${SANDBOX}`;

/* ------------------------------------------------- the user's stored page */

const db = createClient({ url: ":memory:" });
await db.execute(`CREATE TABLE profiles (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  document TEXT NOT NULL
)`);

/*
  Deliberately hostile, and deliberately the kind of thing a profile page
  would plausibly contain anyway: an animation, a bit of state, a fetch. The
  last three lines are what a malicious or compromised page would try.
*/
const DOCUMENT = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Ada Lovelace</title>
<style>
  body { font: 16px/1.6 system-ui; margin: 0; padding: 2rem; background: #0b0d10; color: #e6e9ef; }
  h1 { margin: 0 0 .25rem; font-size: 2rem; }
  .pulse { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
           background: #4ade80; animation: p 1.4s ease-in-out infinite; }
  @keyframes p { 0%,100% { opacity: .3 } 50% { opacity: 1 } }
  #out { margin-top: 2rem; font-family: ui-monospace, monospace; font-size: 13px; white-space: pre-wrap; }
</style></head>
<body>
  <h1>Ada Lovelace <span class="pulse"></span></h1>
  <p>Mathematician. Wrote the first algorithm intended for a machine.</p>
  <button id="go">Count</button> <span id="n">0</span>
  <div id="out"></div>
<script>
  // Ordinary interactivity, the reason to want custom JS at all.
  let n = 0;
  document.getElementById("go").onclick = () => {
    document.getElementById("n").textContent = String(++n);
  };

  // What a hostile page would attempt. Each result is reported, not hidden.
  const attempts = {};
  try { attempts.cookie = document.cookie || "(empty)"; } catch (e) { attempts.cookie = "BLOCKED: " + e.name; }
  try { attempts.localStorage = JSON.stringify(localStorage.getItem("session")); } catch (e) { attempts.localStorage = "BLOCKED: " + e.name; }
  try { attempts.parentOrigin = window.parent.location.origin; } catch (e) { attempts.parentOrigin = "BLOCKED: " + e.name; }
  try {
    // Reading top.location is the same permission as writing it.
    attempts.topLocation = window.top.location.href;
    attempts.topNavigation = "ALLOWED";
  } catch (e) { attempts.topNavigation = "BLOCKED: " + e.name; }
  try { attempts.origin = window.origin; } catch (e) { attempts.origin = "BLOCKED"; }

  document.getElementById("out").textContent = JSON.stringify(attempts, null, 2);

  /*
    Report before attempting to navigate away. The first run of this spike
    lost its own results: the top-navigation attempt succeeded on the naive
    page and took the tab to example.com before anything could be read back.
    A page that can do that can also replace your site with a copy of it.
  */
  /*
    Label by how the document is being shown, not by which host served it.
    The first version keyed on the port and so filed a direct visit to the
    sandbox under "safe", which made an unsandboxed page look sandboxed.
  */
  const framed = window.top !== window.self;
  const where = location.port === "7102" ? "sandbox" : "app";
  const via = where + (framed ? "-framed" : "-toplevel");

  fetch("http://app.localhost:7101/report?via=" + encodeURIComponent(via), {
    method: "POST",
    mode: "no-cors",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(attempts),
  }).catch(() => {});

  window.__attempts = attempts;

  // Last, because it ends the page.
  setTimeout(() => {
    try { window.top.location = "https://example.com/"; } catch (e) { /* blocked */ }
  }, 300);
</script>
</body>
</html>`;

await db.execute({
  sql: `INSERT INTO profiles (slug, name, headline, summary, document) VALUES (?, ?, ?, ?, ?)`,
  args: [
    "ada",
    "Ada Lovelace",
    "Mathematician · London",
    "Wrote the first algorithm intended to be carried out by a machine.",
    DOCUMENT,
  ],
});

const reports = {};

const load = async (slug) =>
  (await db.execute({ sql: `SELECT * FROM profiles WHERE slug = ?`, args: [slug] })).rows[0];

/* ----------------------------------------------------------- the two pages */

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/*
  The shell. Server-rendered, so a crawler that runs no JavaScript still sees
  the title, the description and the image. The user's document cannot touch
  any of it: this markup is ours, built from stored fields rather than from
  their HTML, so a page cannot claim to be someone else in a link preview.
*/
function shell(row) {
  const url = `${APP_ORIGIN}/safe/${row.slug}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(row.name)} — ${escape(row.headline)}</title>
<link rel="canonical" href="${url}">
<meta name="description" content="${escape(row.summary)}">
<meta property="og:type" content="profile">
<meta property="og:title" content="${escape(row.name)}">
<meta property="og:description" content="${escape(row.summary)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${APP_ORIGIN}/og/${row.slug}.png">
<meta name="twitter:card" content="summary_large_image">
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
</head>
<body>
<iframe
  src="${SANDBOX_ORIGIN}/doc/${row.slug}"
  sandbox="allow-scripts allow-popups allow-forms"
  referrerpolicy="no-referrer"
  title="${escape(row.name)}"></iframe>
</body>
</html>`;
}

/* -------------------------------------------------------------- the servers */

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, APP_ORIGIN);

    // Stand in for a signed-in visitor, so "can the page steal it?" is a real
    // question rather than a hypothetical one.
    response.setHeader("set-cookie", "session=supersecret-visitor-token; Path=/; SameSite=Lax");

    if (url.pathname === "/report") {
      let body = "";
      for await (const chunk of request) body += chunk;
      reports[url.searchParams.get("via") ?? "?"] = JSON.parse(body || "{}");
      response.writeHead(204, { "access-control-allow-origin": "*" });
      return response.end();
    }
    if (url.pathname === "/reset") {
      for (const key of Object.keys(reports)) delete reports[key];
      response.writeHead(204, { "access-control-allow-origin": "*" });
      return response.end();
    }
    if (url.pathname === "/reports") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify(reports, null, 2));
    }

    const naive = url.pathname.match(/^\/naive\/(.+)$/);
    const safe = url.pathname.match(/^\/safe\/(.+)$/);

    if (naive) {
      const row = await load(naive[1]);
      if (!row) return response.writeHead(404).end("no such profile");
      // The design under test: the user's document, on the app's own origin.
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(row.document);
    }

    if (safe) {
      const row = await load(safe[1]);
      if (!row) return response.writeHead(404).end("no such profile");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        // The shell has no scripts of its own and frames exactly one origin.
        "content-security-policy":
          `default-src 'none'; style-src 'unsafe-inline'; img-src ${APP_ORIGIN}; frame-src ${SANDBOX_ORIGIN}`,
      });
      return response.end(shell(row));
    }

    response.writeHead(404).end("try /safe/ada or /naive/ada");
  })
  .listen(APP, "127.0.0.1", () => console.log(`app      ${APP_ORIGIN}`));

http
  .createServer(async (request, response) => {
    const match = new URL(request.url, SANDBOX_ORIGIN).pathname.match(/^\/doc\/(.+)$/);
    if (!match) return response.writeHead(404).end("no");
    const row = await load(match[1]);
    if (!row) return response.writeHead(404).end("no such profile");

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // Only the app may frame this, so the sandbox cannot be used as a
      // standalone page for phishing with your domain's reputation.
      "content-security-policy": `frame-ancestors ${APP_ORIGIN}`,
      "x-content-type-options": "nosniff",
    });
    response.end(row.document);
  })
  .listen(SANDBOX, "127.0.0.1", () => console.log(`sandbox  ${SANDBOX_ORIGIN}`));

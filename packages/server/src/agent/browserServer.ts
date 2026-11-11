import { spawn, type ChildProcess } from "node:child_process";

/**
 * One long-lived Playwright MCP server, shared by every chat turn.
 *
 * The Agent SDK starts a stdio MCP server per query, and each Playwright
 * connection opens its own tab. That gives a fresh tab on every message, which
 * breaks a Chrome split view: the pane you paired goes stale after one turn.
 *
 * Running Playwright once over HTTP instead keeps a single browser session, so
 * the same tab is driven for the life of the app.
 */

const PORT = Number(process.env.JOBSEARCH_BROWSER_PORT ?? 8931);

// Playwright MCP binds IPv6 loopback, so 127.0.0.1 does not reach it.
export const BROWSER_MCP_URL = `http://localhost:${PORT}/mcp`;

let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;

function args(): string[] {
  const list = [
    "-y",
    "@playwright/mcp@latest",
    "--extension",
    "--port",
    String(PORT),
    // Every MCP client session otherwise gets its own browser context, and so
    // its own tab. Sharing the context is what keeps one tab across turns.
    "--shared-browser-context",
  ];
  if (process.env.JOBSEARCH_BROWSER_TAB_GROUP !== "1") list.push("--no-tab-group");
  if (process.env.JOBSEARCH_BROWSER_BACKGROUND === "1") list.push("--background");
  if (process.env.JOBSEARCH_BROWSER_PROFILE) {
    list.push("--profile-dir-name", process.env.JOBSEARCH_BROWSER_PROFILE);
  }
  return list;
}

/** Is something already serving on the port? Then reuse it. */
async function alreadyRunning(): Promise<boolean> {
  try {
    const response = await fetch(BROWSER_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
      }),
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Start the server if it is not up yet. Safe to call on every turn. */
export function ensureBrowserServer(log: (message: string) => void): Promise<void> {
  if (starting) return starting;

  starting = (async () => {
    if (await alreadyRunning()) {
      log(`Reusing the Playwright MCP server already on port ${PORT}.`);
      return;
    }

    child = spawn("npx", args(), { stdio: ["ignore", "pipe", "pipe"] });
    child.on("exit", (code) => {
      log(`Playwright MCP server exited (${code}).`);
      child = null;
      starting = null;
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Playwright MCP did not start in 60s")), 60_000);
      const onData = (chunk: Buffer) => {
        if (chunk.toString().includes("Listening on")) {
          clearTimeout(timer);
          resolve();
        }
      };
      child?.stdout?.on("data", onData);
      child?.stderr?.on("data", onData);
      child?.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    log(`Playwright MCP server listening on ${BROWSER_MCP_URL}.`);
  })();

  starting = starting.catch((error) => {
    starting = null;
    throw error;
  });

  return starting;
}

export function stopBrowserServer(): void {
  child?.kill();
  child = null;
  starting = null;
}

for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, stopBrowserServer);
}

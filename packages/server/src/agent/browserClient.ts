import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { BROWSER_MCP_URL, ensureBrowserServer } from "./browserServer.js";

/**
 * One MCP connection to Playwright, held for the life of the app.
 *
 * The Agent SDK opens a fresh MCP connection for every query. Pointed straight
 * at Playwright, that means a new extension connection — and so a new tab — on
 * every chat turn, which breaks a Chrome split view: the pane the person paired
 * is no longer the pane being driven.
 *
 * So the app connects once, here, and republishes the browser tools as its own.
 * The agent talks to this process; this process talks to Playwright over a
 * connection that outlives any single turn. One connection, one tab, paired once.
 */

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

async function connect(log: (message: string) => void): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    await ensureBrowserServer(log);
    const next = new Client({ name: "jobsearch", version: "0.1.0" });
    await next.connect(new StreamableHTTPClientTransport(new URL(BROWSER_MCP_URL)));
    next.onclose = () => {
      log("Browser connection closed; it will be reopened on the next request.");
      client = null;
      connecting = null;
    };
    client = next;
    log("Connected to the browser. This connection is reused for every turn.");
    return next;
  })();

  connecting = connecting.catch((error) => {
    connecting = null;
    throw error;
  });
  return connecting;
}

/** Open the connection at startup so the first turn is not the one that waits. */
export async function warmBrowser(log: (message: string) => void): Promise<void> {
  await connect(log);
}

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };

/**
 * Forward one call to Playwright. The first navigation after the extension
 * attaches can fail while the page is still being handed over, so retry once.
 */
async function forward(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const log = (message: string) => console.log(`[browser] ${message}`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const connection = await connect(log);
    try {
      return (await connection.callTool({ name, arguments: args }, undefined, {
        timeout: 120_000,
      })) as ToolResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recoverable = /closed|disconnect|not connected|Target page/i.test(message);
      if (attempt === 0 && recoverable) {
        log(`${name} failed (${message}); reconnecting and trying once more.`);
        client = null;
        connecting = null;
        continue;
      }
      return {
        content: [{ type: "text", text: `Browser call ${name} failed: ${message}` }],
        isError: true,
      };
    }
  }
  return { content: [{ type: "text", text: "Browser unreachable." }], isError: true };
}

const pass = (name: string) => async (args: Record<string, unknown>) => {
  const result = await forward(name, args);
  return {
    content: (result.content ?? []).map((block) => ({
      type: "text" as const,
      text: block.text ?? "",
    })),
    ...(result.isError ? { isError: true } : {}),
  };
};

/* ----------------------------------------------------------------- the tools */

const ELEMENT = z
  .string()
  .describe("Human-readable description of the element, for the permission prompt");
const TARGET = z
  .string()
  .describe("Exact element reference from the latest browser_snapshot, or a CSS selector");

export const browserTools = [
  tool(
    "browser_navigate",
    "Point the browser at a URL. This drives the tab the person has in view, so say what you are opening before you open it.",
    { url: z.string().describe("The URL to open") },
    pass("browser_navigate"),
  ),
  tool(
    "browser_snapshot",
    "Read the current page as an accessibility tree. Each element carries a reference you pass to browser_click or browser_type. Prefer this over a screenshot.",
    {},
    pass("browser_snapshot"),
    { annotations: { readOnlyHint: true } },
  ),
  tool(
    "browser_click",
    "Click an element. Only click something the person has asked you to click: this is their own signed-in browser.",
    { element: ELEMENT, target: TARGET },
    pass("browser_click"),
    { annotations: { destructiveHint: true } },
  ),
  tool(
    "browser_type",
    "Type text into an element. Never type a password, a card number or any other credential.",
    {
      element: ELEMENT,
      target: TARGET,
      text: z.string().describe("The text to type"),
      submit: z.boolean().optional().describe("Press Enter afterwards"),
    },
    pass("browser_type"),
    { annotations: { destructiveHint: true } },
  ),
  tool(
    "browser_press_key",
    "Press a single key, for example ArrowDown or Enter.",
    { key: z.string() },
    pass("browser_press_key"),
  ),
  tool(
    "browser_tabs",
    "List the browser tabs, or select one. Avoid opening or closing tabs: the person has one tab paired beside this app.",
    {
      action: z.enum(["list", "select"]).describe("list, or select an existing tab"),
      index: z.number().int().optional().describe("Tab index, for select"),
    },
    pass("browser_tabs"),
    { annotations: { readOnlyHint: true } },
  ),
  tool(
    "browser_wait_for",
    "Wait for text to appear or disappear, or for a number of seconds.",
    {
      text: z.string().optional(),
      textGone: z.string().optional(),
      time: z.number().optional().describe("Seconds, at most 30"),
    },
    pass("browser_wait_for"),
    { annotations: { readOnlyHint: true } },
  ),
  tool(
    "browser_console_messages",
    "Read the page's console messages.",
    { level: z.enum(["error", "warning", "info", "debug"]).optional() },
    pass("browser_console_messages"),
    { annotations: { readOnlyHint: true } },
  ),
];

import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR, MODEL } from "../config.js";
import { jobsearchServer, MUTATING_TOOLS } from "./tools.js";
import { credentialEnv, readCredential, type Credential } from "../settings.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { warmBrowser } from "./browserClient.js";
import { browserEnabled as flag } from "./browserFlag.js";

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "refresh" }
  | { type: "done"; result: string; costUsd: number | null; turns: number | null }
  | { type: "error"; message: string };

export interface RunOptions {
  prompt: string;
  /** Resume an earlier Agent SDK session so the agent keeps its context. */
  resume?: string | null;
  signal?: AbortSignal;
}

/** True when the agent is allowed to drive the browser. */
export const browserEnabled = flag;

/**
 * Playwright MCP, attached to the user's own Chrome through the Playwright MCP
 * Bridge extension. `--extension` makes Playwright drive an existing tab in the
 * running browser instead of launching one, so the agent works in a session the
 * user is already signed in to, and the user can watch it in Chrome split view.
 *
 * Set PLAYWRIGHT_MCP_EXTENSION_TOKEN to the token the extension's status page
 * shows, or Chrome asks for approval on every connection.
 */

/**
 * Run one turn of the agent and yield events as they arrive.
 *
 * The agent gets no built-in tools: `tools: []` removes Read, Bash, Grep and the
 * rest, so the MCP servers are its whole surface. `settingSources: []` keeps the
 * user's own Claude Code settings and CLAUDE.md files out of this app.
 */
export async function* runAgent(options: RunOptions): AsyncGenerator<AgentEvent> {
  const credential = readCredential();
  if (!credential) {
    yield {
      type: "error",
      message: "No Claude credential is set up yet. Open Setup and add one.",
    };
    return;
  }

  if (browserEnabled) {
    try {
      await warmBrowser((message) => console.log(`[browser] ${message}`));
    } catch (error) {
      yield {
        type: "error",
        message: `Could not start the browser server: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
      return;
    }
  }

  try {
    const response = query({
      prompt: options.prompt,
      options: {
        model: MODEL,
        cwd: DATA_DIR,
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { jobsearch: jobsearchServer },
        allowedTools: ["mcp__jobsearch__*"],
        tools: [],
        settingSources: [],
        maxTurns: 30,
        env: credentialEnv(credential),
        ...(options.resume ? { resume: options.resume } : {}),
      },
    });

    if (options.signal) {
      options.signal.addEventListener("abort", () => void response.interrupt?.(), { once: true });
    }

    for await (const message of response) {
      if (message.type === "system" && message.subtype === "init") {
        yield { type: "session", sessionId: message.session_id };
        continue;
      }

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            yield { type: "text", text: block.text };
          } else if (block.type === "tool_use") {
            yield { type: "tool_use", name: block.name, input: block.input };
            if (MUTATING_TOOLS.has(block.name)) yield { type: "refresh" };
          }
        }
        continue;
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          yield {
            type: "done",
            result: message.result,
            costUsd: message.total_cost_usd ?? null,
            turns: message.num_turns ?? null,
          };
        } else {
          yield { type: "error", message: `Agent stopped: ${message.subtype}` };
        }
      }
    }
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Check a credential by running one real, tiny turn with it. Returns the
 * failure message rather than throwing, so the setup screen can show it.
 */
export async function verifyCredential(
  credential: Credential,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    for await (const message of query({
      prompt: "Reply with the single word: ready",
      options: {
        model: MODEL,
        cwd: DATA_DIR,
        systemPrompt: "Answer in one word.",
        tools: [],
        settingSources: [],
        maxTurns: 1,
        env: credentialEnv(credential),
      },
    })) {
      if (message.type === "result") {
        return message.subtype === "success"
          ? { ok: true }
          : { ok: false, error: `Claude refused the request (${message.subtype}).` };
      }
    }
    return { ok: false, error: "Claude returned no result." };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (/not logged in|unauthor|invalid.*(key|token)|401/i.test(raw)) {
      return { ok: false, error: "That credential was rejected. Check you pasted all of it." };
    }
    return { ok: false, error: raw };
  }
}

import { createRequire } from "node:module";
import path from "node:path";
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
 * The Claude Code executable the Agent SDK runs.
 *
 * The SDK ships no binary. It looks for `claude` and fails with "Claude Code
 * executable not found" if the machine has none — so until now this app had an
 * undeclared dependency on a tool the developer happened to have installed,
 * and anyone cloning the repo would have hit that wall.
 *
 * @anthropic-ai/claude-code is a normal dependency instead. It carries one
 * native binary per platform as optional dependencies, so npm installs the one
 * that matches and nothing else: no separate install step, no setup script,
 * and `npx` brings it down with everything else. Pinned exactly, for the same
 * reason @playwright/mcp is — this is a binary that runs on the user's machine.
 *
 * JOBSEARCH_CLAUDE_PATH overrides it, for trying a different build.
 */
function claudeExecutable(): string {
  if (process.env.JOBSEARCH_CLAUDE_PATH) return process.env.JOBSEARCH_CLAUDE_PATH;
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("@anthropic-ai/claude-code/package.json");
  const bin = (require(manifest) as { bin: Record<string, string> }).bin;
  return path.join(path.dirname(manifest), bin.claude ?? "bin/claude.exe");
}

/*
  The browser the agent drives is the user's own Chrome, reached through Split
  Pilot (see extension/). `--extension` makes Playwright take over a tab in the
  running browser instead of launching one, so the agent works in a session the
  user is already signed in to and can watch in the split view.

  This said "the Playwright MCP Bridge extension" until now, which was the
  second extension Split Pilot replaced. The token it told you to set by hand
  is also gone: the app and the server read the same .env, so the app tells the
  extension the token itself.
*/

/**
 * Run one turn of the agent and yield events as they arrive.
 *
 * The agent gets no built-in tools: `tools: []` removes Read, Bash, Grep and the
 * rest, so the MCP servers are its whole surface. `settingSources: []` keeps the
 * user's own Claude Code settings and CLAUDE.md files out of this app.
 */
export async function* runAgent(options: RunOptions): AsyncGenerator<AgentEvent> {
  const credential = await readCredential();
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
        pathToClaudeCodeExecutable: claudeExecutable(),
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

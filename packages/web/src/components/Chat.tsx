import { useEffect, useRef, useState } from "react";
import { chat, type ChatEvent } from "../api.ts";

interface Entry {
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
}

function describeTool(name: string, input: unknown): string {
  const short = name.replace(/^mcp__[a-z]+__/, "");
  const args = input && typeof input === "object" ? JSON.stringify(input) : "";
  return `${short} ${args.length > 90 ? `${args.slice(0, 90)}…` : args}`;
}

export function Chat({ onDataChanged }: { onDataChanged: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const conversationId = useRef<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [entries]);

  async function send() {
    const message = draft.trim();
    if (!message || running) return;

    setDraft("");
    setEntries((prior) => [...prior, { kind: "user", text: message }]);
    setRunning(true);

    const controller = new AbortController();
    abort.current = controller;

    try {
      for await (const event of chat(message, conversationId.current, controller.signal)) {
        apply(event);
      }
    } catch (chatError) {
      if (!controller.signal.aborted) {
        setEntries((prior) => [...prior, { kind: "error", text: (chatError as Error).message }]);
      }
    } finally {
      setRunning(false);
      abort.current = null;
    }
  }

  function apply(event: ChatEvent) {
    switch (event.type) {
      case "conversation":
        conversationId.current = event.conversationId;
        break;
      case "text":
        setEntries((prior) => [...prior, { kind: "assistant", text: event.text }]);
        break;
      case "tool_use":
        setEntries((prior) => [
          ...prior,
          { kind: "tool", text: describeTool(event.name, event.input) },
        ]);
        break;
      case "refresh":
        onDataChanged();
        break;
      case "error":
        setEntries((prior) => [...prior, { kind: "error", text: event.message }]);
        break;
      case "done":
        onDataChanged();
        break;
      default:
        break;
    }
  }

  return (
    <div className="chat" style={{ height: 260 }}>
      <div className="chat-head">
        <span>Assistant</span>
        <div className="spacer" />
        {running && (
          <button className="ghost" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        )}
        {entries.length > 0 && !running && (
          <button
            className="ghost"
            onClick={() => {
              setEntries([]);
              conversationId.current = null;
            }}
          >
            New thread
          </button>
        )}
      </div>

      <div className="chat-log scroll" ref={logRef}>
        {entries.length === 0 && (
          <div style={{ color: "var(--text-faint)", fontSize: 12 }}>
            Ask for jobs. For example: “Sync the boards, then find remote senior backend roles and
            score the five best.”
          </div>
        )}
        {entries.map((entry, index) =>
          entry.kind === "tool" ? (
            <div className="tool-line" key={index}>
              <b>⟩</b> {entry.text}
            </div>
          ) : (
            <div className={`msg ${entry.kind}`} key={index}>
              {entry.text}
            </div>
          ),
        )}
        {running && <div className="tool-line">working…</div>}
      </div>

      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          placeholder="Ask the assistant…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button className="primary" type="submit" disabled={running || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

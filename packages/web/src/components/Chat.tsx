import { useCallback, useEffect, useRef, useState } from "react";
import { api, chat, type ChatEvent, type Thread } from "../api.ts";
import { useChanges } from "../changes.ts";
import { closeThreadTabs, tellThread, threadTabs } from "../split.ts";

interface Entry {
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
}

function describeTool(name: string, input: unknown): string {
  const short = name.replace(/^mcp__[a-z]+__/, "");
  const args = input && typeof input === "object" ? JSON.stringify(input) : "";
  return `${short} ${args.length > 90 ? `${args.slice(0, 90)}…` : args}`;
}

/*
  The open thread lives in the URL.

  It used to live in a ref, which meant a reload started a new conversation
  while the old one sat in the database unreachable — the work was kept and
  the way back to it was not. The URL is the one piece of page state the
  browser already persists across a reload, a restore and a bookmark, so it
  is where this belongs.
*/
function threadFromUrl(): number | null {
  const raw = new URLSearchParams(window.location.search).get("thread");
  const id = raw ? Number(raw) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

function putThreadInUrl(id: number | null): void {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete("thread");
  else url.searchParams.set("thread", String(id));
  window.history.replaceState(null, "", url);
}

function label(thread: Thread): string {
  return thread.title?.trim() || thread.preview?.trim() || "New thread";
}

export function Chat({
  onDataChanged,
  splitId,
}: {
  onDataChanged: () => void;
  /** Split Pilot's id, or null when it is not installed. */
  splitId: string | null;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [threadId, setThreadId] = useState<number | null>(threadFromUrl);
  const [renaming, setRenaming] = useState<number | null>(null);

  const conversationId = useRef<number | null>(threadId);
  const abort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [entries]);

  const loadThreads = useCallback(() => {
    void api.threads().then(setThreads).catch(() => undefined);
  }, []);

  useEffect(loadThreads, [loadThreads]);
  // The agent creates and writes threads too, so the list is not ours alone.
  useChanges("threads", loadThreads);

  /*
    Load the open thread's messages.

    Only what was said is replayed: the tool lines were never stored, and
    inventing them from nothing would show a history that did not happen.
  */
  useEffect(() => {
    if (threadId === null) return;
    let current = true;
    void api
      .threadMessages(threadId)
      .then((messages) => {
        if (!current) return;
        setEntries(messages.map((m) => ({ kind: m.role, text: m.content })));
      })
      .catch(() => {
        if (current) setEntries([{ kind: "error", text: "That thread could not be loaded." }]);
      });
    return () => {
      current = false;
    };
  }, [threadId]);

  /*
    Tell the extension which thread is open, so pages opened from here are
    recorded against it. Said on every change, including the first, because
    the worker may have been asleep and forgotten.
  */
  useEffect(() => {
    void tellThread(splitId, threadId);
  }, [splitId, threadId]);

  function open(id: number | null): void {
    if (id === threadId) {
      setListOpen(false);
      return;
    }
    abort.current?.abort();
    conversationId.current = id;
    setThreadId(id);
    putThreadInUrl(id);
    if (id === null) setEntries([]);
    setListOpen(false);
  }

  /*
    Say so when a thread action fails.

    The first version let the promise reject into nothing. The delete route
    was answering 400, the row stayed where it was, and the page gave no
    sign — which reads as a dead button, not as an error.
  */
  function report(error: unknown): void {
    setEntries((prior) => [...prior, { kind: "error", text: (error as Error).message }]);
  }

  /*
    Closing a thread closes the pages it opened.

    A tab the person has since navigated somewhere else still goes: it was
    opened for this conversation, and following a link onward does not make
    it someone else's. But a tab in view is a page being read, so that one is
    asked about first — taking it away mid-sentence is the kind of help that
    makes a feature untrustworthy.
  */
  async function remove(id: number): Promise<void> {
    const theirs = await threadTabs(splitId, id).catch(() => []);
    const watched = theirs.filter((tab) => tab.active);
    if (watched.length > 0) {
      const names = watched.map((tab) => tab.title || tab.url).join(", ");
      const rest = theirs.length - watched.length;
      const also = rest > 0 ? ` and ${rest} other ${rest === 1 ? "tab" : "tabs"}` : "";
      if (!window.confirm(`Close this thread and the page you are looking at (${names})${also}?`)) {
        return;
      }
    }

    try {
      await api.deleteThread(id);
    } catch (error) {
      report(error);
      return;
    }

    // After the thread is gone, so a refusal above leaves the tabs alone.
    await closeThreadTabs(splitId, id).catch(() => 0);
    // Deleting what you are reading has to leave you somewhere, and a blank
    // thread is the one place that is certainly still there.
    if (id === threadId) open(null);
    loadThreads();
  }

  async function rename(id: number, title: string): Promise<void> {
    setRenaming(null);
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await api.renameThread(id, trimmed);
    } catch (error) {
      report(error);
      return;
    }
    loadThreads();
  }

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
        // A thread the server just made for this first message. Record it
        // before anything else can reload the page out from under it.
        conversationId.current = event.conversationId;
        setThreadId(event.conversationId);
        putThreadInUrl(event.conversationId);
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

  const here = threads.find((thread) => thread.id === threadId);

  return (
    <div className="chat">
      <div className="chat-head">
        <button className="ghost" onClick={() => setListOpen((was) => !was)}>
          {listOpen ? "▾" : "▸"} Threads ({threads.length})
        </button>
        <span className="thread-here">{here ? label(here) : "New thread"}</span>
        <div className="spacer" />
        {running && (
          <button className="ghost" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        )}
        {(entries.length > 0 || threadId !== null) && !running && (
          <button className="ghost" onClick={() => open(null)}>
            New thread
          </button>
        )}
      </div>

      {listOpen && (
        <div className="thread-list scroll">
          {threads.length === 0 && <div className="thread-empty">No threads yet.</div>}
          {threads.map((thread) => (
            <div
              className={`thread-row${thread.id === threadId ? " current" : ""}`}
              key={thread.id}
            >
              {renaming === thread.id ? (
                <input
                  autoFocus
                  defaultValue={thread.title ?? ""}
                  placeholder="Name this thread"
                  // Renaming nearly always replaces the name rather than
                  // extending it, so the old one starts selected.
                  onFocus={(event) => event.target.select()}
                  onBlur={(event) => void rename(thread.id, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <>
                  <button
                    className="thread-open"
                    title={label(thread)}
                    onClick={() => open(thread.id)}
                  >
                    <span className="thread-label">{label(thread)}</span>
                    <span className="thread-meta">{thread.messages}</span>
                  </button>
                  <button className="ghost" title="Rename" onClick={() => setRenaming(thread.id)}>
                    ✎
                  </button>
                  <button className="ghost" title="Close" onClick={() => void remove(thread.id)}>
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

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

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, chat, type ChatEvent, type Thread } from "../api.ts";
import { useChanges } from "../changes.ts";
import { closeTab, closeThreadTabs, showInPane, threadTabs, type ThreadTab } from "../split.ts";

interface Entry {
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
}

function describeTool(name: string, input: unknown): string {
  const short = name.replace(/^mcp__[a-z]+__/, "");
  const args = input && typeof input === "object" ? JSON.stringify(input) : "";
  return `${short} ${args.length > 90 ? `${args.slice(0, 90)}…` : args}`;
}

function label(thread: Thread): string {
  return thread.title?.trim() || thread.preview?.trim() || "New thread";
}

/*
  An unsent message, kept as it is typed.

  In the browser rather than with the conversation on the server, for two
  reasons. A message being typed before the first one is sent belongs to no
  conversation yet — there is no row to put it on, and that is exactly when
  the longest messages are lost. And a half-written sentence is this
  machine's scratch, not part of the record: it should not travel to another
  device, and it should not need a request per keystroke.

  Every access is wrapped, because storage throws rather than returns in a
  private window or with site data blocked, and losing a draft must never
  take the message box with it.
*/
function draftKey(threadId: number | null): string {
  return `jobsearch:draft:${threadId ?? "new"}`;
}

function readDraft(threadId: number | null): string {
  try {
    return window.localStorage.getItem(draftKey(threadId)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(threadId: number | null, text: string): void {
  try {
    if (text) window.localStorage.setItem(draftKey(threadId), text);
    else window.localStorage.removeItem(draftKey(threadId));
  } catch {
    // Nothing the person is doing fails. They lose a draft on reload.
  }
}

/*
  The assistant writes markdown, so the assistant's messages are read as
  markdown. Theirs only: what the person typed is shown as they typed it,
  because a message box is not a document and nobody means a list when they
  start a line with a dash.

  react-markdown renders no raw HTML unless asked, and it is not asked. The
  text here can quote a job posting, and a posting is not a thing to hand a
  renderer that executes what it finds.
*/
/*
  A link into the app's own data, written by a tool.

  An imported posting is worth more than a sentence saying it was imported:
  the next thing anybody wants is to look at it. So the import tool hands
  back a markdown link with a jobsearch: target and the agent repeats it,
  which means the card is part of the message — stored with the thread,
  still there after a reload, and impossible for a later render to lose.
  A card held outside the message would be gone the moment the page
  refreshed, which is exactly when you come back to a thread.
*/
const INTERNAL = /^jobsearch:job\/(\d+)$/;

function Prose({ text, onOpenJob }: { text: string; onOpenJob: (id: number) => void }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      /*
        react-markdown drops any URL scheme it does not know, which is the
        right default — it is what stops javascript: in text that came off
        a web page — and it silently emptied the href on our own cards. So
        this scheme is allowed by name and everything else still goes
        through the standard check.
      */
      urlTransform={(url) => (INTERNAL.test(url) ? url : defaultUrlTransform(url))}
      components={{
        a: ({ node: _node, href, children, ...rest }) => {
          const internal = INTERNAL.exec(href ?? "");
          if (internal) {
            return (
              <button className="job-card" onClick={() => onOpenJob(Number(internal[1]))}>
                <span className="job-card-label">{children}</span>
                <span className="job-card-go">Open →</span>
              </button>
            );
          }
          /*
            Everything else keeps its privacy attribute and needs no target:
            the app catches clicks on anything leaving this origin and puts
            it in the pane. Where there is no pane, the fallback opens it.
          */
          return (
            <a {...rest} href={href} rel="noreferrer">
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </Markdown>
  );
}

/** What to call a page. Its own title, else the site it is on. */
function pageName(page: ThreadTab): string {
  const title = page.title.trim();
  if (title) return title;
  try {
    return new URL(page.url).hostname.replace(/^www\./, "");
  } catch {
    return page.url || "Untitled";
  }
}

export function Chat({
  onDataChanged,
  splitId,
  threadId,
  onOpenThread,
  onOpenJob,
}: {
  onDataChanged: () => void;
  /** Split Pilot's id, or null when it is not installed. */
  splitId: string | null;
  /*
    The open thread is the app's, not the chat's.

    It used to live here, which was fine while it only chose which messages
    to show. It now chooses which workspace the whole app is in — which tab,
    what is selected, which page has the pane — so it belongs where those
    live.
  */
  threadId: number | null;
  onOpenThread: (id: number | null) => void;
  /** Show a posting the assistant put a card in the thread for. */
  onOpenJob: (id: number) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState(() => readDraft(threadId));
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [running, setRunning] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [renaming, setRenaming] = useState<number | null>(null);
  /** The pages this thread has open, as the extension sees them. */
  const [pages, setPages] = useState<ThreadTab[]>([]);

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

  /* Each conversation keeps its own unsent message. */
  useEffect(() => {
    setDraft(readDraft(threadId));
  }, [threadId]);

  /*
    The thread's pages: asked for once, then pushed.

    Asked on arrival because the worker has no idea this page just loaded.
    Pushed afterwards — a page gets its title a second after it opens, and a
    strip that polled for that would be wrong for exactly as long as the
    interval, every time.
  */
  useEffect(() => {
    if (threadId === null) {
      setPages([]);
      return;
    }
    let current = true;
    void threadTabs(splitId, threadId).then((found) => {
      if (current) setPages(found);
    });

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as { type?: string; thread?: number; pages?: ThreadTab[] } | null;
      if (data?.type !== "split-pilot:tabs") return;
      // As text: a thread id crosses two worlds and a storage key on the
      // way here, and one of those turns it into a string.
      if (String(data.thread) !== String(threadId)) return;
      setPages(data.pages ?? []);
    };

    window.addEventListener("message", onMessage);
    return () => {
      current = false;
      window.removeEventListener("message", onMessage);
    };
  }, [splitId, threadId]);

  function open(id: number | null): void {
    setListOpen(false);
    if (id === threadId) return;
    abort.current?.abort();
    if (id === null) setEntries([]);
    onOpenThread(id);
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

    /*
      The draft goes with it. Ids are handed out as one past the highest, so
      a deleted conversation's number comes round again — and a new thread
      would open with a stranger's half-written message in the box.
    */
    writeDraft(id, "");

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

  /*
    Handing a document over.

    The browser gives the file's contents and never its location, so this is
    the only way a document reaches the app — the assistant has no filesystem
    and reads what it is given, by id. Dropping and picking are the same path:
    both end here, and both are the person choosing, which is the permission.

    The turn it starts says what was handed over in the person's own voice,
    because that is what it is. The assistant then reads it and says what it
    found before anything is stored.
  */
  async function hand(files: FileList | File[]) {
    const chosen = [...files].slice(0, 4);
    if (chosen.length === 0 || running) return;

    setSending(true);
    try {
      const handed = [];
      for (const file of chosen) handed.push(await api.upload(file));
      await send(
        `I have given you ${handed.length === 1 ? "a file" : `${handed.length} files`}: ` +
          handed.map((one) => `${one.name} (upload_id ${one.id})`).join(", ") +
          ". Read it with import_profile and tell me what you found.",
      );
    } catch (error) {
      setEntries((prior) => [...prior, { kind: "error", text: (error as Error).message }]);
    } finally {
      setSending(false);
    }
  }

  async function send(said?: string) {
    const message = (said ?? draft).trim();
    if (!message || running) return;

    if (said === undefined) {
      setDraft("");
      writeDraft(threadId, "");
    }
    setEntries((prior) => [...prior, { kind: "user", text: message }]);
    setRunning(true);

    const controller = new AbortController();
    abort.current = controller;

    try {
      for await (const event of chat(message, threadId, controller.signal)) {
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
        onOpenThread(event.conversationId);
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

      {pages.length > 0 && (
        /*
          The pages this conversation has open.

          They were invisible before: a page went into the pane and the only
          way back to a previous one was the browser's own tab strip, where
          it sat among everything else with nothing to say which thread it
          belonged to. Here they are the thread's, and switching between
          them is one click — as is giving the window back to the app and
          then taking it again, which closes nothing.
        */
        <div className="pages">
          {pages.map((page) => (
            <div className={`page${page.active ? " showing" : ""}`} key={page.id}>
              <button
                className="page-open"
                title={page.url}
                onClick={() => void showInPane(splitId, page.id)}
              >
                {pageName(page)}
              </button>
              <button
                className="ghost"
                title="Close this page"
                onClick={() => void closeTab(splitId, page.id)}
              >
                ✕
              </button>
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
          ) : entry.kind === "assistant" ? (
            <div className="msg assistant prose" key={index}>
              <Prose text={entry.text} onOpenJob={onOpenJob} />
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
        className={`chat-form${dragging ? " chat-form-drop" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(false);
          void hand(event.dataTransfer.files);
        }}
      >
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.zip,.txt,.md,.csv,.json,.html"
          onChange={(event) => {
            if (event.target.files) void hand(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="chat-clip"
          title="Give the assistant a resume or a LinkedIn export"
          disabled={running || sending}
          onClick={() => picker.current?.click()}
        >
          {sending ? "…" : "+"}
        </button>
        <textarea
          value={draft}
          placeholder={dragging ? "Drop it here" : "Ask the assistant, or drop in a resume…"}
          onChange={(event) => {
            setDraft(event.target.value);
            writeDraft(threadId, event.target.value);
          }}
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

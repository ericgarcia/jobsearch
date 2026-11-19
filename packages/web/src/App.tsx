import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  api,
  type Application,
  type Health,
  type Job,
  type CoverLetter as Letter,
  type ResumeSummary,
  type Setup as SetupInfo,
} from "./api.ts";
import { Setup } from "./components/Setup.tsx";
import { JobList } from "./components/JobList.tsx";
import { JobDetail } from "./components/JobDetail.tsx";
import { Chat } from "./components/Chat.tsx";
import { Profile } from "./components/Profile.tsx";
import { useChanges } from "./changes.ts";
import { LayoutEditor } from "./components/LayoutEditor.tsx";
import { Admin } from "./components/Admin.tsx";
import { Projects } from "./components/Projects.tsx";
import { useReportState } from "./reportState.ts";
import { Boards } from "./components/Boards.tsx";
import {
  adoptStage,
  leaveSplit,
  routeToPane,
  showInPane,
  splitInstalled,
  syncToken,
  tellThread,
  threadTabs,
} from "./split.ts";
import { ResumeView } from "./components/ResumeView.tsx";
import { CoverLetter } from "./components/CoverLetter.tsx";

type Tab = "jobs" | "applications" | "drafts" | "profile" | "projects" | "design" | "boards" | "admin";

/*
  The open thread lives in the URL.

  It used to live in a ref, which meant a reload started a new conversation
  while the old one sat in the database unreachable — the work was kept and
  the way back to it was not. The URL is the one piece of page state the
  browser already persists across a reload, a restore and a bookmark.
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

/**
 * What the app was showing, kept per conversation.
 *
 * Not the filters that describe the person rather than the work — where
 * they want to live is a preference, and it would be strange for it to
 * change because they opened a different conversation.
 */
interface Workspace {
  tab: Tab;
  job: number | null;
  resume: number | null;
  letter: number | null;
  surface: string | null;
  search: string;
  untrackedOnly: boolean;
  /*
    Whether the pane was open when you left.

    Having pages is not the same as showing one. Giving the window back to
    the app is a thing you chose, and a thread that reopened split every
    time undid that choice on the way back in.
  */
  pane: boolean;
}

const TABS: Tab[] = ["jobs", "applications", "drafts", "profile", "projects", "design", "boards", "admin"];

/*
  How wide the assistant's column is, as a share of the window.

  A proportion rather than a number of pixels, for two reasons. Chrome's
  split is always half the window and cannot be told otherwise — createSplit
  takes two tab ids and nothing else, and a dragged divider snaps back to
  half on the next split — so half is what the app matches by default, and
  the two views look like the same app. And a share survives a window being
  resized: a column pinned at 340px is a third of a laptop and a tenth of a
  large monitor, which is not one layout but two.

  Kept in the browser, because it describes this screen rather than the
  person.
*/
const SHARE_KEY = "jobsearch:messaging-share";
const SHARE_DEFAULT = 0.5;
const SHARE_MIN = 0.2;
const SHARE_MAX = 0.75;

/*
  How close to the middle counts as the middle.

  In pixels, not a share: it is a question about the hand holding the
  pointer, and a hand does not get steadier on a larger monitor.
*/
const SNAP_PX = 22;

function sensibleShare(share: number): number {
  return Math.min(SHARE_MAX, Math.max(SHARE_MIN, share));
}

/** What a drag to this x means, as a share of the window. */
function shareAt(x: number): number {
  return sensibleShare(x / Math.max(1, window.innerWidth));
}

function rememberShare(share: number): void {
  try {
    window.localStorage.setItem(SHARE_KEY, share.toFixed(4));
  } catch {
    // The column is the width they dragged it to until the next reload.
  }
}

function storedShare(): number {
  try {
    const kept = Number(window.localStorage.getItem(SHARE_KEY));
    return Number.isFinite(kept) && kept > 0 ? sensibleShare(kept) : SHARE_DEFAULT;
  } catch {
    return SHARE_DEFAULT;
  }
}

/** Where a conversation starts: the job list, nothing open. */
const FRESH: Workspace = {
  tab: "jobs",
  job: null,
  resume: null,
  letter: null,
  surface: null,
  search: "",
  untrackedOnly: false,
  pane: false,
};

/** A stored workspace, or nothing if it is not one. Written by an older app, say. */
function asWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!TABS.includes(raw.tab as Tab)) return null;
  const id = (what: unknown) => (typeof what === "number" ? what : null);
  return {
    tab: raw.tab as Tab,
    job: id(raw.job),
    resume: id(raw.resume),
    letter: id(raw.letter),
    surface: typeof raw.surface === "string" ? raw.surface : null,
    search: typeof raw.search === "string" ? raw.search : "",
    untrackedOnly: raw.untrackedOnly === true,
    // Absent in anything written before the pane was remembered. Those
    // threads behaved as "show the page", so that is what they keep.
    pane: raw.pane !== false,
  };
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [setupInfo, setSetupInfo] = useState<SetupInfo | null>(null);
  const [tab, setTab] = useState<Tab>("jobs");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [openResume, setOpenResume] = useState<number | null>(null);
  const [resumes, setResumes] = useState<ResumeSummary[]>([]);
  const [letters, setLetters] = useState<Letter[]>([]);
  const [openLetter, setOpenLetter] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  // undefined until prefs load, so the first fetch is not sent for everywhere.
  const [place, setPlace] = useState<string | undefined>(undefined);
  const [includeRemote, setIncludeRemote] = useState(false);
  /* null while unknown, false when Split Pilot is not installed. */
  const [splitId, setSplitId] = useState<string | null>(null);
  const [hasSplit, setHasSplit] = useState<boolean | null>(null);
  const [total, setTotal] = useState(0);
  const [untrackedOnly, setUntrackedOnly] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [stats, setStats] = useState<{ jobs: number } | null>(null);
  const [surface, setSurface] = useState<string | null>(null);

  /*
    Whether this window is a split with a site in the other half.

    While it is, the left pane is the whole app, and the only thing worth
    putting in half a window next to a job posting is the assistant. So the
    canvas — tabs, lists, editors — steps aside, and comes back when the
    split does.

    The extension says so. The page cannot work it out for itself: a narrow
    window is not a split, and asking would mean asking forever, because
    nothing else announces that the arrangement changed.
  */
  const [inSplit, setInSplit] = useState(false);

  const [share, setShare] = useState(storedShare);

  /*
    A drag reads its own state, not React's.

    Both of these were state, and both were wrong by one event: the handler
    for a pointermove closes over the render that was current when it was
    attached, so the first move after pressing saw dragging still false,
    and the width written down at the end of a drag was the one before the
    last move. A drag is a stream of events in a single gesture; it needs
    the value as it is now, not as it was at the last paint.
  */
  const dragging = useRef(false);
  const shareNow = useRef(share);
  /** Whether the edge is sitting in the middle, so the handle can say so. */
  const [snapped, setSnapped] = useState(false);
  const snappedNow = useRef(false);

  const markSnapped = (is: boolean) => {
    if (snappedNow.current === is) return;
    snappedNow.current = is;
    setSnapped(is);
  };

  const resize = (next: number) => {
    shareNow.current = next;
    setShare(next);
  };

  /** The open conversation. The workspace below belongs to it. */
  const [threadId, setThreadId] = useState<number | null>(threadFromUrl);

  /*
    The canvas is hidden, never unmounted.

    Unmounting it would throw away every open editor, every half-written
    field and the place you had scrolled to, and rebuild all of it on the way
    back — for a column that is coming back in a few seconds. Hiding keeps
    the state; the scroll position is the one part hiding does not keep, so
    it is kept here.
  */
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledTo = useRef(0);

  useLayoutEffect(() => {
    // Restoring in a layout effect, before the browser paints: set after the
    // paint and the column flashes at the top before jumping down.
    if (!inSplit && scroller.current) scroller.current.scrollTop = scrolledTo.current;
  }, [inSplit]);

  /*
    The extension pushes the arrangement whenever it changes, to every tab
    that has its content script — which is how this page hears about a split
    it did not ask for, and about one taken apart from the extension's popup.
  */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as { type?: string; role?: string | null; split?: boolean } | null;
      if (data?.type !== "split-pilot:role") return;
      setInSplit(data.role === "left" && data.split === true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /*
    Tell the server what is on screen, so the agent can resolve "this one"
    without a screenshot. Only a visible tab reports; see reportState.ts.
  */
  useReportState({
    tab,
    selected: { job: selected, resume: openResume, coverLetter: openLetter, surface },
  });

  /*
    A tab the person has just asked for, which the next restore must not undo.

    Opening a thread puts back the view that thread was left in, and
    continuing with the questions opens the thread they were asked in — so
    pressing Continue from the Admin tab opened the thread, restored its
    saved view, and landed back on Admin, which is the tab they had just
    pressed a button to leave. A proposal waiting on the profile already
    outranks the saved view for the same reason; this is the same rule for
    the case where the question has not arrived yet.
  */
  const askedFor = useRef<Tab | null>(null);

  /** Changing tab closes whatever overlay is open, so the new tab is visible. */
  function goToTab(next: Tab) {
    askedFor.current = null;
    setTab(next);
    setSelected(null);
    setOpenResume(null);
    setOpenLetter(null);
  }

  /*
    A change the assistant is proposing brings the profile forward.

    It takes the tab, which is a thing to do sparingly and is right here: the
    proposal is a question waiting in a field, and a question nobody can see
    is a conversation that has stalled. The field scrolls itself into view —
    see Profile.tsx — so what arrives is the question, in place, rather than
    an instruction to go and find it.
  */
  const bringProfileForward = useCallback(() => {
    void api.pendingEdit().then((answer) => {
      if (answer.pending) setTab("profile");
    });
  }, []);
  useChanges("focus", bringProfileForward);
  /*
    And on a reload, because a question that was waiting is still waiting. The
    alternative is somebody opening the app to a tab that does not show the
    thing the assistant is asking about.
  */
  useEffect(bringProfileForward, [bringProfileForward]);


  /*
    Tell the extension which conversation is open, so pages opened from here
    are recorded against it. Said on every change, including the first,
    because the worker may have been asleep and forgotten.
  */
  useEffect(() => {
    void tellThread(hasSplit ? splitId : null, threadId);
  }, [splitId, hasSplit, threadId]);

  /*
    Switching conversation puts back what that conversation was showing.

    A thread is a piece of work — a company, an application, an afternoon —
    and coming back to it in the state you left it is the difference between
    a conversation and a chat window that happens to remember text. The pane
    follows: the page this thread was reading comes back beside it, and a
    thread with no pages gets the whole window.

    `applying` stops the save below from firing on the restore itself, which
    would write the state we just left over the one we just loaded.
  */
  const applying = useRef(false);
  /** A debounced save that has not gone out yet, and whose thread it is. */
  const unsaved = useRef<{ id: number; workspace: Workspace } | null>(null);

  /*
    A conversation that was just born here keeps the view it was born in.

    Starting a thread from the Profile tab means asking about the profile,
    and resetting to the job list at that moment would take away the thing
    being asked about. Every other arrival at a thread with nothing stored
    is a switch to a conversation that has never had a view, and that one
    starts fresh rather than borrowing the last thread's.
  */
  const bornHere = useRef(false);

  useEffect(() => {
    if (threadId === null) return;
    let current = true;

    void (async () => {
      const { workspace } = await api.workspace(threadId).catch(() => ({ workspace: null }));
      if (!current) return;

      const kept = asWorkspace(workspace) ?? (bornHere.current ? null : FRESH);
      bornHere.current = false;
      if (kept) {
        applying.current = true;
        setTab(askedFor.current ?? kept.tab);
        setSelected(kept.job);
        setOpenResume(kept.resume);
        setOpenLetter(kept.letter);
        setSurface(kept.surface);
        setSearch(kept.search);
        setUntrackedOnly(kept.untrackedOnly);
      }

      /*
        Unless something is waiting to be answered on the profile, which
        outranks the view this conversation was left in.

        This restore runs after a fetch, so it used to land after the focus
        handler had already brought the profile forward and put the view back
        — and the assistant would say a change was on their screen while the
        job list was on it.
      */
      const waiting = await api.pendingEdit().catch(() => ({ pending: null }));
      if (!current) return;
      if (waiting.pending) setTab("profile");
      else if (askedFor.current) setTab(askedFor.current);
      askedFor.current = null;

      // And the pane. Its last page, or none — in which case the window is
      // the app's again, with the page still open behind it.
      const id = hasSplit ? splitId : null;
      const pages = await threadTabs(id, threadId).catch(() => []);
      if (!current) return;
      // The one it had in the pane, or its most recent page if that one
      // has since been closed — and only if the pane was open at all.
      const wanted = pages.find((page) => page.shown) ?? pages.at(-1);
      if (wanted && (kept?.pane ?? true)) await showInPane(id, wanted.id);
      else await leaveSplit(id);
    })();

    return () => {
      current = false;
    };
  }, [threadId, splitId, hasSplit]);

  /*
    And remember it, a moment after it stops changing.

    On every keystroke would be a request per letter typed into the search
    box. A moment later is soon enough for something nobody reads until they
    come back to it.
  */
  useEffect(() => {
    if (threadId === null) return;
    if (applying.current) {
      applying.current = false;
      return;
    }
    const workspace: Workspace = {
      tab,
      job: selected,
      resume: openResume,
      letter: openLetter,
      surface,
      search,
      untrackedOnly,
      pane: inSplit,
    };
    unsaved.current = { id: threadId, workspace };

    const timer = setTimeout(() => {
      unsaved.current = null;
      void api.saveWorkspace(threadId, workspace).catch(() => {
        // Losing the place you were at is not worth an error in front of
        // someone who is reading something else.
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [threadId, tab, selected, openResume, openLetter, surface, search, untrackedOnly, inSplit]);

  /*
    A change made in the last moment before leaving still counts.

    The save above waits, and switching conversation cancels what it was
    waiting for — so giving the window back to the app and immediately
    switching threads lost exactly the thing you had just done. This writes
    whatever is still waiting, for the thread being left, before the next
    one is loaded.
  */
  useEffect(() => {
    return () => {
      const waiting = unsaved.current;
      unsaved.current = null;
      if (waiting) void api.saveWorkspace(waiting.id, waiting.workspace).catch(() => undefined);
    };
  }, [threadId]);

  /*
    The app's own links go in the pane beside it.

    This used to be left to the extension, which catches a click in any page
    and routes it — but only in a tab it already knows as the left of a pair,
    and there is no pair until something opens. The fallback for that, a new
    tab arriving with an opener, does not fire either: these links carry
    rel="noreferrer", which implies noopener, so Chrome gives the new tab no
    opener at all and the posting landed in a tab of its own. A link's
    privacy attribute is not something to drop to make an arrangement work,
    so the app routes its own links and depends on neither.

    Only links leaving this origin. The app's own routes — a rendered resume,
    say — behave as they always did.
  */
  useEffect(() => {
    if (!splitId || !hasSplit) return;

    const onClick = (event: MouseEvent) => {
      /*
        Modifier clicks included, to match what the extension does once a
        pane exists. Otherwise cmd-click would open a tab before the pane
        was there and land in the pane afterwards, which is the kind of
        inconsistency nobody can learn.
      */
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      let href: URL;
      try {
        href = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (href.origin === window.location.origin) return;
      if (href.protocol !== "http:" && href.protocol !== "https:") return;

      event.preventDefault();
      void (async () => {
        /*
          The pane first, because that is the usual case and it is one
          message. Only when there is no pane does this cost a round trip to
          the server, which is the only party that can open a tab the
          assistant will also be able to drive.
        */
        if (await routeToPane(splitId, href.href)) return;
        try {
          /*
            Empty pane first, then the page into it. The split is there in
            the moment you click, and the page arrives when it arrives —
            which is how a browser behaves. Opening the tab at the URL
            meant Playwright held it until the page had loaded, so a slow
            posting left you looking at an unchanged window for seconds
            with no sign anything had happened.
          */
          await api.openStage();
          await adoptStage(splitId);
          await routeToPane(splitId, href.href);
        } catch {
          // No arrangement to be had — the browser is off, or Playwright is
          // not there. Open it the ordinary way rather than losing the click.
          window.open(href.href, "_blank", "noreferrer");
        }
      })();
    };

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [splitId, hasSplit]);

  /*
    Nothing here puts the panes back.

    Two effects used to: one on the extension saying the pair was gone, one
    on returning to the tab. Both existed because the arrangement was meant
    to be permanent, so losing it was a fault to repair. It is not permanent
    any more — no pair is the resting state — and an effect that rebuilds it
    would reopen a blank pane every time the person closed one.
  */


  const loadSetup = useCallback(() => {
    void api.setup().then(setSetupInfo);
    void api.health().then(setHealth);
    void api.prefs().then((prefs) => setPlace(prefs.home_location ?? ""));
    /*
      The extension is optional. Ask once; if it is not there the control is
      not shown at all, rather than offering something that cannot happen.
    */
    void api.setup().then(async (setup) => {
      const id = setup.split_extension_id;
      setSplitId(id ?? null);
      const there = id ? await splitInstalled(id) : false;
      setHasSplit(there);
      if (!there || !id) return;

      // Keep the extension's token in step with the server's, so Playwright
      // connects through it without anyone copying a string.
      if (setup.browser_token) await syncToken(id, setup.browser_token);

      /*
        No split at rest.

        The app used to arrange one as it loaded and keep it for the session,
        which meant half the window held a blank page whenever nobody was
        reading anything. The arrangement is now made when a page is opened —
        by the agent, or by a link from here — and comes apart when that page
        is closed.
      */
    });
  }, []);

  useEffect(loadSetup, [loadSetup]);

  const loadData = useCallback(() => {
    if (place === undefined) return; // wait for prefs, or the first load is unfiltered
    void api
      .jobs({
        text: search || undefined,
        location: place,
        includeRemote,
        untracked: untrackedOnly,
      })
      .then((result) => {
        setJobs(result.jobs);
        setTotal(result.total);
      });
    void api.applications().then(setApplications);
    void api.resumes().then(setResumes);
    void api.coverLetters().then(setLetters);
    void api.stats().then(setStats);
  }, [search, place, includeRemote, untrackedOnly]);

  useEffect(() => {
    if (setupInfo?.credential.set) loadData();
  }, [setupInfo, loadData]);

  async function sync() {
    setSyncing(true);
    setNotice(null);
    try {
      const { reports, note } = await api.sync();
      const inserted = reports.reduce((total, report) => total + report.inserted, 0);
      const seen = reports.reduce((total, report) => total + report.seen, 0);
      const kept = reports.reduce((total, report) => total + report.kept, 0);
      const failed = reports.filter((report) => report.error);

      // New postings have no score, and an unscored list falls back to fetch
      // order, which looks like relevance and is not. Always re-rank.
      let ranked = "";
      try {
        const result = await api.rank();
        ranked = ` · ranked ${result.scored}`;
      } catch {
        ranked = " · not ranked (add roles to your profile first)";
      }

      /*
        Both numbers, because they are different facts. "12 new" alone hides
        that 2,400 postings were looked at and most were not for this person,
        which is the thing worth knowing about a board you just followed.
      */
      setNotice(
        `Synced ${reports.length} boards · ${kept} of ${seen} postings match you · ` +
          `${inserted} new${ranked}` +
          (note ? ` · ${note}` : "") +
          (failed.length ? ` · ${failed.length} failed: ${failed.map((f) => f.company).join(", ")}` : ""),
      );
      loadData();
    } catch (syncError) {
      setNotice((syncError as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  /** Judge the best-matching postings that have no opinion on them yet. */
  async function assess() {
    setAssessing(true);
    setNotice(null);
    try {
      const result = await api.assess(20, place, includeRemote);
      const spend = result.cost_usd.toFixed(3);
      setNotice(
        `Assessed ${result.assessed} postings` +
          (place ? ` in ${place}` : "") +
          ` on ${result.model} for $${spend}` +
          (result.failed ? ` · ${result.failed} failed` : ""),
      );
      loadData();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setAssessing(false);
    }
  }

  if (!setupInfo) {
    return <div className="empty">Connecting to the local server…</div>;
  }

  if (!setupInfo.credential.set) {
    return <Setup info={setupInfo} onDone={loadSetup} />;
  }

  const statuses = health?.statuses ?? [];

  return (
    <div className={`app${inSplit ? " split" : ""}`}>
      {/*
        The assistant is the left column and stays put. Everything else is
        the canvas, which gives way when a site opens beside it.
      */}
      {/*
        A percentage, so the browser keeps the proportion as the window
        changes size. Doing it in JavaScript would mean a resize listener
        recomputing what CSS already knows, and a column that lags the drag
        of a window edge.
      */}
      <aside
        className="messaging"
        style={inSplit ? undefined : { width: `${(share * 100).toFixed(3)}%` }}
      >
        {/*
          The logo gives the window back to the app.

          It is the one thing on screen that always means "the app itself",
          so it is where you reach for the whole of it. Nothing closes: the
          page keeps its tab and its chip, and clicking the chip takes the
          pane back.
        */}
        <button
          className="brand"
          disabled={!inSplit}
          title={inSplit ? "Show the whole app. The open page stays open." : undefined}
          onClick={() => void leaveSplit(hasSplit ? splitId : null)}
        >
          job<span>search</span>
        </button>
          <Chat
          onDataChanged={loadData}
          splitId={hasSplit ? splitId : null}
          threadId={threadId}
          onShowQuestions={() => {
            goToTab("profile");
            /* Set after, because changing tab is what clears it. */
            askedFor.current = "profile";
          }}
          onOpenJob={(id) => {
            // The canvas, not the pane: this is a posting we hold, not a
            // page on the web. If the app is in a split it comes back first.
            void leaveSplit(hasSplit ? splitId : null);
            goToTab("jobs");
            setSelected(id);
          }}
          onOpenThread={(id) => {
            // A thread the server made for a message just sent from here,
            // rather than one picked from the list.
            bornHere.current = threadId === null && id !== null;
            setThreadId(id);
            putThreadInUrl(id);
          }}
        />
      </aside>

      {/*
        Dragging the edge of the assistant's column.

        Pointer events rather than mouse ones, so a trackpad, a touchscreen
        and a pen all work, and with the pointer captured so the drag
        survives the cursor crossing into the canvas — without that, moving
        faster than React re-renders drops the drag.

        The width is written down when the drag ends rather than as it
        moves: sixty writes a second to say what one write at the end says
        just as well.
      */}
      {!inSplit && (
        <div
          className={`resizer${snapped ? " snapped" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Width of the assistant"
          tabIndex={0}
          onPointerDown={(event) => {
            /*
              Capture is an optimisation, not the mechanism. It keeps the
              drag alive while the cursor is over the canvas; if the browser
              refuses it, dragging inside the handle still works, whereas a
              throw here would leave the handle dead and say nothing.
            */
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // No capture. The drag is narrower, not broken.
            }
            dragging.current = true;
          }}
          onPointerMove={(event) => {
            if (!dragging.current) return;
            /*
              Half is the width worth hitting exactly, because it is the
              width Chrome's split always uses: the app and the split then
              line up rather than nearly lining up. Only half — a handful of
              snap points is a handle that fights you.

              Hold alt to place it anywhere, as every tool with snapping
              does, so this never costs you a width you actually wanted.
            */
            const middle = window.innerWidth / 2;
            const sticks = !event.altKey && Math.abs(event.clientX - middle) <= SNAP_PX;
            markSnapped(sticks);
            // The column starts at the left edge, so the pointer's x is it.
            resize(sticks ? SHARE_DEFAULT : shareAt(event.clientX));
          }}
          onPointerUp={(event) => {
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch {
              // It was never captured.
            }
            dragging.current = false;
            markSnapped(false);
            rememberShare(shareNow.current);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            // A step in pixels, so a key press moves the edge the same
            // distance whatever the window is doing.
            const step = (event.shiftKey ? 48 : 12) / Math.max(1, window.innerWidth);
            const next = sensibleShare(shareNow.current + (event.key === "ArrowLeft" ? -step : step));
            resize(next);
            rememberShare(next);
          }}
          onDoubleClick={() => {
            resize(SHARE_DEFAULT);
            rememberShare(SHARE_DEFAULT);
          }}
        />
      )}

      <div className="canvas" aria-hidden={inSplit || undefined}>
      <header className="header">
        <div className="spacer" />
        <div className="counts">{stats ? `${stats.jobs} postings` : ""}</div>
        <button onClick={() => void sync()} disabled={syncing || assessing}>
          {syncing ? "Syncing…" : "Sync boards"}
        </button>
        <button
          onClick={() => void assess()}
          disabled={syncing || assessing}
          title="Read and score the 20 best-matching postings that have no opinion yet"
        >
          {assessing ? "Assessing…" : "Assess top 20"}
        </button>
      </header>

      {notice && <div className="banner">{notice}</div>}

      <div className="tabs">
        {/*
          Who you are first, then the search. Profile, Projects and Design are
          one thing — what you have done, written up, and how it looks — and
          they are what you set up before any of the rest is useful. Projects
          travels with them rather than staying between Drafts and Boards,
          where it would be the only part of that group left behind.
        */}
        <button aria-selected={tab === "profile"} onClick={() => goToTab("profile")}>
          Profile
        </button>
        <button aria-selected={tab === "projects"} onClick={() => goToTab("projects")}>
          Projects
        </button>
        <button aria-selected={tab === "design"} onClick={() => goToTab("design")}>
          Design
        </button>
        <button aria-selected={tab === "jobs"} onClick={() => goToTab("jobs")}>
          Jobs
        </button>
        <button aria-selected={tab === "applications"} onClick={() => goToTab("applications")}>
          Applications ({applications.length})
        </button>
        <button aria-selected={tab === "drafts"} onClick={() => goToTab("drafts")}>
          Drafts ({resumes.length + letters.length})
        </button>
        <button aria-selected={tab === "boards"} onClick={() => goToTab("boards")}>
          Boards
        </button>
        <button aria-selected={tab === "admin"} onClick={() => goToTab("admin")}>
          Admin
        </button>
      </div>

      {tab === "jobs" && (
        <>
          <div className="filters">
            <input
              value={search}
              placeholder="Search title and description…"
              onChange={(event) => setSearch(event.target.value)}
            />
            <label className="toggle">
              <input
                type="checkbox"
                checked={untrackedOnly}
                onChange={(event) => setUntrackedOnly(event.target.checked)}
              />
              New
            </label>
          </div>
          <div className="filters">
            <input
              className="place"
              value={place ?? ""}
              placeholder="Anywhere"
              title="The city you want to work in. Leave empty to search everywhere."
              onChange={(event) => setPlace(event.target.value)}
              onBlur={(event) => void api.setHomeLocation(event.target.value)}
            />
            <label className="toggle">
              <input
                type="checkbox"
                checked={includeRemote}
                disabled={!place}
                onChange={(event) => setIncludeRemote(event.target.checked)}
              />
              Remote elsewhere
            </label>
            <span className="counts">
              {jobs.length < total ? `${jobs.length} of ${total}` : `${total}`}
            </span>
          </div>
        </>
      )}

      <div className="body-wrap">
        <div
          className="scroll"
          ref={scroller}
          onScroll={(event) => {
            // Remembered as it happens. Read on the way out instead and the
            // answer is zero: by then the column is display:none.
            scrolledTo.current = event.currentTarget.scrollTop;
          }}
        >
          {tab === "admin" ? (
            <Admin />
          ) : tab === "projects" ? (
            <Projects />
          ) : tab === "design" ? (
            <LayoutEditor onSurface={setSurface} />
          ) : tab === "boards" ? (
            <Boards place={place} includeRemote={includeRemote} onChanged={loadData} />
          ) : tab === "profile" ? (
            <Profile />
          ) : tab === "drafts" ? (
            resumes.length + letters.length === 0 ? (
              <div className="empty">
                No drafts yet. Ask the assistant to tailor a resume or write a cover letter for a
                job.
              </div>
            ) : (
              <div>
                {resumes.map((item) => (
                  <div key={`r${item.id}`} className="row" onClick={() => setOpenResume(item.id)}>
                    <div className="score" />
                    <div className="row-main">
                      <div className="row-title">{item.label ?? `Draft ${item.id}`}</div>
                      <div className="row-sub">
                        {item.title ? `${item.title} · ${item.company}` : "Base resume"} ·{" "}
                        {item.lines} lines
                      </div>
                    </div>
                    <span className="pill">resume</span>
                  </div>
                ))}
                {letters.map((item) => (
                  <div key={`c${item.id}`} className="row" onClick={() => setOpenLetter(item.id)}>
                    <div className="score" />
                    <div className="row-main">
                      <div className="row-title">
                        {item.title ? `Cover letter — ${item.title}` : `Cover letter ${item.id}`}
                      </div>
                      <div className="row-sub">
                        {item.company ?? "No posting"} ·{" "}
                        {item.body.trim().split(/\s+/).length} words
                        {item.warnings.length > 0
                          ? ` · ${item.warnings.length} unsupported figures`
                          : ""}
                      </div>
                    </div>
                    <span className={`pill${item.warnings.length ? " s-rejected" : ""}`}>
                      {item.warnings.length ? "check" : "letter"}
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : tab === "jobs" ? (
            <JobList jobs={jobs} selectedId={selected} onSelect={setSelected} />
          ) : applications.length === 0 ? (
            <div className="empty">Nothing tracked yet. Open a job and choose “Track this”.</div>
          ) : (
            <div>
              {applications.map((application) => (
                <div
                  key={application.id}
                  className="row"
                  onClick={() => setSelected(application.job_id)}
                >
                  <div className="score" />
                  <div className="row-main">
                    <div className="row-title">{application.title}</div>
                    <div className="row-sub">
                      {application.company}
                      {application.location ? ` · ${application.location}` : ""}
                    </div>
                  </div>
                  <span className={`pill s-${application.status}`}>{application.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {openResume != null && (
          <ResumeView resumeId={openResume} onClose={() => setOpenResume(null)} />
        )}

        {openLetter != null && (
          <CoverLetter
            letterId={openLetter}
            onClose={() => setOpenLetter(null)}
            onDeleted={loadData}
          />
        )}

        {selected != null && openResume == null && openLetter == null && (
          <JobDetail
            jobId={selected}
            statuses={statuses}
            onClose={() => setSelected(null)}
            onChanged={loadData}
            onOpenResume={setOpenResume}
            onOpenLetter={setOpenLetter}
          />
        )}
      </div>
      </div>
    </div>
  );
}

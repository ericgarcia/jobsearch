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
import { LayoutEditor } from "./components/LayoutEditor.tsx";
import { Projects } from "./components/Projects.tsx";
import { useReportState } from "./reportState.ts";
import { Boards } from "./components/Boards.tsx";
import { splitInstalled, syncToken } from "./split.ts";
import { ResumeView } from "./components/ResumeView.tsx";
import { CoverLetter } from "./components/CoverLetter.tsx";

type Tab = "jobs" | "applications" | "drafts" | "profile" | "projects" | "design" | "boards";

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

  /** Changing tab closes whatever overlay is open, so the new tab is visible. */
  function goToTab(next: Tab) {
    setTab(next);
    setSelected(null);
    setOpenResume(null);
    setOpenLetter(null);
  }


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
      const reports = await api.sync();
      const inserted = reports.reduce((total, report) => total + report.inserted, 0);
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

      setNotice(
        `Synced ${reports.length} boards · ${inserted} new postings${ranked}` +
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
      <aside className="messaging">
        <div className="brand">
          job<span>search</span>
        </div>
          <Chat onDataChanged={loadData} splitId={hasSplit ? splitId : null} />
      </aside>

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
          {tab === "projects" ? (
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
          />
        )}
      </div>
      </div>
    </div>
  );
}

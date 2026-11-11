import { useCallback, useEffect, useRef, useState } from "react";
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
import { Boards } from "./components/Boards.tsx";
import { adoptStage, myRole, splitInstalled, syncToken } from "./split.ts";
import { ResumeView } from "./components/ResumeView.tsx";
import { CoverLetter } from "./components/CoverLetter.tsx";

type Tab = "jobs" | "applications" | "drafts" | "profile" | "boards";

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

  /** Changing tab closes whatever overlay is open, so the new tab is visible. */
  function goToTab(next: Tab) {
    setTab(next);
    setSelected(null);
    setOpenResume(null);
    setOpenLetter(null);
  }

  /*
    Arrange the panes from the server, not from here.

    The app could pair the two tabs itself, and the result would look the same
    and be half as useful: a stage this page creates is a tab Playwright never
    opened, so the assistant could watch it and not touch it. The server has
    Playwright open the stage and the extension adopt it, which is the only
    order that leaves both panes drivable.

    Failure is silent on purpose. The browser may be off, or the extension not
    answering; neither is a reason to put an error in front of someone who
    came here to look at jobs.
  */
  const arrangedAt = useRef(0);

  const arrange = async (id: string) => {
    // Several things can ask at once — a load, a return to the tab, the
    // extension reporting the pair gone. They all want the same one call.
    if (Date.now() - arrangedAt.current < 3000) return;
    arrangedAt.current = Date.now();
    try {
      /*
        Two steps, and the order is forced. Only the server can have
        Playwright open the stage, so the assistant can address it. Only this
        page can adopt it, because the extension makes the asking tab the
        driver and nothing else can identify which tab that is.
      */
      const { needed } = await api.openStage(await myRole(id));
      if (needed) await adoptStage(id);
    } catch {
      // An arrangement failing is not a reason for the app to fail.
    }
  };

  /*
    Put the panes back as soon as the extension says they are gone.

    The content script tells this page its role whenever the pairing changes,
    and role becoming null means the pair has dissolved. That is the only
    signal that arrives for the likeliest way to lose the arrangement — the
    extension's own popup — because the tab never stops being visible and so
    no focus or visibility event ever fires.
  */
  useEffect(() => {
    if (!splitId || !hasSplit) return;

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as { type?: string; role?: string | null } | null;
      if (data?.type !== "split-pilot:role") return;
      if (data.role !== null) return;

      /*
        Only react to losing the pair while this tab is the one being looked
        at.

        Every open app tab hears this. When one of them takes the split the
        others are told their pair is gone, so they take it back, and are told
        again: three app tabs left two stages behind and were still trading
        the split between them. A tab nobody is looking at has no business
        grabbing the window back.

        This guard is here rather than inside arrange() because a page load
        must still arrange even when the tab is in the background — opening
        the app in a background tab is ordinary, and a load happens once, so
        it cannot start a fight.
      */
      if (document.visibilityState !== "visible") return;
      void arrange(splitId);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [splitId, hasSplit]);

  /*
    And when you come back to the tab, as a backstop.

    The arrangement can be taken apart from outside the app — the extension's
    own popup, or closing the stage — and without this it would stay broken
    until the next reload, with the assistant quietly unable to reach half of
    what it is being asked about. Checking on return rather than on a timer
    means it costs nothing while you are reading, and the check is a no-op
    when the panes are already good.
  */
  useEffect(() => {
    if (!splitId || !hasSplit) return;
    let last = 0;

    const check = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      void arrange(splitId);
    };

    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [splitId, hasSplit]);

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

      if (setup.browser) void arrange(id);
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
    <div className="app">
      <header className="header">
        <div className="brand">
          job<span>search</span>
        </div>
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
        <button aria-selected={tab === "jobs"} onClick={() => goToTab("jobs")}>
          Jobs
        </button>
        <button aria-selected={tab === "applications"} onClick={() => goToTab("applications")}>
          Applications ({applications.length})
        </button>
        <button aria-selected={tab === "drafts"} onClick={() => goToTab("drafts")}>
          Drafts ({resumes.length + letters.length})
        </button>
        <button aria-selected={tab === "profile"} onClick={() => goToTab("profile")}>
          Profile
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
        <div className="scroll">
          {tab === "boards" ? (
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

      <Chat onDataChanged={loadData} />
    </div>
  );
}

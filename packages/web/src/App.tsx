import { useCallback, useEffect, useState } from "react";
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
import { closeSplit, openSplit, splitInstalled, syncToken, type SplitState } from "./split.ts";
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
  const [split, setSplit] = useState<SplitState | null>(null);
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
      // Keep the extension's token in step with the server's, so Playwright
      // connects through it without anyone copying a string.
      if (there && id && setup.browser_token) await syncToken(id, setup.browser_token);
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
        {hasSplit && splitId && (
          <button
            className="ghost"
            title={
              split?.paired
                ? "Stop pairing. Both tabs stay open."
                : "Open a pane beside this one. Links here will open in it instead of a new tab."
            }
            onClick={() => {
              void (async () => {
                if (split?.paired) {
                  await closeSplit(splitId);
                  setSplit(null);
                } else {
                  setSplit(await openSplit(splitId));
                }
              })();
            }}
          >
            {split?.paired ? "Unsplit" : "Split view"}
          </button>
        )}
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

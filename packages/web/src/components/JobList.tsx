import type { Job } from "../api.ts";

/**
 * Two different numbers share this column. fit_score is the agent's judgement
 * after reading the posting; match_score is keyword overlap with the profile.
 * The match score is shown dimmed, so an opinion never looks like arithmetic.
 */
function score(job: Job): { value: string; className: string; title: string } {
  if (job.fit_score != null) {
    const band = job.fit_score >= 75 ? " high" : job.fit_score >= 50 ? " mid" : "";
    return {
      value: String(job.fit_score),
      className: `score${band}`,
      title: "Fit, judged by the assistant after reading the posting",
    };
  }
  if (job.match_score != null) {
    return {
      value: String(job.match_score),
      className: "score match",
      title: "Keyword overlap with your profile. Not a judgement — ask the assistant to read it.",
    };
  }
  return { value: "–", className: "score", title: "Not scored yet" };
}

export function JobList({
  jobs,
  selectedId,
  onSelect,
}: {
  jobs: Job[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  if (jobs.length === 0) {
    return <div className="empty">No postings match. Try fewer filters, or sync the boards.</div>;
  }

  return (
    <div>
      {jobs.map((job) => (
        <div
          key={job.id}
          className={`row${job.id === selectedId ? " selected" : ""}`}
          onClick={() => onSelect(job.id)}
        >
          <div className={score(job).className} title={score(job).title}>
            {score(job).value}
          </div>
          <div className="row-main">
            <div className="row-title">{job.title}</div>
            <div className="row-sub">
              {job.company}
              {job.location ? ` · ${job.location}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {job.remote === 1 && <span className="pill remote">remote</span>}
            {job.status && <span className={`pill s-${job.status}`}>{job.status}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

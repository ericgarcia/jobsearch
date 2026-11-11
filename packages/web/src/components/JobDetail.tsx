import { useEffect, useState } from "react";
import { api, type JobDetail as Detail } from "../api.ts";

export function JobDetail({
  jobId,
  statuses,
  onClose,
  onChanged,
}: {
  jobId: number;
  statuses: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [job, setJob] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api
      .job(jobId)
      .then(setJob)
      .catch((loadError: Error) => setError(loadError.message));
  };

  useEffect(load, [jobId]);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      load();
      onChanged();
    } catch (actError) {
      setError((actError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!job) {
    return (
      <div className="detail">
        <div className="detail-head">
          <button className="ghost" style={{ alignSelf: "flex-start" }} onClick={onClose}>
            ← Back
          </button>
        </div>
        <div className="empty">{error ?? "Loading posting…"}</div>
      </div>
    );
  }

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="ghost" style={{ alignSelf: "flex-start" }} onClick={onClose}>
          ← Back
        </button>
        <h2>{job.title}</h2>
        <div className="detail-meta">
          {job.company}
          {job.location ? ` · ${job.location}` : ""}
          {job.remote === 1 ? " · remote" : ""}
        </div>
        <div className="detail-actions">
          <a href={job.url} target="_blank" rel="noreferrer">
            Open posting ↗
          </a>
          <div style={{ flex: 1 }} />
          {job.status ? (
            <select
              value={job.status}
              disabled={busy}
              onChange={(event) => void act(() => api.setStatus(job.id, event.target.value))}
            >
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          ) : (
            <button disabled={busy} onClick={() => void act(() => api.track(job.id))}>
              Track this
            </button>
          )}
        </div>
        {error && <p style={{ color: "var(--bad)", margin: 0, fontSize: 12 }}>{error}</p>}
      </div>

      <div className="scroll">
        {job.fit_score != null && (
          <div className="assessment">
            <b style={{ color: "var(--text)" }}>Fit {job.fit_score}/100</b>
            {job.model ? <span className="judged-by"> judged by {job.model}</span> : null}
            {job.reasoning ? ` — ${job.reasoning}` : ""}
          </div>
        )}
        <div className="description">{job.description ?? "No description stored."}</div>
        {job.history.length > 0 && (
          <div className="history">
            {job.history.map((event, index) => (
              <div key={index}>
                {event.at} {event.from_status ?? "new"} → {event.to_status}
                {event.note ? ` · ${event.note}` : ""}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

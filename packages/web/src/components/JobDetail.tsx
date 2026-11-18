import { useEffect, useState } from "react";
import { api, type ApplicationForm, type JobDetail as Detail } from "../api.ts";

export function JobDetail({
  jobId,
  statuses,
  onClose,
  onChanged,
  onOpenResume,
  onOpenLetter,
}: {
  jobId: number;
  statuses: string[];
  onClose: () => void;
  onChanged: () => void;
  onOpenResume: (id: number) => void;
  onOpenLetter: (id: number) => void;
}) {
  const [job, setJob] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
    What applying will involve, read from the board on request.

    Not on open: it is a live fetch to another company's site, and firing one
    every time somebody glances at a posting would be both slow and rude.
    Asked for when it is wanted, which is when applying is being considered.
  */
  const [form, setForm] = useState<ApplicationForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    setForm(null);
    setFormError(null);
  }, [jobId]);

  async function readForm() {
    setReading(true);
    setFormError(null);
    try {
      setForm(await api.applicationForm(jobId));
    } catch (readError) {
      setFormError((readError as Error).message);
    } finally {
      setReading(false);
    }
  }

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
          {!form && (
            <button className="ghost" disabled={reading} onClick={() => void readForm()}>
              {reading ? "Reading…" : "What does applying need?"}
            </button>
          )}
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
        {formError && (
          <div className="assessment" style={{ color: "var(--bad)" }}>
            The application form could not be read: {formError}
          </div>
        )}
        {form && (
          /*
            Grouped by who answers, because that is the thing worth knowing
            before starting: what the app already has, what it will write,
            what you have to decide once, and what is yours alone.
          */
          <div className="form-needs">
            <div className="form-needs-head">{form.summary}</div>
            {(
              [
                ["document", "Documents"],
                ["standing", "About your situation"],
                ["custom", "Their own questions"],
                ["consent", "Consents, left alone"],
                ["eeo", "Voluntary, and yours alone"],
                ["identity", "From your profile"],
                ["link", "Links"],
              ] as const
            ).map(([kind, heading]) => {
              const group = form.fields.filter((field) => field.kind === kind);
              if (group.length === 0) return null;
              return (
                <div className="form-group" key={kind}>
                  <div className="form-group-head">{heading}</div>
                  {group.map((field, index) => (
                    <div className="form-field" key={`${field.ref ?? field.label}-${index}`}>
                      <span className={`form-req${field.required ? " yes" : ""}`}>
                        {field.required ? "required" : "optional"}
                      </span>
                      <span className="form-label">{field.label}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        {(job.drafts.resumes.length > 0 || job.drafts.cover_letters.length > 0) && (
          /*
            What has been written for this application, next to the
            application. These were always stored against the job and shown
            only in Drafts, where a resume for one posting is indistinguishable
            from a resume for another.
          */
          <div className="job-drafts">
            <span className="job-drafts-head">Written for this application</span>
            {job.drafts.resumes.map((draft) => (
              <button className="ghost" key={`r${draft.id}`} onClick={() => onOpenResume(draft.id)}>
                {draft.label ?? `Resume ${draft.id}`}
              </button>
            ))}
            {job.drafts.cover_letters.map((draft) => (
              <button className="ghost" key={`c${draft.id}`} onClick={() => onOpenLetter(draft.id)}>
                Cover letter
              </button>
            ))}
          </div>
        )}
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

import { useEffect, useState } from "react";
import { api, type Resume } from "../api.ts";

/**
 * A drafted resume. Each line shows the fact it came from, so a reworded line
 * can be compared with what is actually stored. Warnings are not advisory
 * decoration: they mean a figure on the page is not supported by the profile.
 */
export function ResumeView({ resumeId, onClose }: { resumeId: number; onClose: () => void }) {
  const [resume, setResume] = useState<Resume | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void api.resume(resumeId).then(setResume);
  }, [resumeId]);

  // An older server may not send this field at all; never crash the page over it.
  const summaryWarnings = resume?.summary_warnings ?? [];

  if (!resume) {
    return (
      <div className="detail">
        <div className="detail-head">
          <button className="ghost" style={{ alignSelf: "flex-start" }} onClick={onClose}>
            ← Back
          </button>
        </div>
        <div className="empty">Loading draft…</div>
      </div>
    );
  }

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="ghost" style={{ alignSelf: "flex-start" }} onClick={onClose}>
          ← Back
        </button>
        <h2>{resume.label ?? `Draft ${resume.id}`}</h2>
        <div className="detail-meta">
          {resume.job ? `${resume.job.title} · ${resume.job.company}` : "Base resume"} ·{" "}
          {resume.lines.length} lines
        </div>
        <div className="detail-actions">
          <button
            onClick={() => {
              void api.resumeMarkdown(resume.id).then((result) => setMarkdown(result.markdown));
            }}
          >
            {markdown ? "Refresh Markdown" : "Show Markdown"}
          </button>
          {markdown && (
            <button
              onClick={() => {
                void navigator.clipboard.writeText(markdown);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      </div>

      <div className="scroll">
        {resume.warnings.length > 0 && (
          <div className="warnbox">
            <b>{resume.warnings.length} unsupported figures.</b> A number on this draft is not in
            your profile. Fix the wording, or correct the stored fact.
          </div>
        )}

        {resume.summary && (
          <div className={`assessment${summaryWarnings.length ? " warned" : ""}`}>
            {resume.summary}
            {summaryWarnings.map((warning, index) => (
              <div className="line-warning" key={index}>
                ⚠ {warning}
              </div>
            ))}
          </div>
        )}

        <div className="lines">
          {resume.lines.map((line) => (
            <div className={`line${line.warnings.length ? " warned" : ""}`} key={line.id}>
              <div className="line-text">{line.text}</div>
              {line.rendered_text && line.rendered_text !== line.source_text && (
                <div className="line-source">
                  <span>from</span> {line.source_text}
                </div>
              )}
              {line.warnings.map((warning, index) => (
                <div className="line-warning" key={index}>
                  ⚠ {warning}
                </div>
              ))}
            </div>
          ))}
        </div>

        {markdown && <pre className="markdown">{markdown}</pre>}
      </div>
    </div>
  );
}

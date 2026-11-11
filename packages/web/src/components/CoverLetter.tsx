import { useEffect, useState } from "react";
import { api, type CoverLetter as Letter } from "../api.ts";

/**
 * One cover letter.
 *
 * A cover letter is free prose, so unlike a resume line it has no single stored
 * fact to compare against. It is checked against the whole profile instead, and
 * any figure that appears nowhere in it is flagged here. That check is weaker
 * than the one on a resume line, which is exactly why the letter is shown in
 * full for reading rather than summarised.
 */
export function CoverLetter({
  letterId,
  onClose,
  onDeleted,
}: {
  letterId: number;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [letter, setLetter] = useState<Letter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .coverLetter(letterId)
      .then(setLetter)
      .catch((loadError: Error) => setError(loadError.message));
  }, [letterId]);

  if (!letter) {
    return (
      <div className="detail">
        <div className="detail-head">
          <button className="ghost" style={{ alignSelf: "flex-start" }} onClick={onClose}>
            ← Back
          </button>
        </div>
        <div className="empty">{error ?? "Loading letter…"}</div>
      </div>
    );
  }

  const words = letter.body.trim().split(/\s+/).length;

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="ghost" style={{ alignSelf: "flex-start" }} onClick={onClose}>
          ← Back
        </button>
        <h2>{letter.title ? `Cover letter — ${letter.title}` : "Cover letter"}</h2>
        <div className="detail-meta">
          {letter.company ?? "No posting"} · {words} words · {letter.created_at.slice(0, 16)}
        </div>
        <div className="detail-actions">
          <button
            onClick={() => {
              void navigator.clipboard.writeText(letter.body);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          {letter.url && (
            <a href={letter.url} target="_blank" rel="noreferrer">
              Open posting ↗
            </a>
          )}
          <div style={{ flex: 1 }} />
          <button
            className="ghost"
            onClick={() => {
              if (confirm("Delete this cover letter?")) {
                void api.deleteCoverLetter(letter.id).then(() => {
                  onDeleted();
                  onClose();
                });
              }
            }}
          >
            Delete
          </button>
        </div>
      </div>

      <div className="scroll">
        {letter.warnings.length > 0 && (
          <div className="warnbox">
            <b>
              {letter.warnings.length} unsupported{" "}
              {letter.warnings.length === 1 ? "figure" : "figures"}.
            </b>{" "}
            A number in this letter appears nowhere in your profile. Check it before sending.
            <ul>
              {letter.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="letter">{letter.body}</div>
      </div>
    </div>
  );
}

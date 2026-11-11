import { useEffect, useState } from "react";
import { api, type Company, type DetectResult } from "../api.ts";

/**
 * The companies whose boards the app polls.
 *
 * Adding one used to mean knowing its applicant tracking system and its board
 * token, neither of which is on a careers page. Here you type the name and the
 * app works both out, so the thing you have to know is the thing you actually
 * know.
 */
export function Boards({ onChanged }: { onChanged: () => void }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DetectResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => void api.companies().then(setCompanies);
  useEffect(load, []);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const names = draft
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length === 0) return;

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const found = await api.detectCompanies(names, true);
      setResult(found);
      setDraft("");
      load();
      onChanged();
    } catch (addError) {
      setError((addError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const added = result?.results.filter((row) => row.found) ?? [];

  return (
    <div className="profile">
      <h3>Add companies</h3>
      <form onSubmit={(event) => void add(event)}>
        <input
          value={draft}
          disabled={busy}
          placeholder="Figma, Notion, Datadog…"
          title="Company names, separated by commas. The board is worked out for you."
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="fine">
          Type the names. The app tries Greenhouse, Lever and Ashby and keeps whichever has
          postings.
        </p>
      </form>

      {busy && <div className="hint">Looking for their boards…</div>}
      {error && <p className="error">{error}</p>}

      {result && (
        <div className="hint">
          {added.length > 0 && (
            <>
              <b>Added {added.length}:</b>{" "}
              {added.map((row) => `${row.name} (${row.found!.jobs} jobs)`).join(", ")}
            </>
          )}
          {result.missing.length > 0 && (
            <div style={{ marginTop: added.length ? 8 : 0 }}>
              <b>Not found:</b> {result.missing.join(", ")}. They may use a system this app does
              not read, or post only on their own site.
            </div>
          )}
          {added.length > 0 && <div style={{ marginTop: 8 }}>Sync boards to fetch the postings.</div>}
        </div>
      )}

      <h3>Following ({companies.length})</h3>
      {companies.length === 0 ? (
        <div className="empty">No boards yet. Add a company above.</div>
      ) : (
        <div>
          {companies.map((company) => (
            <div className="row board-row" key={company.id}>
              <div className="row-main">
                <div className="row-title">{company.name}</div>
                <div className="row-sub">
                  {company.ats} · {company.board_token}
                  {company.jobs != null ? ` · ${company.jobs} postings stored` : ""}
                </div>
              </div>
              <button
                className="ghost tiny"
                title="Stop following this board"
                onClick={() => {
                  if (confirm(`Stop following ${company.name}? Its stored postings stay.`)) {
                    void api.deleteCompany(company.id).then(() => {
                      load();
                      onChanged();
                    });
                  }
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

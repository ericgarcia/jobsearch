import { useEffect, useState } from "react";
import { api, type Company, type DetectResult, type Evaluation } from "../api.ts";

/**
 * The companies whose boards the app polls.
 *
 * Adding one used to mean knowing its applicant tracking system and its board
 * token, neither of which is on a careers page. Here you type the name and the
 * app works both out, so the thing you have to know is the thing you actually
 * know.
 *
 * It also reads a board before you commit to it. No ATS offers a search across
 * every company, so a name has to come from somewhere — you, or the assistant
 * suggesting one. Either way it is a guess until the board is read. Checking
 * first turns that guess into a count of postings that match, and a company
 * hiring for nothing you want is then a cheap answer rather than a sync, a
 * thousand stored postings and a list to clean up later.
 */
export function Boards({
  place,
  includeRemote,
  onChanged,
}: {
  /** The city filter from the Jobs tab, so a check counts the same postings. */
  place: string | undefined;
  includeRemote: boolean;
  onChanged: () => void;
}) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"check" | "add" | null>(null);
  const [result, setResult] = useState<DetectResult | null>(null);
  const [checked, setChecked] = useState<Evaluation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<
    { company: Company; total: number; tracked: number } | null
  >(null);
  const [gone, setGone] = useState<string | null>(null);

  const load = () => void api.companies().then(setCompanies);
  useEffect(load, []);

  const names = () =>
    draft
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

  async function run(what: "check" | "add", list?: string[]) {
    const wanted = list ?? names();
    if (wanted.length === 0) return;

    setBusy(what);
    setError(null);
    try {
      if (what === "check") {
        setResult(null);
        setChecked(await api.evaluateCompanies(wanted, place, includeRemote));
      } else {
        setResult(await api.detectCompanies(wanted, true));
        setChecked(null);
        setDraft("");
        load();
        onChanged();
      }
    } catch (runError) {
      setError((runError as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function unfollow(company: Company, withPostings: boolean) {
    setLeaving(null);
    const report = await api.deleteCompany(company.id, withPostings);
    setGone(
      `${company.name} removed. ${report.deleted} postings deleted` +
        (report.kept > 0 ? `, ${report.kept} kept.` : "."),
    );
    load();
    onChanged();
  }

  const added = result?.results.filter((row) => row.found) ?? [];
  const worthwhile = (checked ?? []).filter((row) => row.matching > 0 && !row.already_followed);

  return (
    <div className="profile">
      <h3>Add companies</h3>
      <form onSubmit={(event) => void (event.preventDefault(), run("check"))}>
        <input
          value={draft}
          disabled={busy !== null}
          placeholder="Figma, Notion, Datadog…"
          title="Company names, separated by commas. The board is worked out for you."
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="row-actions">
          <button type="submit" disabled={busy !== null}>
            Check their boards
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy !== null}
            onClick={() => void run("add")}
          >
            Follow without checking
          </button>
        </div>
        <p className="fine">
          A check reads each board and counts the postings that match what you are looking for.
          Nothing is stored until you follow them.{" "}
          {place ? `Counting ${place}${includeRemote ? " and remote" : ""}.` : "Counting everywhere."}
        </p>
      </form>

      {busy === "check" && <div className="hint">Reading their boards…</div>}
      {busy === "add" && <div className="hint">Looking for their boards…</div>}
      {error && <p className="error">{error}</p>}

      {checked && (
        <div>
          <h3>
            What they are hiring for
            {worthwhile.length > 0 && (
              <button
                className="ghost tiny"
                disabled={busy !== null}
                onClick={() => void run("add", worthwhile.map((row) => row.name))}
              >
                Follow the {worthwhile.length} with matches
              </button>
            )}
          </h3>
          {checked.map((row) => (
            <div className="row board-row" key={row.name}>
              <div className="row-main">
                <div className="row-title">
                  {row.name}
                  {row.already_followed && <span className="fine"> · already following</span>}
                </div>
                <div className="row-sub">
                  {row.error
                    ? row.error
                    : `${row.matching} of ${row.in_scope} matching · ${row.total} on the board · best ${row.best_score}`}
                </div>
                {row.top.slice(0, 3).map((hit) => (
                  <div className="row-sub" key={hit.url}>
                    <a href={hit.url} target="_blank" rel="noreferrer">
                      {hit.title}
                    </a>{" "}
                    · {hit.score}
                    {hit.location ? ` · ${hit.location}` : ""}
                  </div>
                ))}
              </div>
              {!row.already_followed && row.ats && (
                <button
                  className="ghost tiny"
                  disabled={busy !== null}
                  title={`Follow ${row.name}`}
                  onClick={() => void run("add", [row.name])}
                >
                  Follow
                </button>
              )}
            </div>
          ))}
        </div>
      )}

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

      {gone && <div className="hint">{gone}</div>}

      {leaving && (
        <div className="hint">
          <b>Stop following {leaving.company.name}?</b>
          <p className="fine">
            {leaving.total === 0
              ? "Nothing has been fetched from this board yet."
              : `${leaving.total} postings were fetched from this board. Kept, they stay in your
                 list and keep their place in the order, but nothing will ever refresh them
                 again.`}
            {leaving.tracked > 0 &&
              ` ${leaving.tracked} ${leaving.tracked === 1 ? "is one you are" : "are ones you are"}
               pursuing or have drafted for. Those are kept either way.`}
          </p>
          <div className="row-actions">
            {leaving.total > leaving.tracked && (
              <button onClick={() => void unfollow(leaving.company, true)}>
                Remove the board and {leaving.total - leaving.tracked} postings
              </button>
            )}
            <button className="ghost" onClick={() => void unfollow(leaving.company, false)}>
              Remove the board only
            </button>
            <button className="ghost" onClick={() => setLeaving(null)}>
              Cancel
            </button>
          </div>
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
                onClick={() =>
                  void api
                    .companyPostings(company.id)
                    .then((count) => setLeaving({ company, ...count }))
                }
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

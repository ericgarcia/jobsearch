import { useEffect, useState } from "react";
import { api, type Interests as InterestsData } from "../api.ts";

/**
 * What the person wants next.
 *
 * Ranking used to read the profile alone, which is a record of the past. That
 * measures anyone changing direction against the work they are leaving: it put
 * roles from a former employer at the top because the history said so. These
 * terms are chosen rather than inferred, so they carry more weight.
 */

function Chips({
  label,
  hint,
  values,
  onChange,
}: {
  label: string;
  hint: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const term = draft.trim();
    if (term && !values.includes(term)) onChange([...values, term]);
    setDraft("");
  };

  return (
    <div className="interest-group">
      <label>
        <span>{label}</span>
        <input
          value={draft}
          placeholder="Type and press Enter"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={add}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
      </label>
      <p className="fine">{hint}</p>
      <div className="chips">
        {values.map((value) => (
          <span className="chip" key={value}>
            {value}
            <button
              className="ghost tiny"
              title={`Remove ${value}`}
              onClick={() => onChange(values.filter((other) => other !== value))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Interests({ onChanged }: { onChanged?: () => void }) {
  const [data, setData] = useState<InterestsData | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => void api.interests().then(setData), []);

  if (!data) return null;

  const save = (patch: Partial<InterestsData>) => {
    setData({ ...data, ...patch });
    void api.saveInterests(patch).then((next) => {
      setData(next);
      setSaved(true);
      onChanged?.();
    });
  };

  const empty = data.titles.length === 0 && data.include.length === 0;

  return (
    <div>
      <h3>What you are looking for</h3>
      {empty ? (
        <div className="hint">
          Nothing here yet, so postings are ranked against your history alone. Say what you want
          next and it will outweigh what you have already done.
        </div>
      ) : (
        <p className="fine">
          These outweigh the terms read from your experience. Re-rank from the Jobs tab for a
          change to reach the stored postings.
        </p>
      )}

      <Chips
        label="Titles"
        hint="The roles you want. Every word in a title counts heavily."
        values={data.titles}
        onChange={(titles) => save({ titles })}
      />
      <Chips
        label="Seek out"
        hint="Subjects and technologies you want to work on."
        values={data.include}
        onChange={(include) => save({ include })}
      />
      <Chips
        label="Avoid"
        hint="A posting about one of these is pushed to the bottom."
        values={data.exclude}
        onChange={(exclude) => save({ exclude })}
      />

      <label>
        <span>Anything else</span>
        <textarea
          rows={3}
          defaultValue={data.note ?? ""}
          placeholder="Team size, stage, what you would rather not repeat…"
          onBlur={(event) => {
            if (event.target.value !== (data.note ?? "")) save({ note: event.target.value });
          }}
        />
      </label>

      {saved && <p className="fine">Saved. Re-rank for it to take effect on stored postings.</p>}
    </div>
  );
}

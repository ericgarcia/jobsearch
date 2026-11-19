import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useChanges } from "../changes.ts";

/**
 * How far through the questions they are, at the top of the thread.
 *
 * The assistant used to say it in prose — "you have answered 15 so far and 45
 * are left" — which is a sentence that scrolls away, so the only way to know
 * where you were was to ask. Filling in a profile is long and nobody does it
 * in one sitting, so the one thing worth keeping on the screen is how much of
 * it is behind you.
 *
 * It is not a loading bar: the total grows. Answering a question can turn up
 * another worth asking, and the queue refills from the profile's own gaps
 * when it empties. So this counts what is done out of what is known about
 * now, and says the two numbers plainly beside it rather than a percentage
 * that can go backwards on its own.
 */
export function Progress() {
  const [counts, setCounts] = useState<{ left: number; settled: number } | null>(null);

  const load = () =>
    void api
      .questionProgress()
      .then(setCounts)
      .catch(() => setCounts(null));

  useEffect(load, []);
  /* Both: a question settles on "profile", and a new one arrives on "focus". */
  useChanges(["profile", "focus"], load);

  if (!counts) return null;
  const { left, settled } = counts;
  const total = left + settled;
  /* Nothing asked and nothing waiting is not a thing to show a bar for. */
  if (total === 0) return null;

  const done = Math.round((settled / total) * 100);

  return (
    <div className="progress" title={`${settled} answered, ${left} still to go`}>
      <div className="progress-track">
        <div className="progress-done" style={{ width: `${done}%` }} />
      </div>
      <span className="progress-count">
        {left === 0 ? (
          <>All {total} answered</>
        ) : (
          <>
            {settled} of {total} answered
          </>
        )}
      </span>
    </div>
  );
}

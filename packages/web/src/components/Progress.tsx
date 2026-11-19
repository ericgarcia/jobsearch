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
 *
 * It is there while there are questions and not otherwise. See the note
 * below on the empty queue.
 */
export function Progress({
  onContinue,
  busy,
}: {
  /**
   * Carry on with the questions. Given the thread that last asked, or null
   * when there is none left to go back to — see the note on resuming in
   * Chat, which is where the two cases are told apart.
   */
  onContinue: (asking: number | null) => void;
  /** A turn is running, so there is nothing to resume into. */
  busy: boolean;
}) {
  const [counts, setCounts] = useState<
    { left: number; settled: number; asking: number | null } | null
  >(null);

  const load = () =>
    void api
      .questionProgress()
      .then(setCounts)
      .catch(() => setCounts(null));

  useEffect(load, []);
  /* Both: a question settles on "profile", and a new one arrives on "focus". */
  useChanges(["profile", "focus"], load);

  if (!counts) return null;
  const { left, settled, asking } = counts;
  const total = left + settled;

  /*
    Nothing left to ask, nothing to show.

    It used to sit there full, saying "Profile up to date — all 31 answered",
    which is a bar reporting on itself: there is no work behind it, no button
    on it, and nothing it would move for. The top of the thread is the most
    expensive strip on the screen, and a finished bar holds it to say that it
    is finished. It comes back on its own when a question does — a new
    import, or the queue refilling from the profile's gaps — because the
    counts are reloaded whenever either changes.
  */
  if (left === 0) return null;

  const done = Math.round((settled / total) * 100);

  return (
    <div className="progress">
      <span className="progress-name">Updating profile</span>
      <div className="progress-track" title={`${settled} answered, ${left} still to go`}>
        <div className="progress-done" style={{ width: `${done}%` }} />
      </div>
      <span className="progress-count">
        {settled} of {total} answered
      </span>
      {left > 0 && (
        <button
          className="ghost tiny progress-continue"
          disabled={busy}
          onClick={() => onContinue(asking)}
          title="Carry on with these questions"
        >
          Continue
        </button>
      )}
    </div>
  );
}
